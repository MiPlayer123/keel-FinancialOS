-- Codex review caught: after paychecks.edit reverses the old paycheck and
-- creates the corrected replacement, the OLD paycheck is just status='reversed'
-- -- indistinguishable from an ordinary explicit reversal. The existing
-- restore path (keel_paycheck_transition_core) only checks status='reversed'
-- and doesn't know a replacement now exists, so a user could Restore the old
-- one, producing TWO active paychecks both allocated to the same deposit
-- transaction -- double-counted income, and a corrected record whose
-- correction silently got undone underneath it.
--
-- Fix: mark the old paycheck as permanently superseded when an edit reverses
-- it, and reject restore for superseded paychecks. Once corrected, the
-- original's story is over -- further correction happens on the replacement,
-- never by resurrecting supplanted history.
alter table public.paychecks add column if not exists superseded_by_paycheck_id uuid references public.paychecks(id);

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

create or replace function public.keel_paycheck_edit(
  p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_hash text:=public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_old_paycheck_id uuid; v_reverse_result jsonb; v_create_result jsonb; v_create_payload jsonb;
  v_new_paycheck_id uuid; v_after jsonb; v_result jsonb;
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
  v_new_paycheck_id:=(v_create_result->'effects'->>'paycheckId')::uuid;

  -- Permanently mark the old paycheck as superseded so it can never be
  -- Restored back into an active, double-counted duplicate of the
  -- correction. This runs in the same transaction as the reverse+create
  -- above, so it's part of the same all-or-nothing unit.
  update public.paychecks set superseded_by_paycheck_id=v_new_paycheck_id,updated_at=now()
    where household_id=p_household_id and id=v_old_paycheck_id;

  v_after:=jsonb_build_object(
    'reversedPaycheckId', v_old_paycheck_id,
    'paycheckId', v_new_paycheck_id,
    'status', 'active',
    'grossMinor', v_create_result->'effects'->'grossMinor',
    'netMinor', v_create_result->'effects'->'netMinor',
    'currency', v_create_result->'effects'->'currency'
  );
  v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(
    p_command_id,'paychecks.edit',p_economic_event_key,p_household_id,v_actor,v_hash,
    'paychecks.edited','paycheck',v_new_paycheck_id,v_after,v_result
  );
  return v_result;
end; $$;

create or replace function public.keel_list_paychecks(p_household_id uuid) returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_uid uuid:=coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),''),nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; v_rows jsonb;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004'; end if;
  if not exists(select 1 from public.household_memberships where household_id=p_household_id and user_id=v_uid)
  then raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006'; end if;
  select coalesce(jsonb_agg(row.dto order by row.pay_date desc,row.id),'[]'::jsonb) into v_rows from (
    select p.id,p.pay_date,jsonb_build_object('paycheckId',p.id,'employerId',p.employer_id,'employerName',e.name,
      'payDate',to_char(p.pay_date,'YYYY-MM-DD'),'grossMinor',p.gross_minor::text,'netMinor',p.net_minor::text,
      'currency',p.currency::text,'status',p.status,'formulaVersion',p.formula_version,
      'supersededByPaycheckId',p.superseded_by_paycheck_id,
      'components',coalesce((select jsonb_agg(jsonb_build_object('componentId',c.id,'key',c.component_key,'kind',c.kind,'amountMinor',c.amount_minor::text) order by c.component_key)
        from public.paycheck_components c where c.household_id=p.household_id and c.paycheck_id=p.id),'[]'::jsonb),
      'matches',coalesce((select jsonb_agg(jsonb_build_object('matchId',m.id,'componentId',m.component_id,'transactionId',m.transaction_id,'allocatedMinor',m.allocated_minor::text) order by m.id)
        from public.paycheck_transaction_matches m where m.household_id=p.household_id and m.paycheck_id=p.id),'[]'::jsonb),
      'sources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'kind',s.source_kind,'ref',s.source_ref,'contentHash',s.content_hash) order by s.id)
        from public.paycheck_sources s where s.household_id=p.household_id and s.paycheck_id=p.id),'[]'::jsonb),
      'statusEvents',coalesce((select jsonb_agg(jsonb_build_object('transition',se.transition,'reason',se.reason,'commandId',se.command_id,'createdAt',to_char(se.created_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by se.created_at,se.command_id)
        from public.paycheck_status_events se where se.household_id=p.household_id and se.paycheck_id=p.id),'[]'::jsonb)) dto
    from public.paychecks p join public.employers e on e.household_id=p.household_id and e.id=p.employer_id
    where p.household_id=p_household_id and public.keel_paycheck_access(p_household_id,p.id,false)
  ) row;
  return jsonb_build_object('scope',jsonb_build_object('householdId',p_household_id),'asOf',to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'formulaVersion','paycheck-reconciliation-v1','rows',v_rows);
end; $$;
