-- fix(recurring): drain the recurring_detection queue so detection actually runs
--
-- Two production bugs kept recurring detection from ever producing a candidate
-- for the real household (recurring_candidate_versions = 0 rows):
--
--   BUG 1 (PRIMARY — nothing drains the queue). The daily cron
--   `keel-recurring-detection` (0 3 * * *) calls
--   `keel_cron_enqueue_recurring_detection()`, which ENQUEUES one job per
--   household into the `recurring_detection` pgmq queue. But the only drain
--   crons wired on cloud — `keel-drain-sync` (*/3) and `keel-active-syncs`
--   (*/15) — operate on the `sync_events` queue. `keel_cron_drain_sync()` POSTs
--   `/worker/drain` with an empty body, which the worker defaults to
--   `queue = 'sync_events'`. Nothing ever POSTs `/worker/drain` with
--   `{"queue":"recurring_detection"}`, so the worker's recurring-detection
--   handler is never invoked. The 6 messages sitting in
--   `pgmq.q_recurring_detection` since 2026-07-13 all have read_ct = 0.
--
--   The worker already knows how to process these messages: POST /worker/drain
--   {"queue":"recurring_detection"} → keel_worker_queue_read('recurring_detection')
--   → jobType 'recurring_detection' → processRecurringDetection (read txns,
--   detectRecurringSeries, upsert candidates). No worker code change is needed;
--   the queue simply had no drain trigger. This adds one, mirroring
--   `keel_cron_drain_sync` EXACTLY (same vault secrets keel_automations_key /
--   keel_functions_base, same net.http_post shape, no hardcoded secret).
--
--   The 6 already-queued messages are consumed with no re-enqueue: they are
--   past their visibility timeout with read_ct = 0, so pgmq.read returns them
--   on the first drain. processRecurringDetection is idempotent (the run_key /
--   candidate fingerprints in keel_recurring_upsert_candidates dedupe), so
--   draining the backlog is safe even though several buckets overlap.
--
--   BUG 2 (SECONDARY — reader excludes credit cards). Even once drained, the
--   real Spotify subscription would still not be detected: the 3 Spotify
--   charges (2026-05-09 / 06-09 / 07-09, fixed -$6.99) are on the "Savor"
--   credit card, whose real-account ledger has kind = 'liability'.
--   `keel_recurring_read_txns` joined the real-account posting with
--   `asset_ledger.kind = 'asset'`, silently dropping every liability
--   (credit-card) transaction — 4 of this household's 10 accounts. The
--   detector itself is correct (a Spotify-like 3-occurrence monthly fixture is
--   proven to fire in packages/detectors/test/detect.test.ts); the reader was
--   starving it. This widens the real-account kind to include 'liability' so
--   card-billed subscriptions reach the detector. The single-real-account-posting
--   guard (exactly one posting whose ledger belongs to a real account) is
--   unchanged and already kind-agnostic, so the offset expense/income leg stays
--   excluded exactly as before.
--
-- Idempotent: cron.schedule upserts by jobname; the reader is CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- BUG 2 FIX: keel_recurring_read_txns must include liability (credit-card)
-- real accounts, not only assets. Body is identical to 20260712120000 except
-- the real-account ledger kind predicate.
-- ---------------------------------------------------------------------------
create or replace function public.keel_recurring_read_txns(p_household_id uuid) returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(row.dto order by row.effective_date, row.txn_id), '[]'::jsonb)
  from (
    select transaction_row.id as txn_id,
      transaction_row.effective_date,
      jsonb_build_object(
        'txnId', transaction_row.id,
        'batchId', live_batch.id,
        'postingId', asset_posting.id,
        'accountId', account_row.id,
        'ledgerAccountId', asset_posting.ledger_account_id,
        'effectiveDate', to_char(transaction_row.effective_date, 'YYYY-MM-DD'),
        'amountMinor', asset_posting.amount_minor::text,
        'currency', asset_posting.currency::text,
        'description', transaction_row.description
      ) as dto
    from public.canonical_transactions transaction_row
    join public.accounts account_row
      on account_row.household_id = transaction_row.household_id
     and account_row.id = transaction_row.account_id
    join lateral (
      select batch_row.*
      from public.journal_batches batch_row
      where batch_row.household_id = transaction_row.household_id
        and batch_row.canonical_transaction_id = transaction_row.id
        and batch_row.reverses_batch_id is null
        and not exists (
          select 1 from public.journal_revisions revision
           where revision.original_batch_id = batch_row.id
        )
      order by batch_row.posted_at desc, batch_row.id desc
      limit 1
    ) live_batch on true
    join public.journal_postings asset_posting
      on asset_posting.batch_id = live_batch.id
     and asset_posting.ledger_account_id = account_row.ledger_account_id
    join public.ledger_accounts asset_ledger
      on asset_ledger.household_id = transaction_row.household_id
     and asset_ledger.id = asset_posting.ledger_account_id
     -- Real-account posting for a bank account is an 'asset' ledger; for a
     -- credit card it is a 'liability' ledger. Both are the account's own
     -- real-money leg and both should feed recurring detection (card-billed
     -- subscriptions like Spotify live on liability accounts).
     and asset_ledger.kind in ('asset', 'liability')
    where transaction_row.household_id = p_household_id
      and transaction_row.status in ('posted', 'reviewed')
      and transaction_row.voided_at is null
      and (
        select count(*)
        from public.journal_postings posting_row
        join public.accounts real_account
          on real_account.household_id = transaction_row.household_id
         and real_account.ledger_account_id = posting_row.ledger_account_id
        where posting_row.batch_id = live_batch.id
      ) = 1
    order by transaction_row.effective_date desc, transaction_row.id desc
    limit 10000
  ) row;
$$;

-- Ownership/grants must match the original definition (worker-owned definer).
alter function public.keel_recurring_read_txns(uuid) owner to keel_worker;
revoke all on function public.keel_recurring_read_txns(uuid) from public, anon, authenticated;
grant execute on function public.keel_recurring_read_txns(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- BUG 1 FIX: a drain function + pg_cron job for the recurring_detection queue,
-- mirroring keel_cron_drain_sync (vault secrets, net.http_post, no hardcoded
-- credential). Runs every 15 minutes: the queue is only enqueued once daily,
-- so this comfortably picks up each day's job (and the current backlog) soon
-- after it lands without hammering the worker.
-- ---------------------------------------------------------------------------
create or replace function public.keel_cron_drain_recurring_detection()
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
  perform net.http_post(
    url := v_base || '/worker/drain',
    headers := jsonb_build_object(
      'apikey', v_key,
      'authorization', 'Bearer ' || v_key,
      'content-type', 'application/json'
    ),
    body := jsonb_build_object('queue', 'recurring_detection'));
end;
$$;

revoke all on function public.keel_cron_drain_recurring_detection()
  from public, anon, authenticated;

do $$
declare
  v_job_id bigint;
begin
  create extension if not exists pg_cron;
  for v_job_id in select jobid from cron.job where jobname = 'keel-drain-recurring-detection'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'keel-drain-recurring-detection',
    '*/15 * * * *',
    $command$ select public.keel_cron_drain_recurring_detection(); $command$
  );
exception when others then
  raise notice 'pg_cron unavailable; recurring drain callable via /worker/drain {"queue":"recurring_detection"}';
end
$$;
