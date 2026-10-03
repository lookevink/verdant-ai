-- Playground: natural-language research sessions. While a worker holds a session's lease it serves the
-- conversation with its own Pi process; every message, tool step, artifact and reply is appended to an
-- event log that the browser reads by sequence number. Session bearer tokens are stored only as SHA-256.
-- Delivery is at least once: a user message counts as consumed only when its turn finishes, so a
-- crashed worker's turn is replayed by the next claim.
create function verdant.playground_env(p_namespace text) returns text
language plpgsql immutable set search_path='' as $$
begin
 if p_namespace is null or p_namespace !~ '^verdant:(sandbox:test|production:(test|live))(:smoke)?$' then raise exception 'Invalid namespace'; end if;
 return split_part(p_namespace,':',2);
end $$;

create table verdant.playground_sessions (
 environment text not null check (environment in ('sandbox','production')),
 id uuid not null,
 token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
 client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
 status text not null default 'idle' check (status in ('idle','queued','running','closed')),
 last_seq bigint not null default 0,
 last_user_seq bigint not null default 0,
 consumed_seq bigint not null default 0,
 turns integer not null default 0,
 cancel_requested boolean not null default false,
 lease_token uuid,
 lease_until timestamptz,
 worker text check (length(worker)<=128),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(environment,id),
 check(consumed_seq<=last_user_seq and last_user_seq<=last_seq),
 check((status='running')=(lease_token is not null and lease_until is not null))
);
create index playground_sessions_claim on verdant.playground_sessions(environment,status,updated_at);
create index playground_sessions_client on verdant.playground_sessions(environment,client_hash,created_at);
create table verdant.playground_events (
 environment text not null,
 session_id uuid not null,
 seq bigint not null check (seq>0),
 kind text not null check (kind ~ '^[a-z_]{1,40}$'),
 data jsonb not null default '{}' check (octet_length(data::text)<=2097152),
 created_at timestamptz not null default now(),
 primary key(environment,session_id,seq),
 foreign key(environment,session_id) references verdant.playground_sessions(environment,id) on delete cascade
);
alter table verdant.playground_sessions enable row level security;
alter table verdant.playground_events enable row level security;
revoke all on verdant.playground_sessions,verdant.playground_events from public,anon,authenticated;
grant select,insert,update,delete on verdant.playground_sessions,verdant.playground_events to service_role;

create function verdant.playground_json(s verdant.playground_sessions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'status',s.status,'turns',s.turns,'lastSeq',s.last_seq,
  'createdAt',s.created_at,'updatedAt',s.updated_at);
$$;
/** Appends events in order under the caller's row lock and returns the new last sequence number. */
create function verdant.playground_append(s inout verdant.playground_sessions,p_events jsonb)
language plpgsql set search_path='' as $$
declare e jsonb;
begin
 if p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>500 then raise exception 'Invalid events'; end if;
 for e in select value from jsonb_array_elements(p_events) loop
  if e->>'kind' is null or e->>'kind'='user_message' then raise exception 'Invalid event kind'; end if;
  s.last_seq:=s.last_seq+1;
  insert into verdant.playground_events(environment,session_id,seq,kind,data)
  values(s.environment,s.id,s.last_seq,e->>'kind',coalesce(e->'data','{}'));
 end loop;
end $$;
create function verdant.playground_messages(s verdant.playground_sessions,p_after bigint) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('seq',e.seq,'text',e.data->>'text','source',e.data->>'source') order by e.seq),'[]')
 from verdant.playground_events e where (e.environment,e.session_id)=(s.environment,s.id) and e.kind='user_message' and e.seq>p_after;
$$;

-- Browser-facing calls (through the API). Each one requires the session token hash.
create function public.verdant_playground_create(p_namespace text,p_id uuid,p_token_hash text,p_client_hash text,p_daily_limit integer default 30) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions;
begin
 perform pg_advisory_xact_lock(hashtextextended('playground:'||env||':'||p_client_hash,0));
 if (select count(*) from verdant.playground_sessions where environment=env and client_hash=p_client_hash
   and created_at>now()-interval '1 day')>=p_daily_limit then return jsonb_build_object('error','session_limit_reached'); end if;
 insert into verdant.playground_sessions(environment,id,token_hash,client_hash) values(env,p_id,p_token_hash,p_client_hash) returning * into s;
 return verdant.playground_json(s);
end $$;
create function public.verdant_playground_send(p_namespace text,p_id uuid,p_token_hash text,p_text text,p_source text default 'text',p_max_turns integer default 20) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions;
begin
 select * into s from verdant.playground_sessions where (environment,id)=(env,p_id) and token_hash=p_token_hash for update;
 if not found then return null; end if;
 -- Expected refusals are returned, not raised: RPC errors reach the API only as an opaque status.
 if s.status='closed' then return jsonb_build_object('error','session_closed'); end if;
 if s.turns>=p_max_turns then return jsonb_build_object('error','turn_limit_reached'); end if;
 if p_text is null or length(btrim(p_text)) not between 1 and 4000 or p_source not in ('text','voice') then raise exception 'Invalid message'; end if;
 s.last_seq:=s.last_seq+1;
 insert into verdant.playground_events(environment,session_id,seq,kind,data)
 values(env,p_id,s.last_seq,'user_message',jsonb_build_object('text',btrim(p_text),'source',p_source));
 update verdant.playground_sessions set last_seq=s.last_seq,last_user_seq=s.last_seq,turns=turns+1,
  status=case when status='idle' then 'queued' else status end,updated_at=now()
 where (environment,id)=(env,p_id) returning * into s;
 return verdant.playground_json(s)||jsonb_build_object('seq',s.last_user_seq);
