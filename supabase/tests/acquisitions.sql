\set ON_ERROR_STOP on
begin;
set local role service_role;
-- Deduplicated submission, fenced stages, atomic publication, replay, reuse, retries and abandonment.
do $$
declare ns text:='verdant:sandbox:test:smoke'; a jsonb; b jsonb; claimed jsonb; tok uuid; acq uuid; st jsonb;
 dataset jsonb:=jsonb_build_object('id','silo-tmax-test-0001','dataset_key','silo-tmax-daily','title','Test acquisition',
  'content_sha256',repeat('a',64),'source_manifest',jsonb_build_array(jsonb_build_object('url','https://example.invalid/a.tif','sha256',repeat('b',64))),
  'transform_version','test-v1','data_class','interpolated_observation','variables','{"air_temperature_max":"degC"}'::jsonb,
  'temporal_resolution','daily','spatial_support','{"crs":"EPSG:4326"}'::jsonb,'bbox','[142,-35,142.1,-34.9]'::jsonb,
  'period_start','2003-01-02','period_end','2003-01-03','license','CC-BY-4.0','attribution','test','access_level','restricted','metadata','{}'::jsonb);
 tiles jsonb:=jsonb_build_array(
  jsonb_build_object('id','d20030102','variable','air_temperature_max','unit','degC','observed_on','2003-01-02','width',2,'height',2,'crs','EPSG:4326',
   'transform','[0.05,0,142,0,-0.05,-34.9]'::jsonb,'bbox','[142,-35,142.1,-34.9]'::jsonb,'cells','[1.5,null,2,3]'::jsonb,'source_window','[601,498,2,2]'::jsonb),
  jsonb_build_object('id','d20030103','variable','air_temperature_max','unit','degC','observed_on','2003-01-03','width',2,'height',2,'crs','EPSG:4326',
   'transform','[0.05,0,142,0,-0.05,-34.9]'::jsonb,'bbox','[142,-35,142.1,-34.9]'::jsonb,'cells','[4,5,6,7]'::jsonb,'source_window','[601,498,2,2]'::jsonb));
