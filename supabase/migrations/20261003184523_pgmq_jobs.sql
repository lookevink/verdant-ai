create extension if not exists pgmq;

create function verdant.queue_name(p_namespace text,p_lane text) returns text
language plpgsql immutable set search_path='' as $$
begin
 if p_namespace is null or p_namespace !~ '^verdant:(sandbox:test|production:(test|live))(:smoke)?$'
   or p_lane is null or p_lane not in ('probe','data_request') then raise exception 'Invalid queue namespace/lane'; end if;
 return replace(p_namespace,':','_')||'_'||p_lane;
end $$;
-- Provision logged queues explicitly; application calls cannot create arbitrary queues.
do $$ declare ns text; lane text; begin
 foreach ns in array array['verdant:sandbox:test','verdant:production:test','verdant:production:live','verdant:sandbox:test:smoke','verdant:production:test:smoke'] loop
  foreach lane in array array['probe','data_request'] loop perform pgmq.create(verdant.queue_name(ns,lane)); end loop;
 end loop;
end $$;

create table verdant.jobs (
 namespace text not null,
 lane text not null check (lane in ('probe','data_request')),
 id text not null check (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
 payload jsonb not null check (octet_length(payload::text)<=32768),
 fingerprint text not null check (length(fingerprint) between 1 and 256),
 status text not null default 'queued' check (status in ('queued','running','completed','failed')),
 attempts integer not null default 0,
 max_attempts integer not null check (max_attempts between 1 and 10),
 message_id bigint,
 lease_token uuid,
 completed_lease_token uuid,
 lease_until timestamptz,
 result jsonb,
 error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(namespace,lane,id),
 check(namespace ~ '^verdant:(sandbox:test|production:(test|live))(:smoke)?$'),
 check(attempts between 0 and max_attempts),
 check((status='running')=(lease_token is not null and lease_until is not null))
);
alter table verdant.jobs enable row level security;
revoke all on verdant.jobs from public,anon,authenticated;
grant select,insert,update,delete on verdant.jobs to service_role;

create function verdant.job_json(j verdant.jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',j.id,'kind',j.lane,'payload',j.payload,'status',j.status,
 'attempts',j.attempts,'maxAttempts',j.max_attempts,'createdAt',extract(epoch from j.created_at)*1000,
 'result',j.result,'error',j.error);
$$;
-- Short per-lane transaction locks keep pgmq/message and ledger lock order consistent.
-- This demo has one worker; each lock is released before returning over HTTP.
create function public.verdant_enqueue(p_namespace text,p_lane text,p_id text,p_payload jsonb,p_fingerprint text,p_max_attempts integer default 3) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,p_lane); j verdant.jobs; mid bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,p_lane,p_id);
 if found then
  if j.fingerprint<>p_fingerprint or j.payload<>p_payload or j.max_attempts<>p_max_attempts then raise exception 'Job idempotency conflict'; end if;
  return verdant.job_json(j);
 end if;
 insert into verdant.jobs(namespace,lane,id,payload,fingerprint,max_attempts)
 values(p_namespace,p_lane,p_id,p_payload,p_fingerprint,p_max_attempts);
 select pgmq.send(q,jsonb_build_object('id',p_id)) into mid;
 update verdant.jobs set message_id=mid where (namespace,lane,id)=(p_namespace,p_lane,p_id) returning * into j;
 return verdant.job_json(j);
