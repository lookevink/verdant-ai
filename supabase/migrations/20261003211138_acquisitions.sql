-- Cache-miss acquisition: a request for missing public-source data becomes one deduplicated,
-- lease-fenced pgmq job. The worker publishes a content-addressed demo dataset version that
-- every later compatible query reuses. Payment is not involved; callers are authorized by the API.

create or replace function verdant.queue_name(p_namespace text,p_lane text) returns text
language plpgsql immutable set search_path='' as $$
begin
 if p_namespace is null or p_namespace !~ '^verdant:(sandbox:test|production:(test|live))(:smoke)?$'
   or p_lane is null or p_lane not in ('probe','data_request','acquisition') then raise exception 'Invalid queue namespace/lane'; end if;
 return replace(p_namespace,':','_')||'_'||p_lane;
end $$;
do $$ declare ns text; begin
 foreach ns in array array['verdant:sandbox:test','verdant:production:test','verdant:production:live','verdant:sandbox:test:smoke','verdant:production:test:smoke'] loop
  perform pgmq.create(verdant.queue_name(ns,'acquisition'));
 end loop;
end $$;
alter table verdant.jobs drop constraint jobs_lane_check;
alter table verdant.jobs add constraint jobs_lane_check check (lane in ('probe','data_request','acquisition'));

create table verdant.acquisitions (
 environment verdant.environment not null,
 id uuid not null default gen_random_uuid(),
 -- SHA-256 of the canonical acquisition target (source, variable, period, grid window, transform).
 coverage_digest verdant.sha256 not null,
 target jsonb not null check (jsonb_typeof(target)='object' and octet_length(target::text)<=8192),
 request jsonb not null check (jsonb_typeof(request)='object' and octet_length(request::text)<=16384),
 requester_hash verdant.sha256,
 status text not null default 'queued' check (status in ('queued','acquiring','normalizing','validating','publishing','ready','failed')),
 dataset_version_id text,
 error jsonb check (error is null or jsonb_typeof(error)='object'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (environment,id),
 foreign key (environment,dataset_version_id) references verdant.dataset_versions(environment,id),
 check ((status='ready')=(dataset_version_id is not null)),
 check ((status='failed')=(error is not null))
);
-- At most one live acquisition per target. Failed targets may be retried by a later request.
create unique index acquisition_active on verdant.acquisitions(environment,coverage_digest) where status<>'failed';
create index acquisition_history on verdant.acquisitions(environment,coverage_digest,created_at desc);
create index acquisition_dataset on verdant.acquisitions(environment,dataset_version_id);
create table verdant.acquisition_events (
 environment verdant.environment not null,
 acquisition_id uuid not null,
 id bigint generated always as identity,
 event text not null check (event ~ '^[a-z][a-z0-9_]{0,63}$'),
 details jsonb not null default '{}' check (jsonb_typeof(details)='object' and octet_length(details::text)<=8192),
 created_at timestamptz not null default now(),
 primary key (environment,acquisition_id,id),
 foreign key (environment,acquisition_id) references verdant.acquisitions(environment,id)
);
alter table verdant.acquisitions enable row level security;
alter table verdant.acquisition_events enable row level security;
revoke all on verdant.acquisitions,verdant.acquisition_events from public,anon,authenticated;
grant select,insert,update,delete on verdant.acquisitions,verdant.acquisition_events to service_role;
grant usage,select on all sequences in schema verdant to service_role;

create function verdant.acquisition_json(a verdant.acquisitions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',a.id,'status',a.status,'coverageDigest',a.coverage_digest,'target',a.target,'request',a.request,
 'datasetVersion',a.dataset_version_id,'error',a.error,'createdAt',a.created_at,'updatedAt',a.updated_at);
$$;
create function verdant.acquisition_failed(p_namespace text,p_id text,p_reason text) returns void
language sql set search_path='' as $$
 with failed as (
  update verdant.acquisitions set status='failed',error=jsonb_build_object('reason',left(p_reason,300)),updated_at=now()
  where environment=split_part(p_namespace,':',2) and id::text=p_id and status not in ('ready','failed') returning environment,id)
 insert into verdant.acquisition_events(environment,acquisition_id,event,details)
 select environment,id,'failed',jsonb_build_object('reason',left(p_reason,300)) from failed;
$$;

-- The queue functions below are the 20261003184523 definitions plus acquisition-lane bookkeeping.
create or replace function public.verdant_claim(p_namespace text,p_lane text,p_lease_seconds integer default 60) returns jsonb
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
   elsif p_lane='acquisition' then
    perform verdant.acquisition_failed(p_namespace,j.id,'Retry budget exhausted');
   end if;
   perform pgmq.archive(q,m.msg_id); continue;
  end if;
  update verdant.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=m.vt,updated_at=now()
   where (namespace,lane,id)=(p_namespace,p_lane,j.id) returning * into j;
  return jsonb_build_object('job',verdant.job_json(j),'leaseToken',j.lease_token);
 end loop;
 return null;
end $$;
create or replace function public.verdant_finish(p_namespace text,p_lane text,p_id text,p_lease_token uuid,p_success boolean,p_result jsonb default null,p_error text default null,p_retry_seconds integer default 5) returns boolean
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
 if p_success and p_lane='acquisition' and not exists(select 1 from verdant.acquisitions a
   where a.environment=split_part(p_namespace,':',2) and a.id::text=p_id and a.status='ready') then
   raise exception 'Acquisition must be published before completion';
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
 if p_lane='acquisition' and not p_success then
  if terminal then perform verdant.acquisition_failed(p_namespace,p_id,p_error);
  else
   with retried as (
    update verdant.acquisitions set status='queued',updated_at=now()
    where environment=split_part(p_namespace,':',2) and id::text=p_id and status not in ('ready','failed') returning environment,id)
   insert into verdant.acquisition_events(environment,acquisition_id,event,details)
   select environment,id,'retry_scheduled',jsonb_build_object('reason',left(p_error,300),'attempt',j.attempts,'retrySeconds',p_retry_seconds) from retried;
  end if;
 end if;
 return true;
end $$;

-- API: one transaction finds a live or recently failed acquisition for this target, or records and enqueues a new one.
create function public.verdant_submit_acquisition(p_namespace text,p_coverage_digest text,p_target jsonb,p_request jsonb,
 p_requester_hash text default null,p_retry_cooldown_seconds integer default 900) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,'acquisition'); env text:=split_part(p_namespace,':',2); a verdant.acquisitions;
