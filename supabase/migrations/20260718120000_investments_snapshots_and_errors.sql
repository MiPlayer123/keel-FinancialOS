-- WS-C / FEEDBACK.md F-013/F-014/F-015 — Investments workstream, part 1 of 4.
--
-- Ships three things, all worker-facing (service_role), none of which touch
-- the ledger:
--   (F-014) per-connection holdings/investments sync error columns, plus
--           worker procs to record & clear them, so the UI can tell the user
--           "reconnect Fidelity to grant investment access".
--   (history) a holdings_snapshots table (append-per-day) so the investments
--           page can chart value-over-time as data accumulates.
--   (metering) the missing usage_events kinds — the live
--           usage_events_provider_kind_check constraint never gained
--           'investments_holdings_get' (shipped in the TS ProviderCallKind
--           yesterday but not in SQL), so today's holdings meterCall violates
--           the CHECK. Add both it and the new 'investments_transactions_get'.
--
-- LOAD-BEARING INVARIANT (inherited from 20260718040000_holdings.sql):
-- holdings and their snapshots NEVER post to the journal. A connected
-- brokerage already syncs a balance that flows into net worth through the
-- ledger path; holdings are a descriptive breakdown of that balance, not a
-- second copy of it. Nothing in this file touches journal_batches /
-- journal_postings. (Investment TRANSACTIONS, part 2, DO post — those are the
-- cash movements the balance already reflects but the register was missing.)

-- ---------------------------------------------------------------------------
-- 1. Metering constraint: add the two investments kinds.
-- ---------------------------------------------------------------------------
alter table public.usage_events drop constraint usage_events_provider_kind_check;
alter table public.usage_events add constraint usage_events_provider_kind_check check (
  kind is null or kind in (
    'link_token_create','sandbox_public_token_create','item_public_token_exchange',
    'accounts_get','item_remove','webhook_key_get','transactions_sync',
    'cron_enqueue_syncs','quarantine_capped','budget_refused','recurring_detection',
    'investments_holdings_get','investments_transactions_get'
  )
);

-- ---------------------------------------------------------------------------
-- 2. Holdings/investments sync error surface on the connection (F-014).
--    Cleared on the next fully-successful holdings sync; set on any failure
--    (an item whose Item lacks the investments product errors here). The
--    message is already boundary-normalized upstream (plaid-client.ts
--    ALLOWED_PLAID_ERROR_CODES) before it reaches this column, but we cap
--    length defensively.
-- ---------------------------------------------------------------------------
alter table public.connections
  add column if not exists holdings_last_error_code text
    check (holdings_last_error_code is null or length(holdings_last_error_code) between 1 and 100),
  add column if not exists holdings_last_error_message text
    check (holdings_last_error_message is null or length(holdings_last_error_message) between 1 and 300),
  add column if not exists holdings_last_error_at timestamptz,
  add column if not exists holdings_last_success_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Holdings history snapshots (append per account/security/day).
--    Last-write-wins per day via the unique key: a second sync on the same
--    day replaces that day's row, so the chart samples one point per day.
--    Idempotent economics (Law 9 §9.1): re-running a sync can't inflate the
--    series. No `source` split by row-uniqueness because a snapshot is a
--    point-in-time total per (account, symbol, day) regardless of origin; the
--    `source` column is retained descriptively.
-- ---------------------------------------------------------------------------
create table public.holdings_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  account_id uuid not null references public.accounts (id),
  snapshot_date date not null,
  symbol text not null check (length(symbol) between 1 and 20),
  name text check (name is null or length(name) between 1 and 200),
  qty numeric not null check (qty > 0),
  price_minor bigint not null check (price_minor >= 0),
  value_minor bigint not null check (value_minor >= 0),
  cost_basis_minor bigint check (cost_basis_minor is null or cost_basis_minor >= 0),
  currency text not null default 'USD' check (currency = upper(currency)),
  source text not null check (source in ('manual', 'plaid')),
  created_at timestamptz not null default now(),
  unique (account_id, snapshot_date, symbol)
);

create index holdings_snapshots_household_date
  on public.holdings_snapshots (household_id, snapshot_date desc);

revoke all on public.holdings_snapshots from anon, authenticated;
grant select on public.holdings_snapshots to authenticated;
grant select, insert, update, delete on public.holdings_snapshots to keel_api;
alter table public.holdings_snapshots enable row level security;
create policy holdings_snapshots_member_read on public.holdings_snapshots
  for select to authenticated
  using (public.keel_is_household_member(household_id));
create policy holdings_snapshots_definer_all on public.holdings_snapshots
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 4. Worker proc: record a holdings/investments sync error for a connection.
--    Owner keel_worker, service_role-only — same trust model as
--    keel_worker_sync_holdings (worker's automations-secret auth).
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_record_holdings_error(
  p_household_id uuid,
  p_connection_id uuid,
  p_error_code text,
  p_error_message text
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

  update public.connections
     set holdings_last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'provider_error'), 100),
         holdings_last_error_message = nullif(left(btrim(coalesce(p_error_message, '')), 300), ''),
         holdings_last_error_at = now()
   where id = p_connection_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Worker proc: clear the holdings error + stamp success. Called only after
--    a clean fetch+parse+sync (the worker's existing safety rule for holdings).
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_clear_holdings_error(
  p_household_id uuid,
  p_connection_id uuid
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

  update public.connections
     set holdings_last_error_code = null,
         holdings_last_error_message = null,
         holdings_last_error_at = null,
         holdings_last_success_at = now()
   where id = p_connection_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Worker proc: append today's holdings into holdings_snapshots for a
--    connection's accounts. Reads the CURRENT holdings rows (whatever the
--    just-completed keel_worker_sync_holdings wrote) and snapshots them under
--    today's date. Last-write-wins per (account, day, symbol). Returns the
--    row count snapshotted.
--
--    Deliberately reads from `holdings` rather than re-taking the JSON payload
--    so the snapshot is guaranteed consistent with what the live table shows
--    (single source of truth), and so a manual holding present today is
--    captured in the history too.
-- ---------------------------------------------------------------------------
create or replace function public.keel_worker_snapshot_holdings(
  p_household_id uuid,
  p_connection_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.connections
     where id = p_connection_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: connection' using errcode = 'P0006';
  end if;

  insert into public.holdings_snapshots
    (household_id, account_id, snapshot_date, symbol, name, qty, price_minor,
     value_minor, cost_basis_minor, currency, source)
  select
    h.household_id, h.account_id, current_date, h.symbol, h.name, h.qty,
    h.price_minor, h.value_minor, h.cost_basis_minor, h.currency, h.source
    from public.holdings h
    join public.accounts a
      on a.id = h.account_id
     and a.connection_id = p_connection_id
     and a.household_id = p_household_id
  on conflict (account_id, snapshot_date, symbol) do update
    set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
        value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
        currency = excluded.currency, source = excluded.source;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants: postgres-owned SECURITY DEFINER (exactly like
--    keel_worker_sync_holdings), executable only by service_role — nobody
--    else. (A missing revoke here was a real security hole yesterday; the
--    default public EXECUTE grant is explicitly stripped.)
-- ---------------------------------------------------------------------------
revoke all on function public.keel_worker_record_holdings_error(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.keel_worker_record_holdings_error(uuid, uuid, text, text)
  to service_role;

revoke all on function public.keel_worker_clear_holdings_error(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_worker_clear_holdings_error(uuid, uuid)
  to service_role;

revoke all on function public.keel_worker_snapshot_holdings(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.keel_worker_snapshot_holdings(uuid, uuid)
  to service_role;
