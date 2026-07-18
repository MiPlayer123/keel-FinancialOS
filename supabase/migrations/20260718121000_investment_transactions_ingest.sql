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
-- Idempotency (Law 9 §9.1 — idempotent economics): three layers.
--   (a) the raw event is deduped by (connection, provider, provider_event_id)
--       = 'inv-txn:<plaidTxnId>' — a replay re-selects the existing row.
--   (b) the canonical transaction is deduped by economic_event_key
--       'inv:<connExternalRef>:<plaidTxnId>' (unique per household).
--   (c) command_executions dedupes the apply itself via keel_idempotency_check
--       on apply_key 'inv-ingest:<plaidTxnId>'.
-- So a re-pull of an overlapping date window (which the worker deliberately
-- uses, to tolerate late-settling events) can NEVER duplicate an economic
-- event.
--
-- NO lot / position / cost-basis accounting (out of scope, F-013): a buy/sell
-- is ingested only for its CASH effect on the account, exactly like any other
-- transaction. Amount is the account-balance effect already (worker-side
-- mapInvestmentsTransactionsToKeel negates Plaid's cash-out-positive sign).
-- Postings are [account_ledger, uncategorized offset] summing to zero, same
-- shape as sync-created transactions.

-- Bounded incremental pull window: remember the newest event date we've pulled
-- per connection, so each cycle asks for a small window (with overlap) rather
-- than the full 730-day history every time.
create table public.investment_sync_state (
  connection_id uuid primary key references public.connections (id),
  household_id uuid not null references public.households (id),
  last_pulled_through date,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on public.investment_sync_state from anon, authenticated;
alter table public.investment_sync_state enable row level security;
-- Worker-only surface; no authenticated read path needed (the UI reads the
-- resulting canonical transactions, not this bookkeeping table). service_role
-- bypasses RLS.

create or replace function public.keel_worker_investment_sync_window(
  p_household_id uuid,
  p_connection_id uuid,
  p_overlap_days integer default 14
) returns date
language plpgsql
security definer
set search_path = public
as $$
declare
  v_through date;
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  select last_pulled_through into v_through
    from public.investment_sync_state
   where connection_id = p_connection_id;

  if v_through is null then
    -- First pull: reach back the same 730-day depth the link token requests.
    return current_date - 730;
  end if;
  -- Re-pull an overlap window to catch late-settling / amended events; the
  -- idempotency layers above make the overlap harmless.
  return greatest(v_through - greatest(p_overlap_days, 0), current_date - 730);
end;
$$;

create or replace function public.keel_worker_investment_sync_advance(
  p_household_id uuid,
  p_connection_id uuid,
  p_pulled_through date
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
    (connection_id, household_id, last_pulled_through, last_synced_at, updated_at)
  values (p_connection_id, p_household_id, p_pulled_through, now(), now())
  on conflict (connection_id) do update
    set last_pulled_through = greatest(
          excluded.last_pulled_through,
          coalesce(public.investment_sync_state.last_pulled_through, excluded.last_pulled_through)),
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
  v_apply_key text := 'inv-ingest:' || p_provider_transaction_id;
  v_hash text;
  v_offset_id uuid;
  v_txn_id uuid;
  v_batch_id uuid;
  v_nsr_id uuid;
  v_command_id uuid := gen_random_uuid();
  v_actor jsonb := jsonb_build_object('kind', 'system', 'processName', 'sync-worker');
  v_replay jsonb;
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

  -- Layer (c): command-level idempotency. A replay short-circuits here.
  v_replay := public.keel_idempotency_check(p_household_id, v_apply_key, v_hash);
  if v_replay is not null then
    -- Return the already-created canonical id if present.
    select id into v_txn_id
      from public.canonical_transactions
     where household_id = p_household_id and economic_event_key = v_economic_key;
    return v_txn_id;
  end if;

  -- Layer (a): source preservation. Record the raw event (immutable original),
  -- deduped by the unique (connection, provider, provider_event_id) index.
  select id into v_raw_id
    from public.raw_provider_events
   where connection_id = p_connection_id
     and provider = v_conn.provider
     and provider_event_id = v_provider_event_id;
  if v_raw_id is null then
    insert into public.raw_provider_events
      (household_id, connection_id, provider, provider_event_id,
       account_external_ref, body, received_at)
    values
      (p_household_id, p_connection_id, v_conn.provider, v_provider_event_id,
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

  -- Layer (b): if the canonical already exists (e.g. raw existed from a prior
  -- partially-applied run), don't create a second one.
  select id into v_txn_id
    from public.canonical_transactions
   where household_id = p_household_id and economic_event_key = v_economic_key;
  if v_txn_id is not null then
    -- Still record command idempotency so future replays short-circuit at (c).
    insert into public.command_executions
      (household_id, economic_event_key, command_id, command, payload_sha256, result)
    values (p_household_id, v_apply_key, v_command_id, 'ingest.investment_txn', v_hash,
            jsonb_build_object('canonicalTransactionId', v_txn_id, 'idempotentReplay', true))
    on conflict do nothing;
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

  insert into public.normalized_source_records
    (raw_event_id, household_id, account_id, provider_transaction_id, kind,
     amount_minor, currency, effective_date, description, pending)
  values
    (v_raw_id, p_household_id, v_account.id, p_provider_transaction_id, 'added',
     p_amount_minor, p_currency, p_effective_date, left(coalesce(p_description, ''), 500), false)
  returning id into v_nsr_id;

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
revoke all on function public.keel_worker_investment_sync_window(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.keel_worker_investment_sync_window(uuid, uuid, integer)
  to service_role;

revoke all on function public.keel_worker_investment_sync_advance(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.keel_worker_investment_sync_advance(uuid, uuid, date)
  to service_role;

revoke all on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_worker_ingest_investment_txn(
  uuid, uuid, text, text, bigint, text, date, text, text)
  to service_role;