end $$;
create function public.verdant_playground_events(p_namespace text,p_id uuid,p_token_hash text,p_after bigint default 0,p_limit integer default 200) returns jsonb
language sql stable security invoker set search_path='' as $$
 select verdant.playground_json(s)||jsonb_build_object('events',coalesce((select jsonb_agg(jsonb_build_object('seq',e.seq,'kind',e.kind,'data',e.data,'at',e.created_at) order by e.seq)
  from (select * from verdant.playground_events e where (e.environment,e.session_id)=(s.environment,s.id) and e.seq>greatest(p_after,0)
   order by e.seq limit least(greatest(p_limit,1),500)) e),'[]'))
 from verdant.playground_sessions s where (s.environment,s.id)=(verdant.playground_env(p_namespace),p_id) and s.token_hash=p_token_hash;
$$;
/** Cancels the current turn. A queued turn is dropped here; a running one is stopped by its worker. */
create function public.verdant_playground_cancel(p_namespace text,p_id uuid,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions;
begin
 select * into s from verdant.playground_sessions where (environment,id)=(env,p_id) and token_hash=p_token_hash for update;
 if not found then return null; end if;
 if s.status='queued' then
  s:=verdant.playground_append(s,'[{"kind":"turn_cancelled","data":{"reason":"cancelled_before_start"}}]');
  update verdant.playground_sessions set status='idle',consumed_seq=last_user_seq,last_seq=s.last_seq,updated_at=now()
  where (environment,id)=(env,p_id) returning * into s;
 elsif s.status='running' then
  update verdant.playground_sessions set cancel_requested=true,updated_at=now() where (environment,id)=(env,p_id) returning * into s;
 end if;
 return verdant.playground_json(s);
end $$;

-- Worker calls. A lease fences every write; a stale worker gets ok=false and must stop its Pi process.
create function public.verdant_playground_claim(p_namespace text,p_worker text,p_lease_seconds integer default 60) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions;
begin
 if p_lease_seconds is null or p_lease_seconds not between 10 and 900 then raise exception 'Invalid lease duration'; end if;
 -- Expired leases with nothing left to answer simply become idle.
 update verdant.playground_sessions set status='idle',lease_token=null,lease_until=null,worker=null,updated_at=now()
 where environment=env and status='running' and lease_until<=clock_timestamp() and last_user_seq<=consumed_seq;
 select * into s from verdant.playground_sessions where environment=env and last_user_seq>consumed_seq
  and (status='queued' or (status='running' and lease_until<=clock_timestamp()))
 order by updated_at limit 1 for update skip locked;
 if not found then return null; end if;
 update verdant.playground_sessions set status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
  worker=p_worker,cancel_requested=false,updated_at=now() where (environment,id)=(env,s.id) returning * into s;
 return jsonb_build_object('session',verdant.playground_json(s),'leaseToken',s.lease_token,
  'messages',verdant.playground_messages(s,s.consumed_seq),
  -- Prior conversation, for a worker that has no local Pi session file to resume.
  'history',coalesce((select jsonb_agg(h.item order by h.seq) from (
   select e.seq,jsonb_build_object('role',case e.kind when 'user_message' then 'user' else 'assistant' end,'text',coalesce(e.data->>'text',e.data->>'reply')) item
   from verdant.playground_events e where (e.environment,e.session_id)=(env,s.id)
    and ((e.kind='user_message' and e.seq<=s.consumed_seq) or e.kind='turn_finished')
   order by e.seq desc limit 40) h),'[]'));
end $$;
create function public.verdant_playground_emit(p_namespace text,p_id uuid,p_lease_token uuid,p_events jsonb default '[]',
 p_seen_seq bigint default 0,p_done_seq bigint default null,p_lease_seconds integer default 60) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions; cancel boolean;
begin
 if p_lease_seconds is null or p_lease_seconds not between 10 and 900 then raise exception 'Invalid lease duration'; end if;
 select * into s from verdant.playground_sessions where (environment,id)=(env,p_id) for update;
 if not found or s.status<>'running' or s.lease_token is distinct from p_lease_token or s.lease_until<=clock_timestamp() then
  return jsonb_build_object('ok',false);
 end if;
 if p_done_seq is not null and p_done_seq>s.last_user_seq then raise exception 'Unknown message'; end if;
 cancel:=s.cancel_requested;
 s:=verdant.playground_append(s,p_events);
 update verdant.playground_sessions set last_seq=s.last_seq,consumed_seq=greatest(consumed_seq,coalesce(p_done_seq,0)),cancel_requested=false,
  lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=now()
 where (environment,id)=(env,p_id) returning * into s;
 return jsonb_build_object('ok',true,'cancel',cancel,'messages',verdant.playground_messages(s,greatest(p_seen_seq,s.consumed_seq)));
end $$;
create function public.verdant_playground_release(p_namespace text,p_id uuid,p_lease_token uuid,p_events jsonb default '[]') returns boolean
language plpgsql security invoker set search_path='' as $$
declare env text:=verdant.playground_env(p_namespace); s verdant.playground_sessions;
begin
 select * into s from verdant.playground_sessions where (environment,id)=(env,p_id) for update;
 if not found or s.status<>'running' or s.lease_token is distinct from p_lease_token then return false; end if;
 s:=verdant.playground_append(s,p_events);
 update verdant.playground_sessions set last_seq=s.last_seq,status=case when last_user_seq>consumed_seq then 'queued' else 'idle' end,
  lease_token=null,lease_until=null,worker=null,cancel_requested=false,updated_at=now() where (environment,id)=(env,p_id);
 return true;
end $$;

grant execute on all functions in schema verdant to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant\_playground\_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
