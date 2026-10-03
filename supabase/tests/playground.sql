\set ON_ERROR_STOP on
begin;
set local role service_role;
-- Token checks, ordered events, fenced leases, follow-ups during a turn, at-least-once replay, cancellation and limits.
do $$
declare ns text:='verdant:sandbox:test:smoke'; sid uuid:=gen_random_uuid(); tok text:=repeat('a',64); client text:=repeat('c',64);
 r jsonb; claimed jsonb; lease uuid;
begin
 r:=public.verdant_playground_create(ns,sid,tok,client);
 if r->>'status'<>'idle' then raise exception 'New session not idle: %',r; end if;
 if public.verdant_playground_send(ns,sid,repeat('b',64),'hello') is not null then raise exception 'Wrong token accepted'; end if;
 if public.verdant_playground_events(ns,sid,repeat('b',64)) is not null then raise exception 'Wrong token read events'; end if;
 r:=public.verdant_playground_send(ns,sid,tok,'  How hot was January 2004 near Mildura?  ');
 if r->>'status'<>'queued' or (r->>'seq')::int<>1 then raise exception 'Message not queued: %',r; end if;
 begin
  perform public.verdant_playground_send(ns,sid,tok,'   ');
  raise exception 'Blank message accepted';
 exception when raise_exception then if sqlerrm='Blank message accepted' then raise; end if; end;

 claimed:=public.verdant_playground_claim(ns,'worker-a',30); lease:=(claimed->>'leaseToken')::uuid;
 if claimed->'session'->>'id'<>sid::text or jsonb_array_length(claimed->'messages')<>1
  or claimed->'messages'->0->>'text'<>'How hot was January 2004 near Mildura?' then raise exception 'Claim wrong: %',claimed; end if;
 if public.verdant_playground_claim(ns,'worker-b',30) is not null then raise exception 'Leased session claimed twice'; end if;
 if (public.verdant_playground_emit(ns,sid,gen_random_uuid(),'[{"kind":"turn_started"}]')->>'ok')::boolean then raise exception 'Stale lease accepted'; end if;
 begin
  perform public.verdant_playground_emit(ns,sid,lease,'[{"kind":"user_message","data":{"text":"forged"}}]');
  raise exception 'Worker forged a user message';
 exception when raise_exception then if sqlerrm='Worker forged a user message' then raise; end if; end;

 -- A follow-up sent during the turn reaches the running worker through emit, not a second claim.
 r:=public.verdant_playground_emit(ns,sid,lease,'[{"kind":"turn_started","data":{"seq":1}},{"kind":"assistant_delta","data":{"text":"Looking"}}]',1);
 if not (r->>'ok')::boolean or jsonb_array_length(r->'messages')<>0 then raise exception 'Emit failed: %',r; end if;
 perform public.verdant_playground_send(ns,sid,tok,'Also chart it.');
 r:=public.verdant_playground_emit(ns,sid,lease,'[]',1);
 if jsonb_array_length(r->'messages')<>1 or (r->'messages'->0->>'seq')::int<>4 then raise exception 'Follow-up not delivered: %',r; end if;
 perform public.verdant_playground_cancel(ns,sid,tok);
 r:=public.verdant_playground_emit(ns,sid,lease,'[{"kind":"turn_finished","data":{"reply":"It peaked at 44 C."}}]',4,1);
 if not (r->>'cancel')::boolean then raise exception 'Cancel not relayed'; end if;
 if (public.verdant_playground_emit(ns,sid,lease,'[]',4)->>'cancel')::boolean then raise exception 'Cancel relayed twice'; end if;

 -- Releasing with an unfinished message requeues it; the next claim replays it with history.
 if not public.verdant_playground_release(ns,sid,lease) then raise exception 'Release failed'; end if;
 if public.verdant_playground_events(ns,sid,tok)->>'status'<>'queued' then raise exception 'Unfinished turn not requeued'; end if;
 claimed:=public.verdant_playground_claim(ns,'worker-b',30); lease:=(claimed->>'leaseToken')::uuid;
 if jsonb_array_length(claimed->'messages')<>1 or claimed->'messages'->0->>'text'<>'Also chart it.'
  or claimed->'history'<>'[{"role":"user","text":"How hot was January 2004 near Mildura?"},{"role":"assistant","text":"It peaked at 44 C."}]'
  then raise exception 'Replay wrong: %',claimed; end if;
 if public.verdant_playground_release(ns,sid,gen_random_uuid()) then raise exception 'Stale release accepted'; end if;
 perform public.verdant_playground_emit(ns,sid,lease,'[{"kind":"turn_finished","data":{"reply":"Charted."}}]',4,4);
 perform public.verdant_playground_release(ns,sid,lease);
 r:=public.verdant_playground_events(ns,sid,tok,2,3);
 if r->>'status'<>'idle' or jsonb_array_length(r->'events')<>3 or (r->'events'->0->>'seq')::int<>3 then raise exception 'Event page wrong: %',r; end if;
 if (select array_agg((e->>'seq')::int order by (e->>'seq')::int) from jsonb_array_elements(public.verdant_playground_events(ns,sid,tok)->'events') e)
  <>array(select generate_series(1,6)) then raise exception 'Sequence not contiguous'; end if;

 -- A queued turn is cancelled without a worker; limits hold.
 perform public.verdant_playground_send(ns,sid,tok,'Never mind');
 r:=public.verdant_playground_cancel(ns,sid,tok);
 if r->>'status'<>'idle' or public.verdant_playground_claim(ns,'worker-a',30) is not null then raise exception 'Queued cancel failed: %',r; end if;
 if public.verdant_playground_send(ns,sid,tok,'one more',p_source=>'text',p_max_turns=>3)->>'error'<>'turn_limit_reached' then raise exception 'Turn limit ignored'; end if;
 for i in 1..2 loop perform public.verdant_playground_create(ns,gen_random_uuid(),tok,repeat('d',64),2); end loop;
 if public.verdant_playground_create(ns,gen_random_uuid(),tok,repeat('d',64),2)->>'error'<>'session_limit_reached' then raise exception 'Daily limit ignored'; end if;
 if exists(select 1 from verdant.playground_sessions where environment<>'sandbox') then raise exception 'Environment leaked'; end if;
end $$;
rollback;
select 'PASS: playground token checks, ordered events, fenced leases, follow-ups, replay with history, cancellation, limits' as result;
