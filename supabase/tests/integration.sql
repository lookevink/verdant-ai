\set ON_ERROR_STOP on
begin;
-- Public credentials must not reach the private tables or callable queue wrappers.
do $$ declare f record; begin
 if has_schema_privilege('anon','verdant','usage') or has_schema_privilege('authenticated','verdant','usage') then raise exception 'Private schema exposed'; end if;
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and proname like 'verdant_%' loop
  if has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute') then raise exception 'RPC exposed'; end if;
 end loop;
 if exists(select 1 from pg_tables t join pg_class c on c.relname=t.tablename join pg_namespace n on n.oid=c.relnamespace and n.nspname=t.schemaname where schemaname='verdant' and not c.relrowsecurity) then raise exception 'RLS missing'; end if;
end $$;
set local role service_role;
select public.verdant_enqueue('verdant:sandbox:test:smoke','probe','sql-test','{}','digest',2);
do $$ declare j jsonb; claimed jsonb; good uuid; begin
 j:=public.verdant_enqueue('verdant:sandbox:test:smoke','probe','sql-test','{}','digest',2);
 begin
  perform public.verdant_enqueue('verdant:sandbox:test:smoke','probe','sql-test','{"changed":true}','digest',2);
  raise exception 'Conflicting payload accepted';
 exception when raise_exception then if sqlerrm='Conflicting payload accepted' then raise; end if; end;
 claimed:=public.verdant_claim('verdant:sandbox:test:smoke','probe',60); good:=(claimed->>'leaseToken')::uuid;
 if claimed->'job'->>'id'<>'sql-test' then raise exception 'Claim failed'; end if;
 if public.verdant_claim('verdant:sandbox:test:smoke','probe',60) is not null then raise exception 'Duplicate claim'; end if;
 if public.verdant_finish('verdant:sandbox:test:smoke','probe','sql-test',gen_random_uuid(),true) then raise exception 'Wrong token accepted'; end if;
 if not public.verdant_renew('verdant:sandbox:test:smoke','probe','sql-test',good,60) then raise exception 'Renew failed'; end if;
 if not public.verdant_finish('verdant:sandbox:test:smoke','probe','sql-test',good,false,null,'retry',0) then raise exception 'Retry failed'; end if;
 claimed:=public.verdant_claim('verdant:sandbox:test:smoke','probe',60);
 if not public.verdant_finish('verdant:sandbox:test:smoke','probe','sql-test',(claimed->>'leaseToken')::uuid,false,null,'failed',0) then raise exception 'Final failure rejected'; end if;
 if public.verdant_get_job('verdant:sandbox:test:smoke','probe','sql-test')->>'status'<>'failed' then raise exception 'Retry budget not enforced'; end if;
end $$;
-- Float-array shape, missingness, finite values and environment foreign keys.
insert into verdant.dataset_versions(environment,id,dataset_key,title,content_sha256,source_manifest,transform_version,data_class,variables,temporal_resolution,spatial_support,period_start,period_end,license,attribution)
values('sandbox','test-data','test','Test',repeat('a',64),'[{"source":"fixture"}]','test','observation','{"tmax":"degC"}','daily','{}','2003-01-01','2003-01-01','test','test');
insert into verdant.raster_tiles(environment,dataset_version_id,id,variable,unit,observed_on,width,height,crs,transform,bbox,cells,source_window)
values('sandbox','test-data','tile','tmax','degC','2003-01-01',3,1,'EPSG:4326',array[1,0,0,0,-1,1],array[0,0,3,1],array[1,null,0]::real[],array[0,0,3,1]);
do $$ begin
 if (select cells from verdant.raster_tiles where dataset_version_id='test-data') is distinct from array[1,null,0]::real[] then raise exception 'Missingness changed'; end if;
 begin
 update verdant.raster_tiles set cells=array['NaN'::real,null,0] where dataset_version_id='test-data';
 raise exception 'NaN accepted'; exception when check_violation then null; end;
 begin
 update verdant.raster_tiles set cells=array[1]::real[] where dataset_version_id='test-data';
 raise exception 'Bad dimensions accepted'; exception when check_violation then null; end;
