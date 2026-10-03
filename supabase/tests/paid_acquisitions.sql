\set ON_ERROR_STOP on
begin;
do $$ begin
 if has_function_privilege('anon','public.verdant_submit_paid_acquisition(text,text,jsonb,jsonb,text,text,text,text,text,bigint,text)','execute')
  or has_table_privilege('anon','verdant.acquisition_payments','select') then raise exception 'Paid acquisition exposed'; end if;
end $$;
set local role service_role;
-- Paid submission, credential replay, joining a live acquisition, refund candidates after failure.
do $$
declare ns text:='verdant:sandbox:test:smoke'; a jsonb; b jsonb; c jsonb; refunds jsonb; claimed jsonb; acq uuid;
begin
 a:=public.verdant_submit_paid_acquisition(ns,repeat('5',64),'{"source":"silo"}','{}',repeat('6',64),'stripe','pi_test_1',repeat('7',64),'receipt-1',50,'usd');
 if not (a->>'created')::boolean or a->>'receipt'<>'receipt-1' then raise exception 'Paid acquisition not created: %',a; end if;
 acq:=(a->>'id')::uuid;
 b:=public.verdant_submit_paid_acquisition(ns,repeat('5',64),'{"source":"silo"}','{}',repeat('6',64),'stripe','pi_test_1',repeat('7',64),'receipt-1',50,'usd');
 if (b->>'created')::boolean or b->>'id'<>acq::text then raise exception 'Credential replay changed the request'; end if;
 if (select count(*) from verdant.payment_operations where credential_hash=repeat('7',64))<>1 then raise exception 'Replay recorded a second payment'; end if;
 c:=public.verdant_submit_paid_acquisition(ns,repeat('5',64),'{"source":"silo"}','{}',repeat('8',64),'stripe','pi_test_2',repeat('9',64),'receipt-2',50,'usd');
 if (c->>'created')::boolean or c->>'id'<>acq::text then raise exception 'Second payer did not join the live acquisition'; end if;
 if (select count(*) from verdant.jobs where lane='acquisition' and id=acq::text)<>1 then raise exception 'Duplicate acquisition job'; end if;
 if public.verdant_paid_acquisition(ns,repeat('9',64))->>'receipt'<>'receipt-2' then raise exception 'Receipt recovery failed'; end if;
 if public.verdant_find_acquisition(ns,repeat('5',64))->>'id'<>acq::text then raise exception 'Live acquisition not found'; end if;
 if jsonb_array_length(public.verdant_refund_candidates(ns))<>0 then raise exception 'Live acquisition offered for refund'; end if;
 claimed:=public.verdant_claim(ns,'acquisition',60);
 if not public.verdant_abandon_acquisition(ns,acq,(claimed->>'leaseToken')::uuid,'source_unavailable') then raise exception 'Abandon failed'; end if;
 refunds:=public.verdant_refund_candidates(ns);
 if jsonb_array_length(refunds)<>2 or refunds->0->>'reason'<>'source_unavailable' then raise exception 'Refund candidates wrong: %',refunds; end if;
 if not public.verdant_record_refund(ns,(refunds->0->>'paymentId')::uuid,'refunded','{"refund":"re_test"}') then raise exception 'Refund not recorded'; end if;
 if public.verdant_record_refund(ns,(refunds->0->>'paymentId')::uuid,'refunded') then raise exception 'Refund recorded twice'; end if;
 if jsonb_array_length(public.verdant_refund_candidates(ns))<>1 then raise exception 'Refunded payment still a candidate'; end if;
 if public.verdant_find_acquisition(ns,repeat('5',64))->>'status'<>'failed' then raise exception 'Recent failure not reported'; end if;
 -- A new payment after a failure starts a fresh acquisition rather than inheriting the failure.
 a:=public.verdant_submit_paid_acquisition(ns,repeat('5',64),'{"source":"silo"}','{}',repeat('6',64),'stripe','pi_test_3',repeat('a',64),'receipt-3',50,'usd');
 if not (a->>'created')::boolean or a->>'id'=acq::text then raise exception 'Paid retry inherited a failure'; end if;
end $$;
rollback;
select 'PASS: paid acquisition, credential replay, joining live work, refund candidates and recording, fresh retry after failure' as result;
