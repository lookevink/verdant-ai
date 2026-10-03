-- MPP-paid acquisitions. The API verifies payment with the provider first; these functions then record
-- the payment and queue (or join) the acquisition in one transaction. A retried credential recovers the
-- original request instead of paying twice. Payments for acquisitions that end in failure become refund
-- candidates; only the API, which holds payment credentials, refunds them.

create table verdant.acquisition_payments (
 environment verdant.environment not null,
 payment_operation_id uuid not null,
 acquisition_id uuid not null,
 created_at timestamptz not null default now(),
 primary key (environment,payment_operation_id),
 foreign key (environment,payment_operation_id) references verdant.payment_operations(environment,id),
 foreign key (environment,acquisition_id) references verdant.acquisitions(environment,id)
);
create index acquisition_payment_lookup on verdant.acquisition_payments(environment,acquisition_id);
create index payment_refund_scan on verdant.payment_operations(environment,payment_mode,status);
alter table verdant.acquisition_payments enable row level security;
revoke all on verdant.acquisition_payments from public,anon,authenticated;
grant select,insert,update,delete on verdant.acquisition_payments to service_role;

-- Live acquisition for a target, or one that failed within the cooldown. Never creates anything.
create function public.verdant_find_acquisition(p_namespace text,p_coverage_digest text,p_retry_cooldown_seconds integer default 900) returns jsonb
language sql stable security invoker set search_path='' as $$
 select verdant.acquisition_json(a)||'{"created":false}' from verdant.acquisitions a
 where a.environment=split_part(p_namespace,':',2) and a.coverage_digest=p_coverage_digest
  and (a.status<>'failed' or a.updated_at>clock_timestamp()-make_interval(secs=>p_retry_cooldown_seconds))
 order by (a.status<>'failed') desc,a.created_at desc limit 1;
$$;
-- The acquisition a verified credential already paid for, with its saved receipt.
create function public.verdant_paid_acquisition(p_namespace text,p_credential_hash text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select verdant.acquisition_json(a)||jsonb_build_object('created',false,'receipt',p.receipt)
 from verdant.payment_operations p
 join verdant.acquisition_payments ap on (ap.environment,ap.payment_operation_id)=(p.environment,p.id)
 join verdant.acquisitions a on (a.environment,a.id)=(ap.environment,ap.acquisition_id)
 where p.environment=split_part(p_namespace,':',2) and p.payment_mode=split_part(p_namespace,':',3) and p.credential_hash=p_credential_hash;
$$;
create function public.verdant_submit_paid_acquisition(p_namespace text,p_coverage_digest text,p_target jsonb,p_request jsonb,p_requester_hash text,
 p_provider text,p_reference text,p_credential_hash text,p_receipt text,p_amount_minor bigint,p_currency text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q text:=verdant.queue_name(p_namespace,'acquisition'); env text:=split_part(p_namespace,':',2); mode text:=split_part(p_namespace,':',3);
 a verdant.acquisitions; pay uuid; existing jsonb; created boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended(q,0));
 existing:=public.verdant_paid_acquisition(p_namespace,p_credential_hash);
 if existing is not null then return existing; end if;
 insert into verdant.payment_operations(environment,payment_mode,provider,reference,credential_hash,request_digest,amount_minor,currency,status,receipt)
 values(env,mode,p_provider,p_reference,p_credential_hash,p_coverage_digest,p_amount_minor,p_currency,'verified',p_receipt) returning id into pay;
 -- Join a live acquisition that started while this payment was verified; a paid request never inherits a failure.
 select * into a from verdant.acquisitions where environment=env and coverage_digest=p_coverage_digest and status<>'failed';
 if not found then
  insert into verdant.acquisitions(environment,coverage_digest,target,request,requester_hash)
  values(env,p_coverage_digest,p_target,p_request,p_requester_hash) returning * into a;
  insert into verdant.acquisition_events(environment,acquisition_id,event) values(env,a.id,'queued');
  perform public.verdant_enqueue(p_namespace,'acquisition',a.id::text,jsonb_build_object('acquisitionId',a.id),p_coverage_digest,3);
  created:=true;
 end if;
 insert into verdant.acquisition_payments(environment,payment_operation_id,acquisition_id) values(env,pay,a.id);
 insert into verdant.acquisition_events(environment,acquisition_id,event,details)
 values(env,a.id,'payment_verified',jsonb_build_object('provider',p_provider,'amountMinor',p_amount_minor,'currency',p_currency));
 return verdant.acquisition_json(a)||jsonb_build_object('created',created,'receipt',p_receipt);
end $$;

-- Verified payments whose acquisition failed. The API refunds them through the provider.
create function public.verdant_refund_candidates(p_namespace text,p_limit integer default 20) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('paymentId',p.id,'provider',p.provider,'reference',p.reference,'amountMinor',p.amount_minor,
  'currency',p.currency,'acquisitionId',a.id,'reason',a.error->>'reason')),'[]') from (
 select p.* from verdant.payment_operations p
 where p.environment=split_part(p_namespace,':',2) and p.payment_mode=split_part(p_namespace,':',3) and p.status in ('verified','refund_pending')
  and exists(select 1 from verdant.acquisition_payments ap join verdant.acquisitions a on (a.environment,a.id)=(ap.environment,ap.acquisition_id)
   where (ap.environment,ap.payment_operation_id)=(p.environment,p.id) and a.status='failed')
 order by p.created_at limit greatest(1,least(coalesce(p_limit,20),100))) p
 join verdant.acquisition_payments ap on (ap.environment,ap.payment_operation_id)=(p.environment,p.id)
 join verdant.acquisitions a on (a.environment,a.id)=(ap.environment,ap.acquisition_id);
$$;
create function public.verdant_record_refund(p_namespace text,p_payment_id uuid,p_status text,p_details jsonb default '{}') returns boolean
language plpgsql security invoker set search_path='' as $$
declare env text:=split_part(p_namespace,':',2); acq uuid;
begin
 if p_status is null or p_status not in ('refund_pending','refunded','reconciliation_required') then raise exception 'Invalid refund status'; end if;
 update verdant.payment_operations set status=p_status
 where environment=env and payment_mode=split_part(p_namespace,':',3) and id=p_payment_id and status in ('verified','refund_pending');
 if not found then return false; end if;
 select acquisition_id into acq from verdant.acquisition_payments where environment=env and payment_operation_id=p_payment_id;
 insert into verdant.acquisition_events(environment,acquisition_id,event,details)
 values(env,acq,'payment_'||p_status,coalesce(p_details,'{}')||jsonb_build_object('paymentId',p_payment_id));
 return true;
end $$;

-- Acquired versions may now come from NOAA nClimGrid-Daily and NOAA CPC as well as SILO.
create or replace function public.verdant_publish_acquisition(p_namespace text,p_id uuid,p_lease_token uuid,p_dataset jsonb,p_tiles jsonb) returns boolean
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
 if d.dataset_key is null or d.dataset_key !~ '^(silo|nclimgrid|cpc)-' or d.data_class is distinct from 'interpolated_observation' or d.bbox is null then
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

revoke all on all functions in schema verdant from public,anon,authenticated;
grant execute on all functions in schema verdant to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