end $$;
create function public.verdant_get_job(p_namespace text,p_lane text,p_id text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select verdant.job_json(j) from verdant.jobs j where (namespace,lane,id)=(p_namespace,p_lane,p_id);
$$;
create function public.verdant_claim(p_namespace text,p_lane text,p_lease_seconds integer default 60) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,p_lane); m record; j verdant.jobs;
begin
 if p_lease_seconds is null or p_lease_seconds not between 1 and 900 then raise exception 'Invalid lease duration'; end if;
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 for i in 1..25 loop
  select * into m from pgmq.read(q,p_lease_seconds,1);
  if not found then return null; end if;
  select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,p_lane,m.message->>'id') for update;
  if not found then perform pgmq.archive(q,m.msg_id); continue; end if;
  if j.status in ('completed','failed') then perform pgmq.archive(q,m.msg_id); continue; end if;
  if j.attempts>=j.max_attempts then
   update verdant.jobs set status='failed',error='Retry budget exhausted',lease_token=null,lease_until=null,updated_at=now()
   where (namespace,lane,id)=(p_namespace,p_lane,j.id);
   if p_lane='data_request' then
    update verdant.data_requests set status='failed',error='{"reason":"Retry budget exhausted"}',updated_at=now()
    where environment=split_part(p_namespace,':',2) and id::text=j.id and status not in ('ready','cancelled');
   end if;
   perform pgmq.archive(q,m.msg_id); continue;
  end if;
  update verdant.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=m.vt,updated_at=now()
   where (namespace,lane,id)=(p_namespace,p_lane,j.id) returning * into j;
  return jsonb_build_object('job',verdant.job_json(j),'leaseToken',j.lease_token);
 end loop;
 return null;
end $$;
create function public.verdant_finish(p_namespace text,p_lane text,p_id text,p_lease_token uuid,p_success boolean,p_result jsonb default null,p_error text default null,p_retry_seconds integer default 5) returns boolean
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,p_lane); j verdant.jobs; terminal boolean;
begin
 if p_retry_seconds is null or p_retry_seconds not between 0 and 86400 or p_success is null then raise exception 'Invalid completion options'; end if;
 if octet_length(p_result::text)>32768 then raise exception 'Result too large; store artifact references'; end if;
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,p_lane,p_id) for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 if p_success and p_lane='data_request' and not exists(select 1 from verdant.data_requests r
   join verdant.artifacts a on (a.environment,a.request_id)=(r.environment,r.id)
   where r.environment=split_part(p_namespace,':',2) and r.id::text=p_id and r.status='ready') then
   raise exception 'Data request must be published with an artifact before completion';
 end if;
 terminal:=p_success or j.attempts>=j.max_attempts;
 if terminal then perform pgmq.archive(q,j.message_id);
 else perform pgmq.set_vt(q,j.message_id,p_retry_seconds); end if;
 update verdant.jobs set status=case when p_success then 'completed' when terminal then 'failed' else 'queued' end,
 completed_lease_token=case when p_success then p_lease_token else null end,
 result=case when p_success then p_result else null end,error=case when p_success then null else left(p_error,300) end,
 lease_token=null,lease_until=null,updated_at=now() where (namespace,lane,id)=(p_namespace,p_lane,p_id);
 if p_lane='data_request' and not p_success and terminal then
  update verdant.data_requests set status='failed',error=jsonb_build_object('reason',left(p_error,300)),updated_at=now()
  where environment=split_part(p_namespace,':',2) and id::text=p_id and status not in ('ready','cancelled');
 end if;
 return true;
end $$;
create function public.verdant_renew(p_namespace text,p_lane text,p_id text,p_lease_token uuid,p_lease_seconds integer default 60) returns boolean
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,p_lane); j verdant.jobs; expiry timestamptz;
begin
 if p_lease_seconds is null or p_lease_seconds not between 1 and 900 then raise exception 'Invalid lease duration'; end if;
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,p_lane,p_id) for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 select vt into expiry from pgmq.set_vt(q,j.message_id,p_lease_seconds);
 update verdant.jobs set lease_until=expiry,updated_at=now() where (namespace,lane,id)=(p_namespace,p_lane,p_id);
 return expiry is not null;
end $$;
create function public.verdant_queue_health(p_namespace text,p_lane text default 'probe') returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('pgmq',exists(select 1 from pgmq.meta where queue_name=verdant.queue_name(p_namespace,p_lane)), 'namespace',p_namespace);
$$;

