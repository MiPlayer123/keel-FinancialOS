-- Second codex finding on the same review: the supersession marker
-- (20260718091500) only protects the specific paycheck an *edit* reversed.
-- It does nothing for the pre-existing manual flow of clicking Reverse and
-- then recording a brand-new paycheck against the same deposit -- FIX 2 in
-- 20260718090000 relaxed the overallocation check to only count ACTIVE
-- paychecks (a deliberate, necessary relaxation so edits can re-book the
-- same deposit), which as a side effect also lets that manual flow re-book
-- a deposit a reversed-but-not-superseded paycheck still has a match row
-- for. Restoring that manually-reversed original then produces two active
-- paychecks allocated to the same deposit -- the exact double-count bug,
-- just reached by a different door.
--
-- Fix: revalidate allocation capacity at restore time too, the same way
-- keel_paycheck_create validates it at create time, rather than relying
-- solely on the edit-specific supersession marker. This closes the gap for
-- every path that can reverse a paycheck, not just paychecks.edit.
create or replace function public.keel_paycheck_transition_core(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb,p_transition public.paycheck_transition
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb; v_row public.paychecks%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb; v_status public.paycheck_status; v_command text;
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash); if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object' or (p_payload-'paycheck_id'-'reason')<>'{}'::jsonb
    or coalesce(p_payload->>'paycheck_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or length(coalesce(p_payload->>'reason','')) not between 1 and 500
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck transition' using errcode='P0009'; end if;
  select * into v_row from public.paychecks where household_id=p_household_id and id=(p_payload->>'paycheck_id')::uuid for update;
  if not found or not public.keel_paycheck_access(p_household_id,v_row.id,true)
  then raise exception 'KEEL_SCOPE_VIOLATION: paycheck not found' using errcode='P0006'; end if;
  if (p_transition='reversed' and v_row.status<>'active')
    or (p_transition='restored' and (v_row.status<>'reversed' or v_row.superseded_by_paycheck_id is not null))
  then raise exception 'KEEL_INVALID_COMMAND: invalid paycheck transition' using errcode='P0009'; end if;
  if p_transition='restored' and exists (
    select 1
    from (
      select pm.transaction_id,sum(pm.allocated_minor) as mine_minor
      from public.paycheck_transaction_matches pm
      where pm.household_id=p_household_id and pm.paycheck_id=v_row.id
      group by pm.transaction_id
    ) mine
    left join lateral (
      select abs(asset.amount_minor) as capacity_minor
      from public.canonical_transactions t
      join public.accounts a on a.household_id=t.household_id and a.id=t.account_id
      join lateral (
        select b.id from public.journal_batches b
        where b.household_id=t.household_id and b.canonical_transaction_id=t.id
          and b.reverses_batch_id is null
          and not exists(select 1 from public.journal_revisions r where r.original_batch_id=b.id)
        order by b.posted_at desc,b.id desc limit 1
      ) live on true
      join public.journal_postings asset on asset.batch_id=live.id and asset.ledger_account_id=a.ledger_account_id
      where t.household_id=p_household_id and t.id=mine.transaction_id and asset.amount_minor>0
    ) cap on true
    left join lateral (
      select coalesce(sum(other.allocated_minor),0) as others_minor
      from public.paycheck_transaction_matches other
      join public.paychecks op on op.household_id=other.household_id and op.id=other.paycheck_id
      where other.household_id=p_household_id and other.transaction_id=mine.transaction_id
        and op.status='active' and op.id<>v_row.id
    ) o on true
    where mine.mine_minor+coalesce(o.others_minor,0)>coalesce(cap.capacity_minor,0)
  ) then
    raise exception 'KEEL_INVALID_COMMAND: restoring would overallocate an already-claimed deposit' using errcode='P0009';
  end if;
  v_status:=case when p_transition='reversed' then 'reversed'::public.paycheck_status else 'active'::public.paycheck_status end;
  v_command:=case when p_transition='reversed' then 'paychecks.reverse' else 'paychecks.restore' end;
  v_before:=jsonb_build_object('paycheckId',v_row.id,'status',v_row.status);
  insert into public.paycheck_status_events(household_id,paycheck_id,transition,reason,actor,command_id)
    values(p_household_id,v_row.id,p_transition,p_payload->>'reason',v_actor,p_command_id);
  update public.paychecks set status=v_status,updated_at=now() where household_id=p_household_id and id=v_row.id;
  v_after:=jsonb_build_object('paycheckId',v_row.id,'status',v_status,'reason',p_payload->>'reason');
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  insert into public.audit_log(household_id,actor,action,object_type,object_id,command_id,before,after)
    values(p_household_id,v_actor,v_command,'paycheck',v_row.id,p_command_id,v_before,v_after);
  insert into public.domain_events(event_type,household_id,command_id,economic_event_key,actor,payload)
    values('paychecks.'||p_transition::text,p_household_id,p_command_id,p_economic_event_key,v_actor,v_after);
  insert into public.command_executions(household_id,economic_event_key,command_id,command,payload_sha256,result)
    values(p_household_id,p_economic_event_key,p_command_id,v_command,v_hash,v_result);
  return v_result;
end; $$;