begin
 a:=public.verdant_submit_acquisition(ns,repeat('1',64),'{"source":"silo"}','{"variables":["air_temperature_max"]}');
 b:=public.verdant_submit_acquisition(ns,repeat('1',64),'{"source":"silo"}','{"variables":["air_temperature_max"]}');
 if not (a->>'created')::boolean or (b->>'created')::boolean or a->>'id'<>b->>'id' then raise exception 'Duplicate acquisition submitted'; end if;
 acq:=(a->>'id')::uuid;
 if (select count(*) from verdant.jobs where lane='acquisition' and id=a->>'id')<>1 then raise exception 'Acquisition not enqueued exactly once'; end if;
 claimed:=public.verdant_claim(ns,'acquisition',60); tok:=(claimed->>'leaseToken')::uuid;
 if claimed->'job'->>'id'<>acq::text then raise exception 'Acquisition claim failed'; end if;
 if public.verdant_acquisition_progress(ns,acq,gen_random_uuid(),'stale','acquiring') then raise exception 'Stale lease accepted'; end if;
 perform public.verdant_acquisition_progress(ns,acq,tok,'attempt_started','acquiring','{"attempt":1}');
 perform public.verdant_acquisition_progress(ns,acq,tok,'tool_end','normalizing','{"tool":"normalize_source"}');
 begin
  perform public.verdant_acquisition_progress(ns,acq,tok,'backwards','acquiring');
 exception when others then raise exception 'Restart at acquiring rejected'; end;
 perform public.verdant_acquisition_progress(ns,acq,tok,'tool_end','validating');
 begin
  perform public.verdant_acquisition_progress(ns,acq,tok,'backwards','normalizing');
  raise exception 'Backwards transition accepted';
 exception when raise_exception then if sqlerrm='Backwards transition accepted' then raise; end if; end;
 begin
  perform public.verdant_finish(ns,'acquisition',acq::text,tok,true,'{}');
  raise exception 'Completion without publication accepted';
 exception when raise_exception then if sqlerrm='Completion without publication accepted' then raise; end if; end;
 perform public.verdant_acquisition_progress(ns,acq,tok,'publishing','publishing');
 begin
  perform public.verdant_publish_acquisition(ns,acq,tok,dataset||'{"period_end":"2003-01-04"}',tiles);
  raise exception 'Incomplete period published';
 exception when raise_exception then if sqlerrm='Incomplete period published' then raise; end if; end;
 if not public.verdant_publish_acquisition(ns,acq,tok,dataset,tiles) then raise exception 'Publication failed'; end if;
 if not public.verdant_publish_acquisition(ns,acq,tok,dataset,tiles) then raise exception 'Publication replay failed'; end if;
 st:=public.verdant_get_acquisition(ns,acq);
 if st->>'status'<>'ready' or st->>'datasetVersion'<>'silo-tmax-test-0001' or st->'job'->>'status'<>'completed'
  or jsonb_array_length(st->'events')<6 then raise exception 'Ready state not recorded: %',st; end if;
 if (select access_level||d.status from verdant.dataset_versions d where d.environment='sandbox' and d.id='silo-tmax-test-0001')<>'demopublished' then raise exception 'Dataset not published as demo data'; end if;
 if (public.verdant_raster_tile('sandbox','silo-tmax-test-0001','d20030102')->'cells')<>'[1.5,null,2,3]' then raise exception 'Missingness changed'; end if;

 -- A different target yielding identical content reuses the immutable version.
 a:=public.verdant_submit_acquisition(ns,repeat('2',64),'{"source":"silo"}','{}');
 claimed:=public.verdant_claim(ns,'acquisition',60); tok:=(claimed->>'leaseToken')::uuid; acq:=(a->>'id')::uuid;
 perform public.verdant_acquisition_progress(ns,acq,tok,'publishing','publishing');
 if not public.verdant_publish_acquisition(ns,acq,tok,dataset,tiles) then raise exception 'Reuse failed'; end if;
 if (select count(*) from verdant.raster_tiles where dataset_version_id='silo-tmax-test-0001')<>2 then raise exception 'Reuse rewrote tiles'; end if;
 begin
  a:=public.verdant_submit_acquisition(ns,repeat('3',64),'{"source":"silo"}','{}');
  claimed:=public.verdant_claim(ns,'acquisition',60); tok:=(claimed->>'leaseToken')::uuid; acq:=(a->>'id')::uuid;
  perform public.verdant_acquisition_progress(ns,acq,tok,'publishing','publishing');
  perform public.verdant_publish_acquisition(ns,acq,tok,dataset||jsonb_build_object('content_sha256',repeat('c',64)),tiles);
  raise exception 'Conflicting content accepted';
 exception when raise_exception then if sqlerrm='Conflicting content accepted' then raise; end if; end;

 -- Retryable failure returns to queued; abandonment is terminal; resubmission respects the cooldown.
 a:=public.verdant_submit_acquisition(ns,repeat('4',64),'{"source":"silo"}','{}'); acq:=(a->>'id')::uuid;
 claimed:=public.verdant_claim(ns,'acquisition',60); tok:=(claimed->>'leaseToken')::uuid;
 perform public.verdant_acquisition_progress(ns,acq,tok,'attempt_started','acquiring');
 if not public.verdant_finish(ns,'acquisition',acq::text,tok,false,null,'transient',0) then raise exception 'Retry rejected'; end if;
 if public.verdant_get_acquisition(ns,acq)->>'status'<>'queued' then raise exception 'Retry did not requeue acquisition'; end if;
 claimed:=public.verdant_claim(ns,'acquisition',60); tok:=(claimed->>'leaseToken')::uuid;
 if (claimed->'job'->>'attempts')::int<>2 then raise exception 'Retry attempt not counted'; end if;
 if not public.verdant_abandon_acquisition(ns,acq,tok,'source_unavailable') then raise exception 'Abandon rejected'; end if;
 st:=public.verdant_get_acquisition(ns,acq);
 if st->>'status'<>'failed' or st->'error'->>'reason'<>'source_unavailable' or st->'job'->>'status'<>'failed' then raise exception 'Abandon not terminal: %',st; end if;
 b:=public.verdant_submit_acquisition(ns,repeat('4',64),'{"source":"silo"}','{}');
 if (b->>'created')::boolean or b->>'id'<>acq::text then raise exception 'Cooldown ignored'; end if;
 b:=public.verdant_submit_acquisition(ns,repeat('4',64),'{"source":"silo"}','{}',null,0);
 if not (b->>'created')::boolean or b->>'id'=acq::text then raise exception 'Failed target could not be retried'; end if;
end $$;
rollback;
select 'PASS: acquisition dedup, fenced stages, atomic publication and replay, content reuse, retries, abandonment, cooldown' as result;
