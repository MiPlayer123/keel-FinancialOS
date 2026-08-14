-- Daily refresh of Plaid's recurring streams for allowlisted connections.
--
-- ONCE a day, not every 15 minutes like the reaper: streams are a slow signal
-- (Plaid recomputes them as new transactions land, and a stream's frequency
-- only changes over weeks), and this is a billed add-on — a tighter cadence
-- would buy nothing and could only cost more. 09:20 UTC puts it after the
-- overnight sync drains so the day's transactions are already in Plaid's view.
--
-- Wrapper mirrors keel_cron_reap_links (20260813200000) exactly: vault secrets
-- read inside a guarded block, net.http_post to the worker, no secret ever in
-- a log line (Law 12).
create or replace function public.keel_cron_sync_recurring_streams()
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
    url := v_base || '/worker/sync-recurring-streams',
    headers := jsonb_build_object('apikey', v_key, 'authorization', 'Bearer ' || v_key, 'content-type', 'application/json'),
    body := '{}'::jsonb);
end;
$function$;

revoke all on function public.keel_cron_sync_recurring_streams() from public, anon, authenticated;

do $$
begin
  perform cron.schedule(
    'keel-sync-recurring-streams',
    '20 9 * * *',
    $command$ select public.keel_cron_sync_recurring_streams(); $command$
  );
exception when others then
  raise notice 'pg_cron unavailable; keel_cron_sync_recurring_streams callable directly';
end $$;
