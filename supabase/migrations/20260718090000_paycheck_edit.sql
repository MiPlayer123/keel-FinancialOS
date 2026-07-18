-- Paycheck editing (last piece of the old P3 backlog item). Paychecks are
-- immutable by design (paycheck_components/sources/matches/status_events
-- all have keel_forbid_mutation triggers), so "edit" cannot mean an
-- in-place mutation -- it has to be reverse-the-old + create-the-corrected,
-- the same shape as the existing transactions.manual_void precedent
-- (immutable original, an explicit correction on top, never mutate
-- history). Implemented as ONE new proc, keel_paycheck_edit, that calls
-- the EXISTING keel_paycheck_transition_core('reversed') and
-- keel_paycheck_create internally rather than reimplementing their
-- validation -- both already-audited functions run inside the SAME
-- Postgres transaction as keel_paycheck_edit, so if the corrected
-- create() fails validation, the reverse() that already ran in the same
-- call rolls back too. All-or-nothing, no partial state.
--
-- Building this exposed two pre-existing bugs in keel_paycheck_create that
-- would otherwise reject almost every real edit (the common case: keep
-- the same deposit transaction, fix a number). Both checks summed/matched
-- against paycheck_components/sources belonging to ANY paycheck for the
-- household, regardless of status -- so a REVERSED paycheck's old
-- allocation against a deposit transaction still counted toward that
-- transaction's capacity, and its old manual source record still counted
-- for the source-dedup check. Fixed to only count rows belonging to
-- 'active' paychecks, matching the same "only live state counts" principle
-- already used everywhere else in this codebase (the transfer detector's
-- already-linked exclusion, the sync path's live-batch-only joins).
create or replace function public.keel_paycheck_create(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_employer_id uuid; v_paycheck_id uuid:=gen_random_uuid(); v_component jsonb; v_match jsonb;
  v_component_id uuid; v_gross bigint; v_net bigint; v_gross_sum bigint; v_additions bigint;
  v_deductions bigint; v_deposits bigint; v_allocated bigint; v_capacity bigint; v_account_id uuid;
  v_result jsonb; v_after jsonb; v_source jsonb:=p_payload->'source';
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object' or jsonb_typeof(p_payload->'components')<>'array'
    or jsonb_array_length(p_payload->'components')<2 or jsonb_array_length(p_payload->'components')>100
    or jsonb_typeof(p_payload->'matches')<>'array' or jsonb_array_length(p_payload->'matches')<1
    or jsonb_array_length(p_payload->'matches')>100 or jsonb_typeof(v_source)<>'object'
    or (p_payload-'employer_name'-'pay_date'-'gross_minor'-'net_minor'-'currency'-'components'-'matches'-'source')<>'{}'::jsonb
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck payload' using errcode='P0009'; end if;
  if coalesce(p_payload->>'employer_name','')='' or length(p_payload->>'employer_name')>200
    or coalesce(p_payload->>'currency','') !~ '^[A-Z]{3}$'
    or coalesce(p_payload->>'gross_minor','') !~ '^(0|[1-9][0-9]*)$'
    or coalesce(p_payload->>'net_minor','') !~ '^(0|[1-9][0-9]*)$'
    or coalesce(v_source->>'kind','') not in ('manual','paystub','payroll_provider')
    or coalesce(v_source->>'ref','')='' or length(v_source->>'ref')>500
    or coalesce(v_source->>'content_hash','') !~ '^[a-f0-9]{64}$'
    or (v_source-'kind'-'ref'-'content_hash')<>'{}'::jsonb
  then raise exception 'KEEL_INVALID_COMMAND: paycheck scalar fields invalid' using errcode='P0009'; end if;
  -- FIX 1: only an ACTIVE paycheck's source counts as "already recorded" --
  -- a reversed paycheck's immutable source row is history, not a live
  -- conflict against a new (corrected) one.
  if exists(select 1 from public.paycheck_sources ps
    join public.paychecks pp on pp.household_id=ps.household_id and pp.id=ps.paycheck_id
    where ps.household_id=p_household_id
    and ps.source_kind=(v_source->>'kind')::public.paycheck_source_kind and ps.source_ref=v_source->>'ref'
    and ps.content_hash=v_source->>'content_hash' and pp.status='active')
  then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: paycheck source already recorded' using errcode='P0007'; end if;
  begin
    if coalesce(p_payload->>'pay_date','') !~ '^\d{4}-\d{2}-\d{2}$'
      or to_char((p_payload->>'pay_date')::date,'YYYY-MM-DD')<>p_payload->>'pay_date'
    then raise exception 'bad date'; end if;
    v_gross:=(p_payload->>'gross_minor')::bigint; v_net:=(p_payload->>'net_minor')::bigint;
  exception when others then raise exception 'KEEL_INVALID_COMMAND: paycheck date/money invalid' using errcode='P0009'; end;
  if exists (select 1 from jsonb_array_elements(p_payload->'components') c
    where jsonb_typeof(c)<>'object' or (c-'key'-'kind'-'amount_minor')<>'{}'::jsonb
      or coalesce(c->>'key','')='' or length(c->>'key')>100
      or coalesce(c->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$'
      or coalesce(c->>'kind','') not in ('gross_salary','bonus','commission','reimbursement','federal_withholding','state_withholding','local_withholding','fica_withholding','benefit','retirement_401k','employer_match','hsa','fsa','espp','rsu_withholding','garnishment','direct_deposit'))
    or (select count(*)<>count(distinct c->>'key') from jsonb_array_elements(p_payload->'components') c)
  then raise exception 'KEEL_INVALID_COMMAND: paycheck components invalid' using errcode='P0009'; end if;
  select coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind' in ('gross_salary','bonus','commission')),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind'='reimbursement'),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind' in ('federal_withholding','state_withholding','local_withholding','fica_withholding','benefit','retirement_401k','hsa','fsa','espp','rsu_withholding','garnishment')),0),
    coalesce(sum((c->>'amount_minor')::bigint) filter(where c->>'kind'='direct_deposit'),0)
    into v_gross_sum,v_additions,v_deductions,v_deposits from jsonb_array_elements(p_payload->'components') c;
  if v_gross_sum<>v_gross or v_gross_sum+v_additions-v_deductions<>v_net or v_deposits<>v_net
  then raise exception 'KEEL_INVALID_COMMAND: paycheck gross/net/direct deposits do not reconcile' using errcode='P0009'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'matches') m
    where jsonb_typeof(m)<>'object' or (m-'transaction_id'-'component_key'-'amount_minor')<>'{}'::jsonb
      or coalesce(m->>'transaction_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(m->>'amount_minor','') !~ '^(0|[1-9][0-9]*)$'
      or not exists (select 1 from jsonb_array_elements(p_payload->'components') c
        where c->>'key'=m->>'component_key' and c->>'kind' in ('retirement_401k','employer_match','hsa','fsa','espp','direct_deposit')))
  then raise exception 'KEEL_INVALID_COMMAND: paycheck matches invalid' using errcode='P0009'; end if;
  if (select count(*)<>count(distinct (m->>'transaction_id',m->>'component_key'))
      from jsonb_array_elements(p_payload->'matches') m)
  then raise exception 'KEEL_INVALID_COMMAND: duplicate paycheck match' using errcode='P0009'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'components') c
    where c->>'kind' in ('retirement_401k','employer_match','hsa','fsa','espp','direct_deposit')
      and (c->>'amount_minor')::bigint<>(select coalesce(sum((m->>'amount_minor')::bigint),0)
        from jsonb_array_elements(p_payload->'matches') m where m->>'component_key'=c->>'key'))
  then raise exception 'KEEL_INVALID_COMMAND: destination component is not fully matched' using errcode='P0009'; end if;
  for v_match in select value from jsonb_array_elements(p_payload->'matches') loop
    select t.account_id,abs(asset.amount_minor) into v_account_id,v_capacity
    from public.canonical_transactions t join public.accounts a on a.household_id=t.household_id and a.id=t.account_id
    join lateral (select b.id from public.journal_batches b where b.household_id=t.household_id
      and b.canonical_transaction_id=t.id and b.reverses_batch_id is null
      and not exists(select 1 from public.journal_revisions r where r.original_batch_id=b.id)
      order by b.posted_at desc,b.id desc limit 1) live on true
    join public.journal_postings asset on asset.batch_id=live.id and asset.ledger_account_id=a.ledger_account_id
    where t.household_id=p_household_id and t.id=(v_match->>'transaction_id')::uuid
      and t.status in ('posted','reviewed') and t.voided_at is null and asset.currency=p_payload->>'currency'
      and asset.amount_minor>0 and (select count(*) from public.journal_postings jp
        join public.accounts real on real.household_id=t.household_id and real.ledger_account_id=jp.ledger_account_id
        where jp.batch_id=live.id)=1;
    if not found or not public.keel_recurring_account_access(p_household_id,v_account_id,true)
    then raise exception 'KEEL_SCOPE_VIOLATION: paycheck destination not found' using errcode='P0006'; end if;
    select sum((m->>'amount_minor')::bigint) into v_allocated from jsonb_array_elements(p_payload->'matches') m
      where m->>'transaction_id'=v_match->>'transaction_id';
    -- FIX 2: only ACTIVE paychecks' existing allocations count against a
    -- transaction's capacity -- a reversed paycheck's old match must not
    -- block the corrected paycheck from re-matching the same deposit,
    -- which is the ordinary edit case (fix a number, same bank deposit).
    select v_allocated+coalesce(sum(existing.allocated_minor),0) into v_allocated
      from public.paycheck_transaction_matches existing
      join public.paychecks ep on ep.household_id=existing.household_id and ep.id=existing.paycheck_id
      where existing.household_id=p_household_id and existing.transaction_id=(v_match->>'transaction_id')::uuid
        and ep.status='active';
    if v_allocated>v_capacity then raise exception 'KEEL_INVALID_COMMAND: destination overallocated' using errcode='P0009'; end if;
  end loop;
  insert into public.employers(household_id,name) values(p_household_id,p_payload->>'employer_name')
    on conflict(household_id,name) do nothing returning id into v_employer_id;
  if v_employer_id is null then select id into v_employer_id from public.employers
    where household_id=p_household_id and name=p_payload->>'employer_name'; end if;
  insert into public.paychecks(id,household_id,employer_id,pay_date,gross_minor,net_minor,currency,status,formula_version,created_by)
    values(v_paycheck_id,p_household_id,v_employer_id,(p_payload->>'pay_date')::date,v_gross,v_net,p_payload->>'currency','active','paycheck-reconciliation-v1',(v_actor->>'userId')::uuid);
  for v_component in select value from jsonb_array_elements(p_payload->'components') loop
    insert into public.paycheck_components(household_id,paycheck_id,component_key,kind,amount_minor)
      values(p_household_id,v_paycheck_id,v_component->>'key',(v_component->>'kind')::public.paycheck_component_kind,(v_component->>'amount_minor')::bigint);
  end loop;
  insert into public.paycheck_sources(household_id,paycheck_id,source_kind,source_ref,content_hash)
    values(p_household_id,v_paycheck_id,(v_source->>'kind')::public.paycheck_source_kind,v_source->>'ref',v_source->>'content_hash');
  for v_match in select value from jsonb_array_elements(p_payload->'matches') loop
    select id into v_component_id from public.paycheck_components where household_id=p_household_id
      and paycheck_id=v_paycheck_id and component_key=v_match->>'component_key';
    insert into public.paycheck_transaction_matches(household_id,paycheck_id,component_id,transaction_id,allocated_minor)
      values(p_household_id,v_paycheck_id,v_component_id,(v_match->>'transaction_id')::uuid,(v_match->>'amount_minor')::bigint);
  end loop;
  insert into public.paycheck_status_events(household_id,paycheck_id,transition,reason,actor,command_id)
    values(p_household_id,v_paycheck_id,'created',null,v_actor,p_command_id);
  v_after:=jsonb_build_object('paycheckId',v_paycheck_id,'status','active','grossMinor',v_gross::text,'netMinor',v_net::text,'currency',p_payload->>'currency','formulaVersion','paycheck-reconciliation-v1');
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id,'paychecks.create',p_economic_event_key,p_household_id,v_actor,v_hash,'paychecks.created','paycheck',v_paycheck_id,v_after,v_result);
  return v_result;
