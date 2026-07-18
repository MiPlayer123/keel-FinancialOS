-- Third codex finding on the same review: EconomicEventKeySchema
-- (packages/contracts) allows up to 256 chars, matching command_executions'
-- `check (length(economic_event_key) between 8 and 256)`. keel_paycheck_edit
-- appends ':reverse' (8 chars) / ':create' (7 chars) to build the two nested
-- sub-keys, so a caller near the 256-char ceiling (unreachable from this
-- app's UI, which builds a fixed ~116-char key, but reachable from any other
-- authorized caller per Law 7) would push a nested key over 256 and hit a
-- raw check-constraint violation deep inside a composed call instead of a
-- clean, expected validation error.
--
-- Fix: reject early with KEEL_INVALID_COMMAND, reserving room for the
-- longer suffix, before either sub-call runs.
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
  if length(p_economic_event_key)>248
  then raise exception 'KEEL_INVALID_COMMAND: economic event key too long for a composed edit (max 248 chars)' using errcode='P0009'; end if;
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
