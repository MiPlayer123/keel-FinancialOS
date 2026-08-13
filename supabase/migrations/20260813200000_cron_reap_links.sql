-- Schedule the link-attempt reaper (ops gap found 2026-08-13, live incident).
--
-- The worker has always exposed /reap-links (calls
-- keel_reap_orphan_link_attempts, Plaid /item/remove for each claimed attempt,
-- then keel_mark_link_attempt_reaped) — but NO cron ever invoked it. The
-- pg_cron jobs hit only /worker/drain and /worker/refresh-balances, so a
-- failed/expired link attempt's orphaned Plaid ITEM lived forever unless
-- someone fired the endpoint by hand. Concrete case: the Chase relink's first
-- attempt (5f54f316, failed on the archived_at-grant bug fixed in
-- 20260813170000) left production item M0P0mm… dangling for ~90 minutes until
-- a manual net.http_post reaped it.
--
-- Fix mirrors keel_cron_drain_sync exactly: a SECURITY DEFINER wrapper reads
-- the vault secrets and posts to the worker, scheduled via pg_cron. Every 15
-- minutes — attempts expire 30 minutes after start, so an orphan lives at most
-- ~45 minutes; the reaper is a no-op when nothing is reapable, and the RPC's
-- claim mechanism (reap_claim_id/claimed_at) makes overlapping runs safe.

create or replace function public.keel_cron_reap_links()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key  text;
  v_base text;
begin
  begin
    select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'keel_automations_key';
    select decrypted_secret into v_base from vault.decrypted_secrets where name = 'keel_functions_base';
  exception when others then
    return;
  end;
  if v_key is null or v_base is null then
    return;
  end if;
  perform net.http_post(
    url := v_base || '/worker/reap-links',
    headers := jsonb_build_object('apikey', v_key, 'authorization', 'Bearer ' || v_key, 'content-type', 'application/json'),
    body := '{}'::jsonb);
end;
$function$;

revoke all on function public.keel_cron_reap_links() from public, anon, authenticated;

do $$
begin
  -- Idempotent re-schedule (cron.schedule upserts by jobname); guarded so
  -- environments without pg_cron (local shadow DB, CI reset) still apply.
  perform cron.schedule(
    'keel-reap-links',
    '*/15 * * * *',
    $command$ select public.keel_cron_reap_links(); $command$
  );
exception when others then
  raise notice 'pg_cron unavailable; keel_cron_reap_links callable directly';
end $$;
