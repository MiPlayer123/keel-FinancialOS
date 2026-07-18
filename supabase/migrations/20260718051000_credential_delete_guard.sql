-- Guard against a repeat of the 2026-07-17 incident: a raw SQL DELETE on
-- connection_credentials (an explicit, authorized full-household data wipe)
-- bypassed keel_disconnect_complete entirely, so Plaid's /item/remove was
-- never called for those Items. Their access tokens were destroyed along
-- with the row, leaving the Items permanently orphaned on Plaid's side —
-- no API can remove an Item without its access_token, and there's no
-- point-in-time recovery on this Free-tier project to get it back.
--
-- keel_disconnect_complete (20260711140100) already does this correctly: it
-- deletes connection_credentials ONLY after the edge function's
-- plaid.itemRemove() call has actually succeeded (p_removed = true). This
-- trigger makes that the ONLY way a delete can happen — a session-local GUC
-- flag, set for the instant of that one sanctioned delete, must be
-- affirmatively acknowledged or the delete is rejected. A future ad hoc
-- admin/maintenance script (like this session's wipe) will now fail loudly
-- instead of silently orphaning live Items; the fix is to loop
-- /connections/disconnect per connection (which calls Plaid first) rather
-- than deleting rows directly, or — only if the tokens are already known
-- dead some other way — explicitly `set local
-- keel.credential_delete_acknowledged = 'true'` with a NOTES.md entry
-- explaining why.
create function public.keel_guard_credential_delete() returns trigger
language plpgsql
as $$
begin
  if coalesce(nullif(pg_catalog.current_setting('keel.credential_delete_acknowledged', true), ''), 'false') <> 'true' then
    raise exception
      'KEEL_GUARD: connection_credentials deleted without calling Plaid /item/remove first. '
      'Use /connections/disconnect (which calls itemRemove before deleting), or if the access '
      'token is already known invalid, explicitly `set local keel.credential_delete_acknowledged '
      'to ''true''` and document why in NOTES.md.'
      using errcode = 'P0011';
  end if;
  return old;
end;
$$;

create trigger connection_credentials_guard_delete
  before delete on public.connection_credentials
  for each row execute function public.keel_guard_credential_delete();

-- keel_disconnect_complete is the one sanctioned caller: acknowledge for
-- just this statement (SET LOCAL — reverts automatically at transaction
-- end, no cleanup needed, no effect on any other delete in the same or a
-- later transaction).
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