begin
 if p_retry_cooldown_seconds is null or p_retry_cooldown_seconds not between 0 and 86400 then raise exception 'Invalid retry cooldown'; end if;
 -- The same per-lane lock as enqueue/claim serializes concurrent submissions for one target.
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 select * into a from verdant.acquisitions where environment=env and coverage_digest=p_coverage_digest and status<>'failed';
 if found then return verdant.acquisition_json(a)||'{"created":false}'; end if;
 select * into a from verdant.acquisitions where environment=env and coverage_digest=p_coverage_digest
  and updated_at>clock_timestamp()-make_interval(secs=>p_retry_cooldown_seconds) order by created_at desc limit 1;
 if found then return verdant.acquisition_json(a)||'{"created":false}'; end if;
 insert into verdant.acquisitions(environment,coverage_digest,target,request,requester_hash)
 values(env,p_coverage_digest,p_target,p_request,p_requester_hash) returning * into a;
 insert into verdant.acquisition_events(environment,acquisition_id,event) values(env,a.id,'queued');
 perform public.verdant_enqueue(p_namespace,'acquisition',a.id::text,jsonb_build_object('acquisitionId',a.id),p_coverage_digest,3);
 return verdant.acquisition_json(a)||'{"created":true}';
end $$;
create function public.verdant_get_acquisition(p_namespace text,p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select verdant.acquisition_json(a)||jsonb_build_object(
  'events',coalesce((select jsonb_agg(jsonb_build_object('event',e.event,'details',e.details,'at',e.created_at) order by e.id)
   from (select * from verdant.acquisition_events x where (x.environment,x.acquisition_id)=(a.environment,a.id) order by x.id desc limit 200) e),'[]'),
  'job',(select jsonb_build_object('status',j.status,'attempts',j.attempts,'maxAttempts',j.max_attempts)
   from verdant.jobs j where (j.namespace,j.lane,j.id)=(p_namespace,'acquisition',a.id::text)))
 from verdant.acquisitions a where a.environment=split_part(p_namespace,':',2) and a.id=p_id;
$$;

-- Worker: lease-fenced stage changes and sanitized events. A reclaimed job restarts at acquiring.
create function public.verdant_acquisition_progress(p_namespace text,p_id uuid,p_lease_token uuid,p_event text,p_status text default null,p_details jsonb default '{}') returns boolean
language plpgsql security invoker set search_path='' as $$
declare j verdant.jobs; a verdant.acquisitions; env text:=split_part(p_namespace,':',2);
 stages text[]:=array['queued','acquiring','normalizing','validating','publishing'];
begin
 perform pg_advisory_xact_lock(hashtextextended(verdant.queue_name(p_namespace,'acquisition'),0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,'acquisition',p_id::text) for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 select * into a from verdant.acquisitions where environment=env and id=p_id for update;
 if not found or a.status in ('ready','failed') then return false; end if;
 if p_event is null or p_event !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'Invalid event'; end if;
 if p_status is not null then
  if p_status not in ('acquiring','normalizing','validating','publishing') then raise exception 'Invalid processing state'; end if;
  if p_status<>'acquiring' and array_position(stages,p_status)<array_position(stages,a.status) then raise exception 'Invalid state transition'; end if;
  update verdant.acquisitions set status=p_status,updated_at=now() where environment=env and id=p_id;
 end if;
 insert into verdant.acquisition_events(environment,acquisition_id,event,details) values(env,p_id,p_event,coalesce(p_details,'{}'));
 return true;
end $$;
-- Worker: a failure that retrying cannot fix (source lacks the data, source format changed) ends the job now.
create function public.verdant_abandon_acquisition(p_namespace text,p_id uuid,p_lease_token uuid,p_reason text) returns boolean
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(verdant.queue_name(p_namespace,'acquisition'),0));
 update verdant.jobs set attempts=max_attempts,updated_at=now()
 where (namespace,lane,id)=(p_namespace,'acquisition',p_id::text) and status='running' and lease_token=p_lease_token and lease_until>clock_timestamp();
 if not found then return false; end if;
 return public.verdant_finish(p_namespace,'acquisition',p_id::text,p_lease_token,false,null,p_reason,0);
end $$;
-- Worker: insert a validated content-addressed version and its tiles, publish it, mark the acquisition
-- ready and acknowledge pgmq in one transaction. An identical earlier version is reused, never rewritten.
create function public.verdant_publish_acquisition(p_namespace text,p_id uuid,p_lease_token uuid,p_dataset jsonb,p_tiles jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j verdant.jobs; a verdant.acquisitions; env text:=split_part(p_namespace,':',2); d verdant.dataset_versions; existing verdant.dataset_versions; reused boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended(verdant.queue_name(p_namespace,'acquisition'),0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,'acquisition',p_id::text) for update;
 if found and j.status='completed' and j.completed_lease_token=p_lease_token then
  -- The previous identical call committed but its response was lost.
  if exists(select 1 from verdant.acquisitions where environment=env and id=p_id and status='ready' and dataset_version_id=p_dataset->>'id') then return true; end if;
  raise exception 'Publication replay conflict';
 end if;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 select * into a from verdant.acquisitions where environment=env and id=p_id for update;
 if not found or a.status<>'publishing' then raise exception 'Acquisition is not ready for publication'; end if;
 if jsonb_typeof(p_tiles) is distinct from 'array' or jsonb_array_length(p_tiles)=0 then raise exception 'Tiles are required'; end if;
 d:=jsonb_populate_record(null::verdant.dataset_versions,p_dataset);
 if d.dataset_key is null or d.dataset_key !~ '^silo-' or d.data_class is distinct from 'interpolated_observation' or d.bbox is null then
  raise exception 'Unsupported acquired dataset'; end if;
 select * into existing from verdant.dataset_versions where environment=env and id=d.id;
 if found then
  if existing.status<>'published' or existing.content_sha256<>d.content_sha256 or existing.transform_version<>d.transform_version
   or existing.dataset_key<>d.dataset_key then raise exception 'Dataset version conflict'; end if;
  reused:=true;
 else
  insert into verdant.dataset_versions(environment,id,dataset_key,title,content_sha256,source_manifest,transform_version,data_class,variables,
   temporal_resolution,spatial_support,bbox,period_start,period_end,license,attribution,access_level,status,metadata)
  values(env,d.id,d.dataset_key,d.title,d.content_sha256,d.source_manifest,d.transform_version,d.data_class,d.variables,
   d.temporal_resolution,d.spatial_support,d.bbox,d.period_start,d.period_end,d.license,d.attribution,'demo','staging',d.metadata);
  insert into verdant.raster_tiles(environment,dataset_version_id,id,variable,unit,observed_on,width,height,crs,transform,bbox,cells,source_window)
  select env,d.id,t.id,t.variable,t.unit,t.observed_on,t.width,t.height,t.crs,t.transform,t.bbox,t.cells,t.source_window
  from jsonb_populate_recordset(null::verdant.raster_tiles,p_tiles) t;
  -- Exactly one tile per day of the declared period, each inside the declared bounds.
  if (select count(*)<>(d.period_end-d.period_start+1) or count(distinct observed_on)<>count(*)
     or bool_or(observed_on not between d.period_start and d.period_end
      or bbox[1]<d.bbox[1] or bbox[2]<d.bbox[2] or bbox[3]>d.bbox[3] or bbox[4]>d.bbox[4])
     from verdant.raster_tiles where environment=env and dataset_version_id=d.id) then
   raise exception 'Tiles do not cover the declared period and bounds';
  end if;
  update verdant.dataset_versions set status='published',published_at=now() where environment=env and id=d.id;
 end if;
 update verdant.acquisitions set status='ready',dataset_version_id=d.id,updated_at=now() where environment=env and id=p_id;
 insert into verdant.acquisition_events(environment,acquisition_id,event,details)
 values(env,p_id,'ready',jsonb_build_object('datasetVersion',d.id,'reusedExistingVersion',reused));
 if not public.verdant_finish(p_namespace,'acquisition',p_id::text,p_lease_token,true,jsonb_build_object('datasetVersion',d.id)) then
  raise exception 'Lease expired during publication';
 end if;
 return true;
end $$;

-- Newly created pgmq tables and functions follow the same service-only grants.
revoke all on all tables in schema pgmq from public,anon,authenticated;
grant select,insert,update,delete on all tables in schema pgmq to service_role;
grant usage,select on all sequences in schema pgmq to service_role;
revoke all on all functions in schema verdant from public,anon,authenticated;
grant execute on all functions in schema verdant to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
