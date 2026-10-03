-- Published scientific records are immutable. Corrections create a new version.
create function verdant.protect_dataset() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.status in ('published','retired') then
  if tg_op='DELETE' then raise exception 'Published datasets cannot be deleted'; end if;
  if (to_jsonb(new)-'status')<>(to_jsonb(old)-'status') or new.status not in ('published','retired') then
   raise exception 'Published datasets are immutable; create a new version';
  end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_dataset before update or delete on verdant.dataset_versions for each row execute function verdant.protect_dataset();
create function verdant.protect_dataset_content() returns trigger
language plpgsql set search_path='' as $$
declare env text; version_id text; state text;
begin
 if tg_op='DELETE' then env:=old.environment; version_id:=old.dataset_version_id;
 else env:=new.environment; version_id:=new.dataset_version_id; end if;
 if tg_op='UPDATE' and (old.environment,old.dataset_version_id) is distinct from (new.environment,new.dataset_version_id) then
  raise exception 'Cannot move scientific records between versions';
 end if;
 -- Lock the parent against a concurrent publication transition while writing children.
 select status into state from verdant.dataset_versions where environment=env and id=version_id for share;
 if state is distinct from 'staging' then raise exception 'Only staging dataset content can change'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger protect_observations before insert or update or delete on verdant.observations for each row execute function verdant.protect_dataset_content();
create trigger protect_rasters before insert or update or delete on verdant.raster_tiles for each row execute function verdant.protect_dataset_content();

create function public.verdant_request_progress(p_namespace text,p_id uuid,p_lease_token uuid,p_status text,p_details jsonb default '{}') returns boolean
language plpgsql security invoker set search_path='' as $$
declare j verdant.jobs; r verdant.data_requests; env text:=split_part(p_namespace,':',2);
begin
 perform pg_advisory_xact_lock(hashtextextended(verdant.queue_name(p_namespace,'data_request'),0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,'data_request',p_id::text) for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 select * into r from verdant.data_requests where environment=env and id=p_id for update;
 if not found or r.status in ('ready','cancelled','failed') then return false; end if;
 if p_status is null or p_status not in ('acquiring','normalizing','validating','publishing') then raise exception 'Invalid processing state'; end if;
 -- A reclaimed job may restart acquisition. Validation is repeated before publication.
 if p_status<>'acquiring' and not ((r.status,p_status) in (('acquiring','normalizing'),('normalizing','validating'),('validating','publishing'))) then
  raise exception 'Invalid state transition'; end if;
 update verdant.data_requests set status=p_status,updated_at=now() where environment=env and id=p_id;
 insert into verdant.request_events(environment,request_id,event,details) values(env,p_id,p_status,p_details);
 return true;
end $$;
create function public.verdant_publish_request(p_namespace text,p_id uuid,p_lease_token uuid,p_dataset text,p_artifact jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j verdant.jobs; r verdant.data_requests; env text:=split_part(p_namespace,':',2); artifact_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(verdant.queue_name(p_namespace,'data_request'),0));
 select * into j from verdant.jobs where (namespace,lane,id)=(p_namespace,'data_request',p_id::text) for update;
 if found and j.status='completed' and j.completed_lease_token=p_lease_token then
  if exists(select 1 from verdant.artifacts a join verdant.data_requests req on (req.environment,req.id)=(a.environment,a.request_id)
    where a.environment=env and a.request_id=p_id and req.status='ready' and a.dataset_version_id=p_dataset
    and jsonb_build_object('format',a.format,'storage_bucket',a.storage_bucket,'storage_path',a.storage_path,'sha256',a.sha256,'byte_count',a.byte_count,'manifest',a.manifest)=p_artifact) then return true; end if;
  raise exception 'Publication replay conflict';
 end if;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
 select * into r from verdant.data_requests where environment=env and id=p_id for update;
 if not found or r.status<>'publishing' then raise exception 'Request is not ready for publication'; end if;
 if not exists(select 1 from verdant.dataset_versions where environment=env and id=p_dataset and status='published') then raise exception 'Dataset is not published'; end if;
 if p_artifact->>'storage_bucket'<>'verdant-artifacts' or left(p_artifact->>'storage_path',length(env||'/'||p_id||'/'))<>env||'/'||p_id||'/' then
  raise exception 'Artifact must be in the private request storage path'; end if;
 insert into verdant.artifacts(environment,request_id,dataset_version_id,format,storage_bucket,storage_path,sha256,byte_count,manifest)
 values(env,p_id,p_dataset,p_artifact->>'format',p_artifact->>'storage_bucket',p_artifact->>'storage_path',p_artifact->>'sha256',(p_artifact->>'byte_count')::bigint,p_artifact->'manifest') returning id into artifact_id;
 update verdant.data_requests set status='ready',updated_at=now() where environment=env and id=p_id;
 insert into verdant.request_events(environment,request_id,event,details) values(env,p_id,'ready',jsonb_build_object('artifactId',artifact_id,'datasetVersion',p_dataset));
 -- Do not acknowledge if the lease elapsed during publication: roll back the whole operation.
 if not public.verdant_finish(p_namespace,'data_request',p_id::text,p_lease_token,true,jsonb_build_object('artifactId',artifact_id)) then raise exception 'Lease expired during publication'; end if;
 return true;
end $$;

-- Private Storage objects are delivered via authorized API downloads/signed URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('verdant-artifacts','verdant-artifacts',false,10485760,array['application/json','text/csv'])
on conflict(id) do nothing;
revoke all on all functions in schema verdant from public,anon,authenticated;
grant execute on all functions in schema verdant to service_role;
revoke all on function public.verdant_request_progress(text,uuid,uuid,text,jsonb),public.verdant_publish_request(text,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.verdant_request_progress(text,uuid,uuid,text,jsonb),public.verdant_publish_request(text,uuid,uuid,text,jsonb) to service_role;