end $$;
insert into verdant.raster_tiles(environment,dataset_version_id,id,variable,unit,observed_on,width,height,crs,transform,bbox,cells,source_window)
select 'sandbox','test-data','index-'||lpad(n::text,4,'0'),'tmax','degC','2003-01-01',1,1,'EPSG:4326',array[1,0,0,0,-1,1],array[0,0,1,1],array[1]::real[],array[0,0,1,1] from generate_series(1,1001) n;
update verdant.dataset_versions set status='published',published_at=now() where id='test-data';
do $$ begin
 begin
 update verdant.raster_tiles set cells=array[2,null,0]::real[] where dataset_version_id='test-data';
 raise exception 'Published data changed'; exception when raise_exception then if sqlerrm='Published data changed' then raise; end if; end;
 if jsonb_array_length(public.verdant_raster_index('sandbox','test-data','index-1000',100))<>2 then raise exception 'Raster pagination lost tiles'; end if;
 if public.verdant_raster_tile('production','test-data','tile') is not null then raise exception 'Environment leak'; end if;
end $$;
-- Atomic quote purchase + enqueue, replay, and fenced publication.
do $$ declare q uuid; r uuid; claimed jsonb; tok uuid; begin
 insert into verdant.data_quotes(environment,requester_hash,request_digest,request,source_selection,limits,amount_minor,currency,payment_mode,expires_at)
 values('sandbox',repeat('b',64),repeat('c',64),'{}','{}','{}',50,'usd','test',now()+interval '1 hour') returning id into q;
 r:=public.verdant_submit_request('sandbox',q,repeat('b',64),repeat('d',64),'purchase-1','test','reference-1',repeat('e',64),'receipt-fixture');
 if r<>public.verdant_submit_request('sandbox',q,repeat('b',64),repeat('d',64),'purchase-1','test','reference-1',repeat('e',64),'receipt-fixture') then raise exception 'Purchase replay changed ID'; end if;
 if (select count(*) from verdant.jobs where id=r::text)<>1 then raise exception 'Duplicate purchase job'; end if;
 -- Clone only this test job into the dedicated smoke queue; the real enqueue is checked above.
 perform public.verdant_enqueue('verdant:sandbox:test:smoke','data_request',r::text,jsonb_build_object('requestId',r),repeat('c',64),3);
 claimed:=public.verdant_claim('verdant:sandbox:test:smoke','data_request',60); tok:=(claimed->>'leaseToken')::uuid;
 perform public.verdant_request_progress('verdant:sandbox:test:smoke',r,tok,'acquiring');
 perform public.verdant_request_progress('verdant:sandbox:test:smoke',r,tok,'normalizing');
 perform public.verdant_request_progress('verdant:sandbox:test:smoke',r,tok,'validating');
 perform public.verdant_request_progress('verdant:sandbox:test:smoke',r,tok,'publishing');
 if not public.verdant_publish_request('verdant:sandbox:test:smoke',r,tok,'test-data',jsonb_build_object('format','json','storage_bucket','verdant-artifacts','storage_path','sandbox/'||r||'/result.json','sha256',repeat('f',64),'byte_count',3,'manifest','{}'::jsonb)) then raise exception 'Publication failed'; end if;
 if not public.verdant_publish_request('verdant:sandbox:test:smoke',r,tok,'test-data',jsonb_build_object('format','json','storage_bucket','verdant-artifacts','storage_path','sandbox/'||r||'/result.json','sha256',repeat('f',64),'byte_count',3,'manifest','{}'::jsonb)) then raise exception 'Identical publication replay failed'; end if;
 if public.verdant_get_job('verdant:sandbox:test:smoke','data_request',r::text)->>'status'<>'completed' then raise exception 'Publication did not acknowledge queue'; end if;
end $$;
rollback;
select 'PASS: access controls, pgmq retries, idempotency, arrays, environment isolation, immutable publication, atomic request fulfillment' as result;
