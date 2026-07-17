-- S-inv-1a (docs/harness/plans/investments-v1.md, part of INVEST-1):
-- Investments v1, trimmed to what BC-v2.1 §3 actually gates first --
-- "Balances and holdings ship first... Lots/cost basis/corporate actions
-- ship only after completeness gates." Of the ten tables that section
-- names, this ships exactly one: `holdings`, with symbol denormalized onto
-- the row per docs/10-KEEL-TECH-SPEC.md §2's sketch. No `securities`
-- master table yet -- that's the next layer once a second consumer needs
-- it.
--
-- LOAD-BEARING INVARIANT: holdings never post to the journal. A connected
-- brokerage already syncs a balance that already flows into net worth
-- through the existing ledger path. Holdings are a descriptive breakdown
-- of a balance that already exists ("what's inside the $47,000"), not a
-- second $47,000. Nothing in this file touches journal_batches or
-- journal_postings -- if a future change adds that, it is double-counting
-- and wrong.
--
-- One current snapshot per account: `keel_list_holdings` returns the rows
-- at each account's MOST RECENT as_of date (regardless of source), never a
-- mix of a stale manual row next to a fresh Plaid row for the same symbol.
-- Manual entry always upserts to today's date; a later Plaid sync (S-inv-1b,
-- not built here) becomes authoritative again once it runs.
create table public.holdings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  account_id uuid not null references public.accounts (id),
  as_of date not null,
  symbol text not null check (length(symbol) between 1 and 20),
  name text check (name is null or length(name) between 1 and 200),
  qty numeric not null check (qty > 0),
  price_minor bigint not null check (price_minor >= 0),
  value_minor bigint not null check (value_minor >= 0),
  cost_basis_minor bigint check (cost_basis_minor is null or cost_basis_minor >= 0),
  currency text not null default 'USD' check (currency = upper(currency)),
  source text not null check (source in ('manual', 'plaid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotent economics (Law 9 §9.1): re-saving the same symbol on the
  -- same account on the same day replaces, never duplicates.
  unique (account_id, as_of, symbol, source)
);

create index holdings_account_as_of on public.holdings (account_id, as_of desc);

revoke all on public.holdings from anon, authenticated;
grant select on public.holdings to authenticated;
grant select, insert, update, delete on public.holdings to keel_api;
alter table public.holdings enable row level security;
create policy holdings_member_read on public.holdings
  for select to authenticated
  using (public.keel_is_household_member(household_id));
create policy holdings_definer_all on public.holdings
  for all to keel_api using (true) with check (true);

-- Manual entry: upsert by (account_id, symbol) at today's date. Server
-- computes value_minor itself (round(qty * price_minor) in Postgres
-- `numeric` -- exact decimal arithmetic, no float, Law 4) rather than
-- trusting a client-supplied total.
create or replace function public.keel_holding_upsert(
  p_household_id uuid,
  p_account_id uuid,
  p_holding_id uuid,
  p_symbol text,
  p_name text,
  p_qty numeric,
  p_price_minor bigint,
  p_cost_basis_minor bigint default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_value_minor bigint;
  v_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  if char_length(v_symbol) < 1 or char_length(v_symbol) > 20 then
    raise exception 'KEEL_INVALID_COMMAND: symbol must be 1-20 characters' using errcode = 'P0009';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'KEEL_INVALID_COMMAND: quantity must be positive' using errcode = 'P0009';
  end if;
  if p_price_minor is null or p_price_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: price must be non-negative' using errcode = 'P0009';
  end if;
  if p_cost_basis_minor is not null and p_cost_basis_minor < 0 then
    raise exception 'KEEL_INVALID_COMMAND: cost basis must be non-negative' using errcode = 'P0009';
  end if;

  if not exists (
    select 1 from public.accounts where id = p_account_id and household_id = p_household_id
  ) then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  v_value_minor := round(p_qty * p_price_minor)::bigint;

  if p_holding_id is not null then
    select to_jsonb(h) into v_before from public.holdings h
      where h.id = p_holding_id and h.household_id = p_household_id and h.source = 'manual';
    if v_before is null then
      raise exception 'KEEL_NOT_FOUND: holding' using errcode = 'P0006';
    end if;

    update public.holdings
       set symbol = v_symbol, name = v_name, qty = p_qty, price_minor = p_price_minor,
           value_minor = v_value_minor, cost_basis_minor = p_cost_basis_minor,
           updated_at = now()
     where id = p_holding_id
    returning id into v_id;
  else
    insert into public.holdings
      (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
       cost_basis_minor, currency, source)
    values
      (p_household_id, p_account_id, current_date, v_symbol, v_name, p_qty, p_price_minor,
       v_value_minor, p_cost_basis_minor, 'USD', 'manual')
    on conflict (account_id, as_of, symbol, source) do update
      set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
          value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
          updated_at = now()
    returning id into v_id;
  end if;

  select to_jsonb(h) into v_after from public.holdings h where h.id = v_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          case when v_before is null then 'holdings.create' else 'holdings.update' end,
          'holding', v_id, v_before, v_after);

  return v_id;
end;
$$;

create or replace function public.keel_holding_delete(
  p_household_id uuid,
  p_holding_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_before jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);

  -- Only manual rows are user-deletable; a Plaid-synced row disappears
  -- naturally when it's absent from the next sync (S-inv-1b), never via
  -- this command -- otherwise a deleted-then-resynced row would look like
  -- user intent when it was just sync timing.
  select to_jsonb(h) into v_before from public.holdings h
    where h.id = p_holding_id and h.household_id = p_household_id and h.source = 'manual';
  if v_before is null then
    raise exception 'KEEL_NOT_FOUND: holding' using errcode = 'P0006';
  end if;

  delete from public.holdings where id = p_holding_id;

  insert into public.audit_log (household_id, actor, action, object_type, object_id, before)
  values (p_household_id, jsonb_build_object('kind', 'user', 'userId', v_uid),
          'holdings.delete', 'holding', p_holding_id, v_before);
end;
$$;

-- Read model: the latest as_of snapshot per account (optionally scoped to
-- one account). "Latest" is per-account, not per-row, so a stale row from
-- an older snapshot never shows next to a fresh one for the same account.
create or replace function public.keel_list_holdings(
  p_household_id uuid,
  p_account_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  with latest as (
    select account_id, max(as_of) as as_of
      from public.holdings
     where household_id = p_household_id
       and (p_account_id is null or account_id = p_account_id)
     group by account_id
  )
  select coalesce(jsonb_agg(row order by row->>'accountId', row->>'symbol'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'holdingId', h.id,
        'accountId', h.account_id,
        'asOf', h.as_of,
        'symbol', h.symbol,
        'name', h.name,
        'qty', h.qty::text,
        'priceMinor', h.price_minor::text,
        'valueMinor', h.value_minor::text,
        'costBasisMinor', h.cost_basis_minor::text,
        'currency', h.currency,
        'source', h.source,
        'updatedAt', to_char(h.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) as row
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
      where h.household_id = p_household_id
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'holdings-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_holding_upsert(uuid, uuid, uuid, text, text, numeric, bigint, bigint) from public, anon;
grant execute on function public.keel_holding_upsert(uuid, uuid, uuid, text, text, numeric, bigint, bigint) to authenticated;

revoke all on function public.keel_holding_delete(uuid, uuid) from public, anon;
grant execute on function public.keel_holding_delete(uuid, uuid) to authenticated;

revoke all on function public.keel_list_holdings(uuid, uuid) from public, anon;
grant execute on function public.keel_list_holdings(uuid, uuid) to authenticated, service_role;