-- Receipt persistence + diagnostic enqueue are one DB transaction. External settlement
-- still requires provider reconciliation if the process crashes before this call.
create function public.verdant_probe_receipt(p_namespace text,p_credential_hash text) returns text
language sql stable security invoker set search_path='' as $$
 select receipt from verdant.payment_operations where environment=split_part(p_namespace,':',2)
 and payment_mode=split_part(p_namespace,':',3) and credential_hash=p_credential_hash;
$$;
create function public.verdant_record_probe(p_namespace text,p_credential_hash text,p_provider text,p_reference text,p_receipt text,p_job_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare old verdant.payment_operations; env text:=split_part(p_namespace,':',2);
begin
 perform verdant.queue_name(p_namespace,'probe');
 if split_part(p_namespace,':',3)<>'test' then raise exception 'Probe requires test payment mode'; end if;
 insert into verdant.payment_operations(environment,payment_mode,provider,reference,credential_hash,request_digest,amount_minor,currency,status,receipt)
 values(env,'test',p_provider,p_reference,p_credential_hash,p_job_id,50,'usd','verified',p_receipt)
 on conflict (environment,payment_mode,credential_hash) do nothing;
 select * into old from verdant.payment_operations where environment=env and payment_mode='test' and credential_hash=p_credential_hash;
 if old.provider<>p_provider or old.reference<>p_reference or old.request_digest<>p_job_id then raise exception 'Receipt conflict'; end if;
 return public.verdant_enqueue(p_namespace,'probe',p_job_id,'{"purpose":"mpp-sandbox-verification"}',p_job_id,3);
end $$;

-- Called only by the API after it verifies provider settlement against the frozen quote.
-- Quote, payment, entitlement and pgmq insertion commit or roll back together.
create function public.verdant_submit_request(p_environment text,p_quote_id uuid,p_requester_hash text,p_access_token_hash text,
 p_idempotency_key text,p_provider text,p_reference text,p_credential_hash text,p_receipt text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare q verdant.data_quotes; r verdant.data_requests; pay uuid; rid uuid:=gen_random_uuid();
begin
 select * into q from verdant.data_quotes where environment=p_environment and id=p_quote_id for update;
 if not found or q.requester_hash<>p_requester_hash then raise exception 'Quote not found'; end if;
 select * into r from verdant.data_requests where environment=p_environment and requester_hash=p_requester_hash and idempotency_key=p_idempotency_key;
 if found then
  if r.quote_id<>p_quote_id then raise exception 'Idempotency conflict'; end if;
  return r.id;
 end if;
 if q.expires_at<=clock_timestamp() then raise exception 'Quote expired'; end if;
 insert into verdant.payment_operations(environment,payment_mode,provider,reference,credential_hash,request_digest,amount_minor,currency,status,receipt)
 values(p_environment,q.payment_mode,p_provider,p_reference,p_credential_hash,q.request_digest,q.amount_minor,q.currency,'verified',p_receipt) returning id into pay;
 insert into verdant.data_requests(environment,id,quote_id,payment_operation_id,requester_hash,access_token_hash,idempotency_key)
 values(p_environment,rid,p_quote_id,pay,p_requester_hash,p_access_token_hash,p_idempotency_key);
 insert into verdant.request_events(environment,request_id,event) values(p_environment,rid,'queued');
 perform public.verdant_enqueue('verdant:'||p_environment||':'||q.payment_mode,'data_request',rid::text,jsonb_build_object('requestId',rid),q.request_digest,3);
 return rid;
end $$;

-- All wrappers are invoker functions: only trusted server credentials get access.
revoke all on schema pgmq from public,anon,authenticated;
revoke all on all tables in schema pgmq from public,anon,authenticated;
revoke all on all functions in schema pgmq from public,anon,authenticated;
grant usage on schema pgmq to service_role;
grant select,insert,update,delete on all tables in schema pgmq to service_role;
grant usage,select on all sequences in schema pgmq to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='pgmq'::regnamespace and proname in ('send','read','archive','set_vt','format_table_name','validate_queue_name') loop
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
grant execute on all functions in schema verdant to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
