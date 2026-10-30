-- Restore the credential-delete re-arm in keel_disconnect_complete on the live
-- project. Re-states 20260718051000_credential_delete_guard.sql's definition
-- verbatim, so this is a no-op anywhere that migration was applied as written.
--
-- Why: live-schema-drift (2026-10-30) showed production's copy is missing
--     perform set_config('keel.credential_delete_acknowledged', 'false', true);
-- right after the sanctioned connection_credentials delete. Without it the
-- acknowledgement stays set for the rest of the calling transaction instead of
-- covering exactly one delete. Not exploitable through the API today (the edge
-- function calls this proc in its own transaction and deletes nothing after
-- it), but it is the guard CLAUDE.md "Ops facts" relies on after the
-- 2026-07-17 orphaned-Plaid-Items incident, so production should match.
--
-- CREATE OR REPLACE keeps the owner and grants; idempotent.

create or replace function public.keel_disconnect_complete(
  p_household_id uuid,
  p_connection_id uuid,
  p_removal_attempt_id uuid,
  p_removed boolean,
  p_failure text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_attempt public.removal_attempts%rowtype;
  v_actor jsonb;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: connection not in household' using errcode = 'P0006';
  end if;
  select * into v_attempt
    from public.removal_attempts
   where id = p_removal_attempt_id
     and household_id = p_household_id
     and connection_id = p_connection_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: removal attempt mismatch' using errcode = 'P0006';
  end if;

  if v_conn.status = 'disconnected' and v_attempt.state = 'succeeded' then
    return;
  end if;
  if v_conn.status <> 'disconnecting' or v_attempt.state <> 'pending' then
    raise exception 'KEEL_INVALID_COMMAND: stale disconnect transition' using errcode = 'P0009';
  end if;

  v_actor := jsonb_build_object('kind', 'user', 'userId', v_attempt.initiated_by_user_id);
  if p_removed then
    perform set_config('keel.credential_delete_acknowledged', 'true', true);
    delete from public.connection_credentials
     where household_id = p_household_id and connection_id = p_connection_id;
    -- Re-arm immediately: the ack is a single-delete permission slip, not a
    -- standing grant for the rest of whatever transaction called this proc.
    perform set_config('keel.credential_delete_acknowledged', 'false', true);
    update public.connections set status = 'disconnected' where id = p_connection_id;
    update public.removal_attempts
       set state = 'succeeded', completed_at = now(), failure_code = null
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnected', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id));
  else
    update public.removal_attempts
       set state = 'failed', completed_at = now(), failure_code = p_failure
     where id = p_removal_attempt_id;
    insert into public.audit_log
      (household_id, actor, action, object_type, object_id, after)
    values
      (p_household_id, v_actor, 'connection.disconnect_failed', 'connection', p_connection_id,
       jsonb_build_object('connectionId', p_connection_id,
                          'removalAttemptId', p_removal_attempt_id,
                          'failureCode', p_failure));
  end if;
end;
$$;
