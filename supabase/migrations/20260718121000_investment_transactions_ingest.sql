-- WS-C / FEEDBACK.md F-013 — Investments workstream, part 2 of 4.
--
-- Investment TRANSACTIONS ingestion. Plaid's /investments/transactions/get is
-- the only endpoint that returns brokerage cash-flow (deposits, withdrawals,
-- transfers, dividends/interest, fees) and trade activity; /transactions/sync
-- never carries it, so a connected brokerage / cash-management account
-- otherwise has ZERO register rows. This routes each such event into the SAME
-- raw event -> canonical transaction -> journal pipeline the sync path uses,
-- so the rows appear in the ledger and are visible to keel_detect_transfers
-- (which pairs exact-opposite cash amounts across accounts).
--
-- Design: a self-contained, idempotent worker proc modelled on
-- keel_worker_apply_promotion's `create` branch (20260710210800), NOT on the
-- cursor/attempt/lease machinery of keel_worker_apply_action —
-- /investments/transactions/get is date-range + offset paginated, has no
-- cursor, and its economic identity is the stable investment_transaction_id.
--
-- Idempotency + immutable correction (Law 9 §9.1 — idempotent economics;
-- Law 2 — reversible correction). The economic version hash
--   v_hash = sha256(econKey, amountMinor, effectiveDate)
-- distinguishes an identical replay from a genuine restatement:
--   (a) the raw event is a source VERSION, keyed
--       'inv-txn:<plaidTxnId>:<hash>' — the original body is never mutated; a
--       changed body appends a new immutable version row.
--   (b) the canonical transaction is deduped by economic_event_key
--       'inv:<connExternalRef>:<plaidTxnId>' (one canonical per economic event,
--       unique per household). A restatement corrects it in place via a
--       compensating REVERSAL of the live journal batch + a corrected
--       replacement batch + a journal_revisions row — never a duplicate,
--       never an UPDATE/DELETE of prior postings.
--   (c) command_executions (append-only) dedupes the apply on the versioned
--       apply_key 'inv-ingest:<plaidTxnId>:<hash>': an identical replay
--       short-circuits; a changed body is a NEW key (new command row), so it
--       drives the correction path instead of raising an idempotency conflict.
-- So a re-pull of an overlapping date window (which the worker deliberately
-- uses, to tolerate late-settling events) can NEVER duplicate an economic
-- event, and a provider restatement is reversibly corrected, not swallowed.
--
-- NO lot / position / cost-basis accounting (out of scope, F-013): a buy/sell
-- is ingested only for its CASH effect on the account, exactly like any other
-- transaction. Amount is the account-balance effect already (worker-side
-- mapInvestmentsTransactionsToKeel negates Plaid's cash-out-positive sign).
-- Postings are [account_ledger, uncategorized offset] summing to zero, same
-- shape as sync-created transactions.

-- Bounded incremental pull window with RESUMABLE pagination.
--
-- /investments/transactions/get is date-range + offset paginated and its
-- response carries an authoritative `total_investment_transactions`. A single
-- worker invocation pulls only a bounded number of pages (fairness), so a
-- window with more rows than that cap must RESUME on the next cycle from the
-- exact offset it stopped at — otherwise every row past the cap is lost
-- forever (the date checkpoint would otherwise advance past a window that was
-- only partially consumed). Two pieces of state make this safe:
--
--   * last_pulled_through — the newest date we have FULLY paginated. Only
--     advanced once a window's `total` is completely consumed. The next
--     incremental window starts here (minus overlap).
--   * a FROZEN in-progress window (window_from/window_to) plus a
--     continuation_offset — set while a window is mid-pagination. While these
--     are non-null the worker re-requests the SAME frozen window at the saved
--     offset, so no row is skipped and no partially-consumed window advances
--     the date checkpoint.
create table public.investment_sync_state (
  connection_id uuid primary key references public.connections (id),
  household_id uuid not null references public.households (id),
  last_pulled_through date,
  -- Frozen continuation window (all-or-nothing: either all three null, or all
  -- three set while a window is being paginated across invocations).
  window_from date,
  window_to date,
  continuation_offset integer not null default 0
    check (continuation_offset >= 0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on public.investment_sync_state from anon, authenticated;
alter table public.investment_sync_state enable row level security;
-- Worker-only surface; no authenticated read path needed (the UI reads the
-- resulting canonical transactions, not this bookkeeping table). service_role
-- bypasses RLS.

-- Resolve the window to pull THIS invocation and the offset to resume at.
-- Returns jsonb { from, to, offset }:
--   * If a frozen continuation window exists (a prior invocation hit the page
--     cap mid-window), return that exact window + saved offset so pagination
--     resumes without skipping rows.
--   * Otherwise compute the next incremental window [start, today], freeze it,
--     and return offset 0. `p_end` is passed by the worker (today) so the
--     frozen window's end is stable across the resume.
create or replace function public.keel_worker_investment_sync_window(
  p_household_id uuid,
  p_connection_id uuid,
  p_end date,
  p_overlap_days integer default 14
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.investment_sync_state%rowtype;
  v_from date;
  v_to date;
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  select * into v_row
    from public.investment_sync_state
   where connection_id = p_connection_id;

  -- Resume a frozen, partially-paginated window verbatim.
  if found and v_row.window_from is not null and v_row.window_to is not null then
    return jsonb_build_object(
      'from', v_row.window_from,
      'to', v_row.window_to,
      'offset', v_row.continuation_offset);
  end if;

  -- Otherwise open a fresh incremental window and freeze it (offset 0).
  if not found or v_row.last_pulled_through is null then
    -- First pull: reach back the same 730-day depth the link token requests.
    v_from := p_end - 730;
  else
    -- Re-pull an overlap window to catch late-settling / amended events; the
    -- idempotency layers above make the overlap harmless.
    v_from := greatest(
      v_row.last_pulled_through - greatest(p_overlap_days, 0), p_end - 730);
  end if;
  v_to := p_end;

  insert into public.investment_sync_state
    (connection_id, household_id, window_from, window_to, continuation_offset,
     last_synced_at, updated_at)
  values (p_connection_id, p_household_id, v_from, v_to, 0, now(), now())
  on conflict (connection_id) do update
    set window_from = excluded.window_from,
        window_to = excluded.window_to,
        continuation_offset = 0,
        last_synced_at = now(),
        updated_at = now();

  return jsonb_build_object('from', v_from, 'to', v_to, 'offset', 0);
end;
$$;

-- Persist a continuation offset for the FROZEN window: the worker hit the page
-- cap before consuming the window's `total`. Next invocation resumes here. Does
-- NOT advance last_pulled_through (the window isn't done). Guards against a
-- window drift by only writing when the frozen window matches.
create or replace function public.keel_worker_investment_sync_continue(
  p_household_id uuid,
  p_connection_id uuid,
  p_window_from date,
  p_window_to date,
  p_next_offset integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  update public.investment_sync_state
     set continuation_offset = greatest(p_next_offset, 0),
         last_synced_at = now(),
         updated_at = now()
   where connection_id = p_connection_id
     and window_from = p_window_from
     and window_to = p_window_to;
end;
$$;

-- Advance the date checkpoint ONLY after a window was FULLY paginated (its
-- `total` consumed) with no per-row failures. Clears the frozen continuation
-- window so the next cycle opens a fresh incremental window. `last_pulled_through`
-- monotonically advances to the completed window's end.
create or replace function public.keel_worker_investment_sync_advance(
  p_household_id uuid,
  p_connection_id uuid,
  p_window_from date,
  p_window_to date
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  insert into public.investment_sync_state
    (connection_id, household_id, last_pulled_through,
     window_from, window_to, continuation_offset, last_synced_at, updated_at)
  values (p_connection_id, p_household_id, p_window_to,
          null, null, 0, now(), now())
  on conflict (connection_id) do update
    set last_pulled_through = greatest(
          p_window_to,
          coalesce(public.investment_sync_state.last_pulled_through, p_window_to)),
        window_from = null,
        window_to = null,
        continuation_offset = 0,
        last_synced_at = now(),
        updated_at = now();
end;
$$;

-- Ingest ONE investment transaction into the canonical pipeline. Idempotent
-- via all three layers described above. Returns the canonical transaction id
-- (existing one on replay), or null if the account ref is unknown (the worker
-- treats that as skip, not failure — a brokerage sub-account KEEL doesn't
-- track shouldn't fail the whole batch).
create or replace function public.keel_worker_ingest_investment_txn(
  p_household_id uuid,
  p_connection_id uuid,
  p_account_external_ref text,
  p_provider_transaction_id text,
  p_amount_minor bigint,
  p_currency text,
  p_effective_date date,
  p_description text,
  p_flow text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn public.connections%rowtype;
  v_account public.accounts%rowtype;
  v_raw_id uuid;
  v_provider_event_id text := 'inv-txn:' || p_provider_transaction_id;
  v_economic_key text;
  v_hash text;
  -- The command idempotency key is versioned by the payload hash: an identical
  -- replay collides (short-circuit), while a CHANGED body produces a NEW key,
  -- so command_executions (append-only, immutable) records each economic
  -- version distinctly instead of raising a P0007 conflict.
  v_apply_key text;
  v_offset_id uuid;
  v_txn_id uuid;
  v_batch_id uuid;
  v_nsr_id uuid;
  v_prev_batch_id uuid;
  v_prev_effective date;
  v_reversal_id uuid;
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_existing_cmd public.command_executions%rowtype;
begin
  select * into v_conn
    from public.connections
   where id = p_connection_id and household_id = p_household_id;
  if not found then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'KEEL_INVALID_COMMAND: investment amount must be non-zero'
      using errcode = 'P0009';
  end if;
  if coalesce(p_currency, '') <> 'USD' then
    raise exception 'KEEL_INVALID_COMMAND: only USD investment transactions supported'
      using errcode = 'P0009';
  end if;

  -- Resolve the target account within THIS connection (cross-household
  -- smuggling is structurally impossible). Unknown ref = skip (return null).
  select * into v_account
    from public.accounts
   where connection_id = p_connection_id
     and household_id = p_household_id
     and external_ref = p_account_external_ref;
  if not found then
    return null;
  end if;

  v_economic_key := 'inv:' || v_conn.external_ref || ':' || p_provider_transaction_id;
  v_hash := public.keel_payload_hash(jsonb_build_object(
    'econ', v_economic_key, 'amt', p_amount_minor::text, 'date', p_effective_date));
  v_apply_key := 'inv-ingest:' || p_provider_transaction_id || ':' || v_hash;

  -- Command-level idempotency, versioned by hash: an IDENTICAL replay of this
  -- exact economic version short-circuits and returns the existing canonical.
  select * into v_existing_cmd
    from public.command_executions
   where household_id = p_household_id and economic_event_key = v_apply_key;
  if found then
    select id into v_txn_id
      from public.canonical_transactions
     where household_id = p_household_id and economic_event_key = v_economic_key;
    return v_txn_id;
  end if;

  -- Offset ledger account: uncategorized income (money in) / expense (money
  -- out), exactly as keel_worker_apply_action resolves it. The user can
  -- recategorize later; the deterministic default keeps postings balanced.
  select la.id into v_offset_id
    from public.ledger_accounts la
   where la.entity_id = v_account.entity_id
     and la.pfc_key = case when p_amount_minor < 0 then 'uncategorized_expense'
                           else 'uncategorized_income' end;
  if v_offset_id is null then
    raise exception 'KEEL_INVALID_COMMAND: offset category missing' using errcode = 'P0009';
  end if;

  -- Layer (a): source preservation. Record a raw event VERSION. On a
  -- restatement the provider_event_id carries the version hash so the original
  -- body stays immutable (a new row, never an update).
  select id into v_raw_id
    from public.raw_provider_events
   where connection_id = p_connection_id
     and provider = v_conn.provider
     and provider_event_id = v_provider_event_id || ':' || v_hash;
  if v_raw_id is null then
    insert into public.raw_provider_events
      (household_id, connection_id, provider, provider_event_id,
       account_external_ref, body, received_at)
    values
      (p_household_id, p_connection_id, v_conn.provider,
       v_provider_event_id || ':' || v_hash,
       p_account_external_ref,
       jsonb_build_object(
         'source', 'investments_transactions_get',
         'providerTransactionId', p_provider_transaction_id,
         'amountMinor', p_amount_minor::text,
         'currency', p_currency,
         'date', p_effective_date,
         'flow', p_flow,
         'description', left(coalesce(p_description, ''), 500)),
       now())
    returning id into v_raw_id;
  end if;

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending)
  values
    (v_raw_id, p_household_id, v_account.id, p_provider_transaction_id, 'added',
     p_amount_minor, p_currency, p_effective_date, left(coalesce(p_description, ''), 500), false)
  returning id into v_nsr_id;

  -- Does the canonical already exist? If so this is either a resumed
  -- partially-applied run OR a RESTATEMENT with changed economics.
  select id into v_txn_id
    from public.canonical_transactions
   where household_id = p_household_id and economic_event_key = v_economic_key;

  if v_txn_id is not null then
    -- The live batch to correct (newest non-reversal, not already reversed).
    select b.id, b.effective_date into v_prev_batch_id, v_prev_effective
      from public.journal_batches b
     where b.canonical_transaction_id = v_txn_id
       and b.reverses_batch_id is null
       and not exists (
         select 1 from public.journal_revisions r where r.original_batch_id = b.id)
     order by b.posted_at desc
     limit 1;

    if v_prev_batch_id is null then
      raise exception 'KEEL_IMMUTABLE: no live batch to correct for txn %', v_txn_id
        using errcode = 'P0001';
    end if;

    -- Compensating reversal of the live batch (Law 2: original untouched).
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date,
       reverses_batch_id, command_id)
    values
      (p_household_id, v_txn_id, 'REVERSAL: investment restatement',
       v_prev_effective, v_prev_batch_id, v_command_id)
    returning id into v_reversal_id;

    insert into public.journal_postings
      (batch_id, ledger_account_id, entity_id, amount_minor, currency)
    select v_reversal_id, p.ledger_account_id, p.entity_id, -p.amount_minor, p.currency
      from public.journal_postings p where p.batch_id = v_prev_batch_id;

    -- Corrected replacement batch with the new economics.
    insert into public.journal_batches
      (household_id, canonical_transaction_id, description, effective_date, command_id)
    values
      (p_household_id, v_txn_id, left(coalesce(p_description, ''), 500),
       p_effective_date, v_command_id)
    returning id into v_batch_id;

    perform public.keel_insert_postings(p_household_id, v_batch_id, jsonb_build_array(
      jsonb_build_object(
        'ledger_account_id', v_account.ledger_account_id,
        'amount_minor', p_amount_minor::text,
        'currency', p_currency),
      jsonb_build_object(
        'ledger_account_id', v_offset_id,
        'amount_minor', (-p_amount_minor)::text,
        'currency', p_currency)
    ));

    insert into public.journal_revisions
      (original_batch_id, reversal_batch_id, replacement_batch_id, reason)
    values (v_prev_batch_id, v_reversal_id, v_batch_id, 'investment restatement');

    insert into public.transaction_source_links
      (canonical_transaction_id, normalized_source_record_id)
    values (v_txn_id, v_nsr_id);

    update public.canonical_transactions
       set description = left(coalesce(p_description, ''), 500),
           effective_date = p_effective_date
     where id = v_txn_id;

    perform public.keel_finish_command(
      v_command_id, 'ingest.investment_txn', v_apply_key, p_household_id,
      v_actor, v_hash, 'ingest.transaction_revised', 'canonical_transaction',
      v_txn_id, jsonb_build_object('economicKey', v_economic_key, 'flow', p_flow),
      jsonb_build_object('canonicalTransactionId', v_txn_id, 'restated', true,
        'reversalBatchId', v_reversal_id, 'replacementBatchId', v_batch_id));

    return v_txn_id;
  end if;

  -- Fresh create.
  insert into public.canonical_transactions
    (household_id, entity_id, account_id, status, source, description,
     effective_date, economic_event_key)
  values
    (p_household_id, v_account.entity_id, v_account.id, 'posted', 'sync',
     left(coalesce(p_description, ''), 500), p_effective_date, v_economic_key)
  returning id into v_txn_id;

  insert into public.transaction_source_links
    (canonical_transaction_id, normalized_source_record_id)
  values (v_txn_id, v_nsr_id);

  insert into public.journal_batches
    (household_id, canonical_transaction_id, description, effective_date, command_id)
  values
    (p_household_id, v_txn_id, left(coalesce(p_description, ''), 500),
     p_effective_date, v_command_id)
  returning id into v_batch_id;

  perform public.keel_insert_postings(p_household_id, v_batch_id, jsonb_build_array(
    jsonb_build_object(
      'ledger_account_id', v_account.ledger_account_id,
      'amount_minor', p_amount_minor::text,
      'currency', p_currency),
    jsonb_build_object(
      'ledger_account_id', v_offset_id,
      'amount_minor', (-p_amount_minor)::text,
      'currency', p_currency)
  ));

  perform public.keel_finish_command(
    v_command_id, 'ingest.investment_txn', v_apply_key, p_household_id,
    v_actor, v_hash, 'ingest.transaction_created', 'canonical_transaction',
    v_txn_id, jsonb_build_object('economicKey', v_economic_key, 'flow', p_flow),
    jsonb_build_object('canonicalTransactionId', v_txn_id, 'idempotentReplay', false));

  return v_txn_id;
end;
$$;

-- Grants: postgres-owned SECURITY DEFINER (like keel_worker_sync_holdings),
-- executable only by service_role. Public EXECUTE explicitly stripped.
revoke all on function public.keel_worker_investment_sync_window(uuid, uuid, date, integer)
  from public, anon, authenticated;
grant execute on function public.keel_worker_investment_sync_window(uuid, uuid, date, integer)
  to service_role;

revoke all on function public.keel_worker_investment_sync_continue(uuid, uuid, date, date, integer)
  from public, anon, authenticated;
grant execute on function public.keel_worker_investment_sync_continue(uuid, uuid, date, date, integer)
  to service_role;

revoke all on function public.keel_worker_investment_sync_advance(uuid, uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.keel_worker_investment_sync_advance(uuid, uuid, date, date)
  to service_role;

revoke all on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text)
  to service_role;
