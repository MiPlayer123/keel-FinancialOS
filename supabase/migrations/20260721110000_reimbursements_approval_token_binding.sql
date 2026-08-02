-- Law 11 (typed AI responses / approval tokens): optional token binding for
-- reimbursement commands. Pattern copied from
-- 20260720280000_statement_approve_draft_single_source.sql /
-- public.keel_cmd_statements_approve_draft and
-- 20260720270000_statement_holdings_apply.sql /
-- public.keel_cmd_statements_apply_holdings.

create or replace function public.keel_reimbursement_create_claim(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_approval_token_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_account uuid;v_capacity numeric;v_currency text;
 v_counterparty uuid;v_share uuid;v_claim uuid:=gen_random_uuid();v_amount bigint;v_after jsonb;v_result jsonb;v_approval_payload jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'original_transaction_id'-'counterparty_name'-'kind'-'amount_minor'-'currency'-'description')<>'{}'::jsonb
 or coalesce(p_payload->>'original_transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or coalesce(p_payload->>'counterparty_name','')='' or length(p_payload->>'counterparty_name')>200
 or coalesce(p_payload->>'kind','') not in('friend','employer','client','insurance','household') or coalesce(p_payload->>'amount_minor','')!~'^[1-9][0-9]*$'
 or coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$' or length(coalesce(p_payload->>'description','')) not between 1 and 500
 then raise exception 'KEEL_INVALID_COMMAND: malformed reimbursement claim' using errcode='P0009';end if;
 begin v_amount:=(p_payload->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid claim money' using errcode='P0009';end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':expense:'||(p_payload->>'original_transaction_id'),0));
 select account_id,-(amount_minor::numeric),currency into v_account,v_capacity,v_currency from public.keel_live_real_posting(p_household_id,(p_payload->>'original_transaction_id')::uuid) where amount_minor<0;
 if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: original expense not found' using errcode='P0006';end if;
 if v_currency<>p_payload->>'currency' or v_amount::numeric+coalesce((select sum(amount_minor) from public.expense_shares where household_id=p_household_id and original_transaction_id=(p_payload->>'original_transaction_id')::uuid),0)>v_capacity
 then raise exception 'KEEL_INVALID_COMMAND: expense share exceeds original expense' using errcode='P0009';end if;
 if p_approval_token_id is not null then
  v_approval_payload:=jsonb_build_object(
   'original_transaction_id',((p_payload->>'original_transaction_id')::uuid)::text,
   'counterparty_name',p_payload->>'counterparty_name',
   'kind',p_payload->>'kind',
   'amount_minor',v_amount::text,
   'currency',v_currency,
   'description',p_payload->>'description');
  perform public.keel_approval_token_redeem(p_household_id,p_approval_token_id,p_command_id,v_actor,
   'reimbursements.create_claim',v_approval_payload,1);
 end if;
 insert into public.counterparties(household_id,name,kind) values(p_household_id,p_payload->>'counterparty_name',(p_payload->>'kind')::public.counterparty_kind) on conflict(household_id,name,kind) do nothing returning id into v_counterparty;
 if v_counterparty is null then select id into v_counterparty from public.counterparties where household_id=p_household_id and name=p_payload->>'counterparty_name' and kind=(p_payload->>'kind')::public.counterparty_kind;end if;
 insert into public.expense_shares(household_id,original_transaction_id,counterparty_id,amount_minor,currency,description)
 values(p_household_id,(p_payload->>'original_transaction_id')::uuid,v_counterparty,v_amount,p_payload->>'currency',p_payload->>'description') returning id into v_share;
 insert into public.reimbursement_claims(household_id,id,expense_share_id,counterparty_id,original_transaction_id,amount_minor,currency,status,created_by)
 values(p_household_id,v_claim,v_share,v_counterparty,(p_payload->>'original_transaction_id')::uuid,v_amount,p_payload->>'currency','open',(v_actor->>'userId')::uuid);
 insert into public.reimbursement_claim_status_events(household_id,claim_id,transition,reason,actor,command_id) values(p_household_id,v_claim,'created',null,v_actor,p_command_id);
 v_after:=jsonb_build_object('claimId',v_claim,'counterpartyId',v_counterparty,'originalTransactionId',p_payload->>'original_transaction_id','amountMinor',v_amount::text,'remainingMinor',v_amount::text,'incomeImpactMinor','0','status','open');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'reimbursements.create_claim',p_economic_event_key,p_household_id,v_actor,v_hash,'reimbursements.claim_created','reimbursement_claim',v_claim,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate claim evidence' using errcode='P0007';end;$$;

create or replace function public.keel_reimbursement_settle(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_approval_token_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_allocation jsonb;v_claim public.reimbursement_claims%rowtype;
 v_counterparty uuid;v_currency text;v_total numeric:=0;v_alloc bigint;v_prior numeric;v_account uuid;v_capacity bigint;v_tx_currency text;v_settlement uuid:=gen_random_uuid();v_after jsonb;v_result jsonb;v_approval_payload jsonb;v_normalized_allocations jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'transaction_id'-'allocations'-'note')<>'{}'::jsonb or coalesce(p_payload->>'transaction_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 or jsonb_typeof(p_payload->'allocations')<>'array' or jsonb_array_length(p_payload->'allocations')<1 or jsonb_array_length(p_payload->'allocations')>100 or length(coalesce(p_payload->>'note','')) not between 1 and 500
 then raise exception 'KEEL_INVALID_COMMAND: malformed settlement' using errcode='P0009';end if;
 if(select count(*)<>count(distinct a->>'claim_id') from jsonb_array_elements(p_payload->'allocations') a) then raise exception 'KEEL_INVALID_COMMAND: duplicate claim allocation' using errcode='P0009';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_household_id::text||':settlement:'||(p_payload->>'transaction_id'),0));
 for v_allocation in select value from jsonb_array_elements(p_payload->'allocations') loop
  if coalesce(v_allocation->>'claim_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or coalesce(v_allocation->>'amount_minor','')!~'^[1-9][0-9]*$' or (v_allocation-'claim_id'-'amount_minor')<>'{}'::jsonb then raise exception 'KEEL_INVALID_COMMAND: invalid allocation' using errcode='P0009';end if;
  begin v_alloc:=(v_allocation->>'amount_minor')::bigint;exception when others then raise exception 'KEEL_INVALID_COMMAND: invalid allocation money' using errcode='P0009';end;
  select * into v_claim from public.reimbursement_claims where household_id=p_household_id and id=(v_allocation->>'claim_id')::uuid for update;
  if not found or v_claim.status<>'open' or not public.keel_reimbursement_claim_access(p_household_id,v_claim.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: claim not found' using errcode='P0006';end if;
  if v_counterparty is null then v_counterparty:=v_claim.counterparty_id;v_currency:=v_claim.currency;elsif v_counterparty<>v_claim.counterparty_id or v_currency<>v_claim.currency then raise exception 'KEEL_INVALID_COMMAND: settlement allocations must share counterparty/currency' using errcode='P0009';end if;
  select coalesce(sum(m.allocated_minor),0) into v_prior from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=p_household_id and m.claim_id=v_claim.id and s.status='active';
  if v_prior+v_alloc>v_claim.amount_minor then raise exception 'KEEL_INVALID_COMMAND: settlement exceeds claim balance' using errcode='P0009';end if;v_total:=v_total+v_alloc;
 end loop;
 select account_id,amount_minor,currency into v_account,v_capacity,v_tx_currency from public.keel_live_real_posting(p_household_id,(p_payload->>'transaction_id')::uuid) where amount_minor>0;
 if not found or not public.keel_recurring_account_access(p_household_id,v_account,true) then raise exception 'KEEL_SCOPE_VIOLATION: settlement transaction not found' using errcode='P0006';end if;
 select v_total+coalesce(sum(total_minor) filter(where status='active'),0) into v_total from public.settlements where household_id=p_household_id and transaction_id=(p_payload->>'transaction_id')::uuid;
 if v_tx_currency<>v_currency or v_total>v_capacity then raise exception 'KEEL_INVALID_COMMAND: settlement transaction overallocated' using errcode='P0009';end if;
 if p_approval_token_id is not null then
  select jsonb_agg(jsonb_build_object(
    'claim_id',((a->>'claim_id')::uuid)::text,
    'amount_minor',((a->>'amount_minor')::bigint)::text)
    order by (a->>'claim_id')::uuid, (a->>'amount_minor')::bigint)
   into v_normalized_allocations
   from jsonb_array_elements(p_payload->'allocations') a;
  v_approval_payload:=jsonb_build_object(
   'transaction_id',((p_payload->>'transaction_id')::uuid)::text,
   'allocations',v_normalized_allocations,
   'note',p_payload->>'note');
  perform public.keel_approval_token_redeem(p_household_id,p_approval_token_id,p_command_id,v_actor,
   'reimbursements.settle',v_approval_payload,1);
 end if;
 insert into public.settlements(household_id,id,counterparty_id,transaction_id,total_minor,currency,status,note,created_by)
 values(p_household_id,v_settlement,v_counterparty,(p_payload->>'transaction_id')::uuid,(select sum((a->>'amount_minor')::bigint) from jsonb_array_elements(p_payload->'allocations') a),v_currency,'active',p_payload->>'note',(v_actor->>'userId')::uuid);
 for v_allocation in select value from jsonb_array_elements(p_payload->'allocations') loop insert into public.settlement_matches(household_id,settlement_id,claim_id,allocated_minor) values(p_household_id,v_settlement,(v_allocation->>'claim_id')::uuid,(v_allocation->>'amount_minor')::bigint);end loop;
 insert into public.settlement_status_events(household_id,settlement_id,transition,reason,actor,command_id) values(p_household_id,v_settlement,'created',null,v_actor,p_command_id);
 v_after:=jsonb_build_object('settlementId',v_settlement,'transactionId',p_payload->>'transaction_id','allocatedMinor',(select total_minor::text from public.settlements where household_id=p_household_id and id=v_settlement),'incomeImpactMinor','0','status','active');
 v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 perform public.keel_finish_command(p_command_id,'reimbursements.settle',p_economic_event_key,p_household_id,v_actor,v_hash,'reimbursements.settled','settlement',v_settlement,v_after,v_result);return v_result;
exception when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate settlement evidence' using errcode='P0007';end;$$;

create or replace function public.keel_reimbursement_reverse_settlement(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_approval_token_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.settlements%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;v_approval_payload jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'settlement_id'-'reason')<>'{}'::jsonb or coalesce(p_payload->>'settlement_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid settlement reversal' using errcode='P0009';end if;
 select * into v_row from public.settlements where household_id=p_household_id and id=(p_payload->>'settlement_id')::uuid for update;
 if not found or v_row.status<>'active' then raise exception 'KEEL_SCOPE_VIOLATION: settlement not found' using errcode='P0006';end if;
 if exists(select 1 from public.settlement_matches m where m.household_id=p_household_id and m.settlement_id=v_row.id and not public.keel_reimbursement_claim_access(p_household_id,m.claim_id,true)) then raise exception 'KEEL_SCOPE_VIOLATION: settlement not found' using errcode='P0006';end if;
 if p_approval_token_id is not null then
  v_approval_payload:=jsonb_build_object(
   'settlement_id',v_row.id::text,
   'reason',p_payload->>'reason');
  perform public.keel_approval_token_redeem(p_household_id,p_approval_token_id,p_command_id,v_actor,
   'reimbursements.reverse_settlement',v_approval_payload,1);
 end if;
 v_before:=jsonb_build_object('settlementId',v_row.id,'status','active');update public.settlements set status='reversed',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.settlement_status_events(household_id,settlement_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'reversed',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('settlementId',v_row.id,'status','reversed','reason',p_payload->>'reason');v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after) values(p_household_id,v_actor,'reimbursements.reverse_settlement','settlement',v_row.id,p_command_id,v_before,v_after);
 insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload) values('reimbursements.settlement_reversed',p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
 insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result) values(p_household_id,p_economic_event_key,p_command_id,'reimbursements.reverse_settlement',v_hash,v_result);return v_result;end;$$;

create or replace function public.keel_reimbursement_reverse_claim(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_approval_token_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_row public.reimbursement_claims%rowtype;v_before jsonb;v_after jsonb;v_result jsonb;v_approval_payload jsonb;
begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
 if jsonb_typeof(p_payload)<>'object' or (p_payload-'claim_id'-'reason')<>'{}'::jsonb or coalesce(p_payload->>'claim_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or length(coalesce(p_payload->>'reason','')) not between 1 and 500 then raise exception 'KEEL_INVALID_COMMAND: invalid claim reversal' using errcode='P0009';end if;
 select * into v_row from public.reimbursement_claims where household_id=p_household_id and id=(p_payload->>'claim_id')::uuid for update;
 if not found or v_row.status<>'open' or not public.keel_reimbursement_claim_access(p_household_id,v_row.id,true) then raise exception 'KEEL_SCOPE_VIOLATION: claim not found' using errcode='P0006';end if;
 if exists(select 1 from public.settlement_matches m join public.settlements s on s.household_id=m.household_id and s.id=m.settlement_id where m.household_id=p_household_id and m.claim_id=v_row.id and s.status='active') then raise exception 'KEEL_INVALID_COMMAND: reverse active settlements first' using errcode='P0009';end if;
 if p_approval_token_id is not null then
  v_approval_payload:=jsonb_build_object(
   'claim_id',v_row.id::text,
   'reason',p_payload->>'reason');
  perform public.keel_approval_token_redeem(p_household_id,p_approval_token_id,p_command_id,v_actor,
   'reimbursements.reverse_claim',v_approval_payload,1);
 end if;
 v_before:=jsonb_build_object('claimId',v_row.id,'status','open');update public.reimbursement_claims set status='reversed',updated_at=now() where household_id=p_household_id and id=v_row.id;
 insert into public.reimbursement_claim_status_events(household_id,claim_id,transition,reason,actor,command_id) values(p_household_id,v_row.id,'reversed',p_payload->>'reason',v_actor,p_command_id);
 v_after:=jsonb_build_object('claimId',v_row.id,'status','reversed','reason',p_payload->>'reason');v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
 insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after) values(p_household_id,v_actor,'reimbursements.reverse_claim','reimbursement_claim',v_row.id,p_command_id,v_before,v_after);
 insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload) values('reimbursements.claim_reversed',p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
 insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result) values(p_household_id,p_economic_event_key,p_command_id,'reimbursements.reverse_claim',v_hash,v_result);return v_result;end;$$;

-- The trailing parameter creates the token-aware overload. Preserve the
-- existing keel_api ownership and authenticated-only execution posture.
grant create on schema public to keel_api;
alter function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
alter function public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb,uuid) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb,uuid) from public,anon;
grant execute on function public.keel_reimbursement_create_claim(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_settle(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_reverse_settlement(uuid,text,jsonb,uuid,jsonb,uuid),
 public.keel_reimbursement_reverse_claim(uuid,text,jsonb,uuid,jsonb,uuid) to authenticated;

do $$begin
 if exists(select 1 from pg_roles where rolname='keel_api' and(rolcanlogin or rolbypassrls or rolsuper))then raise exception 'KEEL_OWNERSHIP: reimbursement definer privileged';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname in('keel_reimbursement_create_claim','keel_reimbursement_settle','keel_reimbursement_reverse_settlement','keel_reimbursement_reverse_claim') and p.prosecdef and r.rolname<>'keel_api')then raise exception 'KEEL_OWNERSHIP: reimbursement approval-token definer owner';end if;
end$$;
