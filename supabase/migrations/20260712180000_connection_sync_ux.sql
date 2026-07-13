-- Connection UX: a human display name (captured from Plaid Link metadata or set
-- by the user), an on-demand "sync now" request, and rename. Reads/writes stay
-- household-scoped and membership-checked (defense in depth behind the api's
-- own authorization).

alter table public.connections add column if not exists display_name text;

-- ---------------------------------------------------------------------------
-- On-demand sync: make the connection immediately eligible and enqueue one
-- sync_notification. The worker's sync handler bumps the generation itself.
-- ---------------------------------------------------------------------------
create or replace function public.keel_request_connection_sync(
  p_household_id uuid,
  p_connection_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if not exists (
    select 1 from public.connections
    where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;

  update public.connections
    set next_sync_eligible_at = now()
    where id = p_connection_id;

  perform pgmq.send(
    'sync_events',
    jsonb_build_object(
      'refs', jsonb_build_object('connectionId', p_connection_id::text),
      'jobType', 'sync_notification',
      'economicEventKey', 'manual:sync:' || p_connection_id::text || ':' || extract(epoch from now())::bigint::text
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Rename (also used at link time to record the institution's display name).
-- ---------------------------------------------------------------------------
create or replace function public.keel_rename_connection(
  p_household_id uuid,
  p_connection_id uuid,
  p_display_name text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(p_display_name), '');
begin
  if auth.uid() is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships
    where household_id = p_household_id and user_id = auth.uid()
  ) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  if v_name is not null and length(v_name) > 80 then
    raise exception 'KEEL_INVALID_COMMAND: display name too long' using errcode = 'P0009';
  end if;

  update public.connections
    set display_name = v_name
    where id = p_connection_id and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
end;
$$;

grant execute on function public.keel_request_connection_sync(uuid, uuid) to authenticated, service_role;
grant execute on function public.keel_rename_connection(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Internal cron drain bridge (idempotent; guards on Vault-provided secrets so
-- it is a no-op wherever they are absent, e.g. local resets). Cloud stores the
-- automations key + functions base url in Vault and schedules this via pg_cron.
-- ---------------------------------------------------------------------------
create or replace function public.keel_cron_drain_sync()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  text;
  v_base text;
begin
  begin
    select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'keel_automations_key';
    select decrypted_secret into v_base from vault.decrypted_secrets where name = 'keel_functions_base';
  exception when others then
    return; -- Vault/pg_net not present (local) — nothing to drive.
  end;
  if v_key is null or v_base is null then
    return;
  end if;
  perform net.http_post(
    url     := v_base || '/worker/drain',
    headers := jsonb_build_object(
                 'apikey', v_key,
                 'authorization', 'Bearer ' || v_key,
                 'content-type', 'application/json'),
    body    := '{}'::jsonb
  );
end;
$$;
