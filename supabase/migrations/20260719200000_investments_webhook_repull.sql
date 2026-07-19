-- Investments webhook -> holdings/inv-txn re-pull (F-013/F-014 follow-up).
--
-- ROOT CAUSE THIS ADDRESSES (evidence-driven, 2026-07-19): For OAuth
-- institutions such as Fidelity, Plaid's /investments/holdings/get and
-- /investments/transactions/get return HTTP 200 with EMPTY holdings /
-- securities / investment_transactions arrays until the institution has
-- finished its initial Investments pull. Live proof for the Fidelity LLC
-- brokerage (connection 7e9bdccf..., item YY0ZNjvR...): both endpoints returned
-- accounts=2 but holdings=0, securities=0, total_investment_transactions=0,
-- while the account itself (subtype 'brokerage') is present and the user
-- confirms it holds real positions (Google equity + funds incl. SPAXX). KEEL's
-- mapper dropped nothing (skipped=0) -- Plaid simply had no data yet. When
-- Fidelity finishes, Plaid signals readiness with a HOLDINGS: DEFAULT_UPDATE
-- and/or INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE webhook.
--
-- Before this migration KEEL's webhook-provider recorded those deliveries but
-- only ever enqueued a `sync_notification`, which drives /transactions/sync
-- (cursor-based) -- it NEVER re-pulls holdings or /investments/transactions.
-- The 3-minute refresh-balances cron is the only thing that re-pulls
-- Investments, so the data would eventually appear but with up-to-3-min latency
-- and no reaction to the readiness signal.
--
-- This proc lets the webhook-provider trigger an IMMEDIATE re-pull the moment
-- Plaid reports Investments data is ready, using the SAME idempotent
-- /worker/refresh-balances path the cron already uses (keel_worker_sync_holdings
-- does a full replace; keel_worker_ingest_investment_txn is keyed on the Plaid
-- investment_transaction_id -- Law 9 idempotent economics: a re-pull cannot
-- duplicate). Secret stays in the vault (Law 12); no secret reaches the
-- webhook function or the browser.

create or replace function public.keel_trigger_investment_repull()
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
    return;
  end;
  if v_key is null or v_base is null then
    return;
  end if;
  -- refresh-balances iterates every active Plaid connection and re-pulls
  -- holdings + investment transactions idempotently. Firing it (rather than a
  -- per-connection variant) keeps this identical to the proven cron call shape;
  -- the extra provider calls for other connections are bounded and cheap
  -- relative to the correctness win of reacting to the readiness webhook.
  perform net.http_post(
    url := v_base || '/worker/refresh-balances',
    headers := jsonb_build_object(
      'apikey', v_key,
      'authorization', 'Bearer ' || v_key,
      'content-type', 'application/json'),
    body := '{}'::jsonb);
end;
$$;

revoke all on function public.keel_trigger_investment_repull() from public, anon, authenticated;
grant execute on function public.keel_trigger_investment_repull() to service_role;

comment on function public.keel_trigger_investment_repull() is
  'Fired by webhook-provider on HOLDINGS / INVESTMENTS_TRANSACTIONS webhooks to '
  'immediately re-pull holdings + investment transactions via the idempotent '
  '/worker/refresh-balances path (Plaid returns empty until Fidelity/OAuth '
  'populates; this reacts to the readiness signal). Secret stays in the vault.';