exception
  when numeric_value_out_of_range then raise exception 'KEEL_INVALID_COMMAND: paycheck money outside bigint' using errcode='P0009';
  when unique_violation then raise exception 'KEEL_IDEMPOTENCY_CONFLICT: duplicate paycheck economic evidence' using errcode='P0007';
end; $$;

-- Reverse the old paycheck + create the corrected one, inside one
-- transaction (all-or-nothing). Reuses keel_paycheck_transition_core and
-- keel_paycheck_create's full validation unchanged -- this proc adds no
-- new business rules of its own, just composition. The two sub-calls get
-- their OWN economic_event_keys (":reverse"/":create" suffixes) so each
-- is independently idempotent-checked and audited (paycheck_status_events
-- and command_executions both key on economic_event_key, not command_id,
-- so reusing p_command_id across all three is safe -- see
-- command_executions' primary key (household_id, economic_event_key)).
-- keel_paycheck_edit registers its OWN command_executions row under the
-- OUTER economic_event_key, so a retried edit short-circuits at the top
-- without re-attempting either sub-call.
create or replace function public.keel_paycheck_edit(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_old_paycheck_id uuid; v_reverse_result jsonb; v_create_result jsonb; v_create_payload jsonb;
  v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id); v_actor:=public.keel_actor_from_jwt();
  v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);
  if v_replay is not null then return v_replay; end if;
  if jsonb_typeof(p_payload)<>'object'
    or coalesce(p_payload->>'paycheck_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'KEEL_INVALID_COMMAND: malformed paycheck edit' using errcode='P0009'; end if;
  v_old_paycheck_id:=(p_payload->>'paycheck_id')::uuid;

  v_reverse_result:=public.keel_paycheck_transition_core(
    p_command_id, p_economic_event_key||':reverse', p_actor, p_household_id,
    jsonb_build_object(
      'paycheck_id', v_old_paycheck_id,
      'reason', left(coalesce(nullif(btrim(p_payload->>'reason'),''),'Corrected via edit'),500)
    ),
    'reversed'
  );

  v_create_payload:=p_payload-'paycheck_id'-'reason';
  v_create_result:=public.keel_paycheck_create(
    p_command_id, p_economic_event_key||':create', p_actor, p_household_id, v_create_payload
  );

  v_after:=jsonb_build_object(
    'reversedPaycheckId', v_old_paycheck_id,
    'paycheckId', v_create_result->'effects'->'paycheckId',
    'status', 'active',
    'grossMinor', v_create_result->'effects'->'grossMinor',
    'netMinor', v_create_result->'effects'->'netMinor',
    'currency', v_create_result->'effects'->'currency'
  );
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(
    p_command_id,'paychecks.edit',p_economic_event_key,p_household_id,v_actor,v_hash,
    'paychecks.edited','paycheck',(v_create_result->'effects'->>'paycheckId')::uuid,v_after,v_result
  );
  return v_result;
end; $$;

revoke all on function public.keel_paycheck_edit(uuid,text,jsonb,uuid,jsonb) from public,anon;
grant create on schema public to keel_api;
alter function public.keel_paycheck_edit(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
revoke create on schema public from keel_api;
grant execute on function public.keel_paycheck_edit(uuid,text,jsonb,uuid,jsonb) to authenticated;
