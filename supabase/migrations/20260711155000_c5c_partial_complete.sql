-- Stage 1C C5c: partial live-sync completion and owner-fenced failure cleanup.
-- Replace (do not overload) the C5b completion signature so default-argument
-- resolution remains unambiguous.

drop function public.keel_worker_complete_attempt(uuid, uuid, text);

create function public.keel_worker_complete_attempt(
  p_attempt_id uuid,
  p_owner uuid,
  p_next_cursor text,
  p_fully_synced boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
  v_conn public.connections%rowtype;
begin
  select * into v_attempt from public.sync_attempts where attempt_id = p_attempt_id;
  if not found then
    raise exception 'KEEL_INVALID_COMMAND: unknown attempt' using errcode = 'P0009';
  end if;
  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);

  select * into v_conn
    from public.connections
   where id = v_attempt.connection_id
   for no key update;
  if v_conn.status <> 'active'
     or v_attempt.generation < v_conn.sync_desired_generation then
    raise exception 'KEEL_SYNC_SUPERSEDED' using errcode = 'P0007';
  end if;

  update public.sync_attempts set state = 'completed', promoted_at = now(),
         next_request_cursor = p_next_cursor
   where attempt_id = p_attempt_id;

  insert into public.sync_checkpoints (connection_id, cursor)
  values (v_attempt.connection_id, p_next_cursor)
  on conflict (connection_id) do update set cursor = excluded.cursor, updated_at = now();

  update public.connections
     set sync_committed_generation = v_attempt.generation,
         last_successful_sync_at = case
           when p_fully_synced then now()
           else last_successful_sync_at
         end,
         sync_lease_owner = null, sync_leased_until = null
   where id = v_attempt.connection_id;

  return jsonb_build_object('completed', true, 'generation', v_attempt.generation);
end;
$$;

create function public.keel_worker_abandon_and_release(
  p_attempt_id uuid,
  p_owner uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.sync_attempts%rowtype;
begin
  select * into v_attempt
    from public.sync_attempts
   where attempt_id = p_attempt_id
   for update;
  if not found then
    return;
  end if;

  perform public.keel_worker_assert_lease(v_attempt.connection_id, p_owner);
  update public.sync_attempts
     set state = 'abandoned'
   where attempt_id = p_attempt_id;
  update public.connections
     set sync_lease_owner = null,
         sync_leased_until = null
   where id = v_attempt.connection_id
     and sync_lease_owner = p_owner;
end;
$$;

grant create on schema public to keel_worker;
do $$
declare f text;
begin
  foreach f in array array[
    'keel_worker_complete_attempt(uuid, uuid, text, boolean)',
    'keel_worker_abandon_and_release(uuid, uuid)'
  ] loop
    execute format('alter function public.%s owner to keel_worker', f);
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end
$$;
revoke create on schema public from keel_worker;

-- The Edge worker runs as service_role and needs the existing atomic queue
-- helper to schedule a fresh attempt after committing a partial cursor.
grant execute on function public.keel_enqueue(text, jsonb) to service_role;
