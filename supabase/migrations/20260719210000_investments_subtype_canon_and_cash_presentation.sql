-- Investments backlog (2026-07-19): subtype canon + cash-only presentation.
--
-- ITEM 1 — one canonical "is this an investment account" list. The old
-- keel_is_investment_subtype was a 14-keyword substring match that missed
-- most of Plaid's published investment subtypes (crypto exchange, trust,
-- 401a, 457b, sep/simple ira via luck only, tfsa/rrsp/resp, education
-- savings account, thrift savings plan, ugma/utma, …). New shape, mirrored
-- byte-for-byte in apps/web/src/lib/investment-subtype.ts and
-- supabase/functions/_shared/investment-subtype.ts:
--   exact match against the full Plaid investment subtype set
--   ∪ the existing keyword fallback (manual/free-text subtypes)
--   ∪ 'cash management' (display tier only — the 20260718122000 ruling; the
--     worker's provider-call tier still excludes it, in TS, not here).
-- Strictly a SUPERSET of the old predicate: no account previously on the
-- investments surfaces drops off. Plaid subtype 'other' is deliberately NOT
-- matched: with only the subtype stored it is ambiguous across Plaid types
-- and would misclassify e.g. type=other accounts; the worker catches live
-- type=investment 'other' accounts via Plaid's `type` field.
--
-- ITEM 2 — honest cash-only vs awaiting-provider presentation. The holdings
-- mapper deliberately skips cash-equivalent securities (SPAXX/money market,
-- reason 'cash_equivalent'), so an all-cash brokerage and a brokerage whose
-- institution has not yet published positions (Fidelity populates
-- Investments asynchronously) both land as zero holdings rows —
-- indistinguishable, and the UI showed nothing for either. Persist the
-- per-account provider counts from each holdings sync (Law 9: the exclusion
-- becomes a surfaced fact, never an inferred one):
--   accounts.holdings_provider_count         rows Plaid reported (pre-skip)
--   accounts.holdings_cash_equivalent_count  rows skipped as cash-equivalent
--   accounts.holdings_synced_at              when the counts were captured
-- keel_worker_sync_holdings grows an optional p_account_stats param (old
-- 3-arg signature dropped — a defaulted 4th arg would leave an ambiguous
-- overload); keel_investments_overview emits the three fields per account
-- (formulaVersion investments-overview-v3). keel_investments_value_daily is
-- re-issued only to bump its formulaVersion (investments-value-daily-v2):
-- its numbers can change under the broadened subtype set (Law 9).

-- ---------------------------------------------------------------------------
-- 1. Canonical subtype classifier (same signature, still IMMUTABLE).
-- ---------------------------------------------------------------------------
create or replace function public.keel_is_investment_subtype(p_subtype text)
returns boolean
language sql
immutable
as $$
  select case
    when p_subtype is null then false
    else
      lower(btrim(p_subtype)) = any (array[
        '529', '401a', '401k', '403b', '457b', 'brokerage', 'cash isa',
        'crypto exchange', 'education savings account', 'fixed annuity',
        'gic', 'health reimbursement arrangement', 'hsa', 'isa', 'ira',
        'keogh', 'lif', 'life insurance', 'lira', 'lrif', 'lrsp',
        'mutual fund', 'non-custodial wallet', 'non-taxable brokerage account',
        'other annuity', 'other insurance', 'pension', 'prif',
        'profit sharing plan', 'qshr', 'rdsp', 'resp', 'retirement', 'rlif',
        'roth', 'roth 401k', 'rrif', 'rrsp', 'sarsep', 'sep ira',
        'simple ira', 'sipp', 'stock plan', 'tfsa', 'thrift savings plan',
        'trust', 'ugma', 'utma', 'variable annuity',
        'cash management'
      ])
      or lower(p_subtype) similar to
        '%(investment|brokerage|ira|401k|403b|roth|hsa|mutual fund|529|pension|retirement|annuity|stock plan|cash management)%'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Per-account holdings-sync stats (nullable — null means "no holdings
--    sync has reported counts for this account yet", which is exactly the
--    honest awaiting-provider state; never backfilled with fabricated 0s).
-- ---------------------------------------------------------------------------
alter table public.accounts add column if not exists holdings_provider_count integer;
alter table public.accounts add column if not exists holdings_cash_equivalent_count integer;
alter table public.accounts add column if not exists holdings_synced_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. keel_worker_sync_holdings: accept per-account provider stats. The old
--    (uuid, uuid, jsonb) signature is DROPPED (not overloaded) so a 3-arg
--    call can never be ambiguous; the worker deploy that calls the 4-arg
--    shape ships with this migration.
-- ---------------------------------------------------------------------------
drop function if exists public.keel_worker_sync_holdings(uuid, uuid, jsonb);

create function public.keel_worker_sync_holdings(
  p_household_id uuid,
  p_connection_id uuid,
  p_holdings jsonb,
  p_account_stats jsonb default null
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

  insert into public.holdings
    (household_id, account_id, as_of, symbol, name, qty, price_minor, value_minor,
     cost_basis_minor, currency, source, security_type)
  select
    p_household_id,
    a.id,
    current_date,
    upper(btrim(h->>'symbol')),
    nullif(btrim(h->>'name'), ''),
    (h->>'qty')::numeric,
    (h->>'priceMinor')::bigint,
    round((h->>'qty')::numeric * (h->>'priceMinor')::bigint)::bigint,
    nullif(h->>'costBasisMinor', '')::bigint,
    coalesce(nullif(h->>'currency', ''), 'USD'),
    'plaid',
    nullif(h->>'securityType', '')
    from jsonb_array_elements(p_holdings) h
    join public.accounts a
      on a.external_ref = h->>'accountExternalRef'
     and a.household_id = p_household_id
     and a.connection_id = p_connection_id
  on conflict (account_id, symbol, source) do update
    set name = excluded.name, qty = excluded.qty, price_minor = excluded.price_minor,
        value_minor = excluded.value_minor, cost_basis_minor = excluded.cost_basis_minor,
        currency = excluded.currency, as_of = excluded.as_of,
        security_type = excluded.security_type, updated_at = now();
  get diagnostics v_count = row_count;

  delete from public.holdings h
   where h.source = 'plaid'
     and h.account_id in (
       select id from public.accounts
        where connection_id = p_connection_id and household_id = p_household_id
     )
     and not exists (
       select 1
         from jsonb_array_elements(p_holdings) e
         join public.accounts a2
           on a2.external_ref = e->>'accountExternalRef'
          and a2.household_id = p_household_id
          and a2.connection_id = p_connection_id
        where a2.id = h.account_id and upper(btrim(e->>'symbol')) = h.symbol
     );

  -- Per-account provider stats (Item 2): what Plaid reported BEFORE the
  -- mapper's skips, so "all my positions are cash-equivalent" is a stored
  -- fact, not a guess. Only accounts named in the payload are touched —
  -- accounts on other connections (or manual ones) keep their state.
  if p_account_stats is not null then
    update public.accounts a
       set holdings_provider_count = nullif(s->>'providerCount', '')::int,
           holdings_cash_equivalent_count = nullif(s->>'cashEquivalentCount', '')::int,
           holdings_synced_at = now()
      from jsonb_array_elements(p_account_stats) s
     where a.external_ref = s->>'externalRef'
       and a.household_id = p_household_id
       and a.connection_id = p_connection_id;
  end if;

  return v_count;
end;
$$;

revoke all on function public.keel_worker_sync_holdings(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.keel_worker_sync_holdings(uuid, uuid, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. keel_investments_overview v3 — byte-identical to v2 (20260719100000)
--    except: the account rows carry the three holdings-sync stat fields, and
--    formulaVersion bumps to investments-overview-v3.
-- ---------------------------------------------------------------------------
create or replace function public.keel_investments_overview(p_household_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_accounts jsonb;
  v_holdings jsonb;
  v_allocation jsonb;
  v_errors jsonb;
  v_total_value bigint;
  v_total_balance bigint;
  v_balances_by_currency jsonb;
  v_holdings_value_by_currency jsonb;
  v_total_cost_basis bigint;
  v_total_unrealized_gain bigint;
  v_holdings_with_basis_count int;
  v_holdings_count int;
begin
  -- Fail CLOSED (mirrors keel_list_holdings): a missing JWT subject is a hard
  -- authentication failure, never an implicit service bypass. A real service
  -- path uses service_role (which bypasses RLS entirely and does not call this
  -- read model), so there is no legitimate null-subject caller here.
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  -- Investment accounts (connected + manual) with their latest balance.
  with inv_accounts as (
    select a.id, a.name, a.subtype, a.currency, a.connection_id, a.entity_id,
           a.holdings_provider_count, a.holdings_cash_equivalent_count,
           a.holdings_synced_at
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest_bal as (
    select distinct on (bs.account_id)
           bs.account_id, bs.current_minor, bs.available_minor, bs.as_of
      from public.balance_snapshots bs
      join inv_accounts ia on ia.id = bs.account_id
     where bs.household_id = p_household_id
     order by bs.account_id, bs.as_of desc
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'accountId', ia.id,
      'name', ia.name,
      'subtype', ia.subtype,
      'currency', ia.currency,
      'isManual', ia.connection_id is null,
      'connectionId', ia.connection_id,
      'currentMinor', coalesce(lb.current_minor, 0)::text,
      'availableMinor', lb.available_minor::text,
      'balanceAsOf', lb.as_of,
      -- Holdings-sync stats (Item 2): what the provider reported at the last
      -- holdings sync. All three are null until a sync has captured them —
      -- null means "unknown", never a fabricated 0 (Law 9).
      'holdingsProviderCount', ia.holdings_provider_count,
      'holdingsCashEquivalentCount', ia.holdings_cash_equivalent_count,
      'holdingsSyncedAt', to_char(ia.holdings_synced_at at time zone 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    ) order by ia.name), '[]'::jsonb),
    -- USD-only headline total: mixing currencies into one integer and calling
    -- it USD is wrong (no FX here). Non-USD balances are surfaced separately in
    -- balancesByCurrency below, never fabricated into the USD figure.
    coalesce(sum(coalesce(lb.current_minor, 0)) filter (where ia.currency = 'USD'), 0)
    into v_accounts, v_total_balance
    from inv_accounts ia
    left join latest_bal lb on lb.account_id = ia.id;

  -- Per-currency account-balance totals (one row per currency actually held),
  -- so the UI renders each group in its own currency rather than a fabricated
  -- global USD sum.
  with inv_accounts as (
    select a.id, a.currency
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest_bal as (
    select distinct on (bs.account_id)
           bs.account_id, bs.current_minor
      from public.balance_snapshots bs
      join inv_accounts ia on ia.id = bs.account_id
     where bs.household_id = p_household_id
     order by bs.account_id, bs.as_of desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', currency,
           'totalMinor', total::text
         ) order by currency), '[]'::jsonb)
    into v_balances_by_currency
    from (
      select ia.currency, coalesce(sum(coalesce(lb.current_minor, 0)), 0) as total
        from inv_accounts ia
        left join latest_bal lb on lb.account_id = ia.id
       group by ia.currency
    ) g;

  -- Household holdings: latest as_of snapshot per account (same "latest per
  -- account" rule as keel_list_holdings), across investment accounts only.
  with inv_accounts as (
    select a.id, a.name
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.*, ia.name as account_name
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'holdingId', r.id,
      'accountId', r.account_id,
      'accountName', r.account_name,
      'asOf', r.as_of,
      'symbol', r.symbol,
      'name', r.name,
      'qty', r.qty::text,
      'priceMinor', r.price_minor::text,
      'valueMinor', r.value_minor::text,
      'costBasisMinor', r.cost_basis_minor::text,
      -- Unrealized gain/loss (Law 9 derived fact): value − basis. A missing
      -- basis stays JSON null; it is NEVER coerced to a fabricated 0 gain.
      'unrealizedGainMinor', (case
        when r.cost_basis_minor is null then null
        else (r.value_minor - r.cost_basis_minor)
      end)::text,
      -- Integer basis points ((value − basis) / basis × 10000). Guards BOTH a
      -- null basis and a zero basis (no divide-by-zero raise).
      'unrealizedGainBps', (case
        when r.cost_basis_minor is null or r.cost_basis_minor = 0 then null
        else round((r.value_minor - r.cost_basis_minor) * 10000.0 / r.cost_basis_minor)::bigint
      end)::text,
      'currency', r.currency,
      'source', r.source
    ) order by r.account_name, r.symbol), '[]'::jsonb),
    coalesce(sum(r.value_minor) filter (where r.currency = 'USD'), 0),
    -- USD-only portfolio aggregates. Null-basis rows are excluded from BOTH the
    -- cost total and the gain total so the gain is measured over the same
    -- with-basis subset (never a full-value total against a partial-cost total).
    -- Coalesced to 0 (mirrors the totalHoldingsValueMinor pattern above): an
    -- empty with-basis subset is $0 of tracked basis, which the surfaced
    -- holdingsWithBasisCount=0 already qualifies — the UI gates on that count,
    -- never on a magic-number total.
    coalesce(sum(r.cost_basis_minor) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null), 0),
    coalesce(sum(r.value_minor - r.cost_basis_minor) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null), 0),
    count(*) filter (
      where r.currency = 'USD' and r.cost_basis_minor is not null),
    count(*) filter (where r.currency = 'USD')
    into
      v_holdings, v_total_value, v_total_cost_basis, v_total_unrealized_gain,
      v_holdings_with_basis_count, v_holdings_count
    from rows r;

  -- Per-currency holdings-value totals (parallels balancesByCurrency). The
  -- USD-only headline stays in totalHoldingsValueMinor; this array carries the
  -- rest honestly rather than folding non-USD into the USD number.
  with inv_accounts as (
    select a.id from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.currency, h.value_minor
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
     where h.household_id = p_household_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', currency,
           'valueMinor', total::text
         ) order by currency), '[]'::jsonb)
    into v_holdings_value_by_currency
    from (
      select currency, sum(value_minor) as total from rows group by currency
    ) g;

  -- Allocation breakdown by symbol (USD only; largest first). A symbol-level
  -- breakdown is the reproducible baseline; the web layer can further bucket
  -- by asset class using its holdings-allocation lib.
  with inv_accounts as (
    select a.id from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  latest as (
    select h.account_id, max(h.as_of) as as_of
      from public.holdings h
      join inv_accounts ia on ia.id = h.account_id
     where h.household_id = p_household_id
     group by h.account_id
  ),
  rows as (
    select h.symbol, h.name, h.value_minor
      from public.holdings h
      join latest l on l.account_id = h.account_id and l.as_of = h.as_of
     where h.household_id = p_household_id and h.currency = 'USD'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', symbol,
           'name', name,
           'valueMinor', total::text
         ) order by total desc), '[]'::jsonb)
    into v_allocation
    from (
      select symbol, max(name) as name, sum(value_minor) as total
        from rows group by symbol
    ) g;

  -- Holdings sync errors (F-014): any active connection currently carrying an
  -- unresolved holdings error. This is what tells the user to re-link.
  select coalesce(jsonb_agg(jsonb_build_object(
           'connectionId', c.id,
           'displayName', coalesce(c.display_name, c.institution_id),
           'errorCode', c.holdings_last_error_code,
           'errorMessage', c.holdings_last_error_message,
           'errorAt', to_char(c.holdings_last_error_at at time zone 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         ) order by c.holdings_last_error_at desc), '[]'::jsonb)
    into v_errors
    from public.connections c
   where c.household_id = p_household_id
     and c.status <> 'disconnected'
     and c.holdings_last_error_code is not null;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'investments-overview-v3',
    'accounts', v_accounts,
    'holdings', v_holdings,
    'allocation', v_allocation,
    'holdingsErrors', v_errors,
    'totalHoldingsValueMinor', v_total_value::text,
    'totalBalanceMinor', v_total_balance::text,
    -- USD-only portfolio cost/gain over the with-basis subset. holdingsWithBasisCount
    -- < holdingsCount is the SURFACED exclusion (Law 9) the UI must show prominently.
    'totalCostBasisMinor', v_total_cost_basis::text,
    'totalUnrealizedGainMinor', v_total_unrealized_gain::text,
    'holdingsWithBasisCount', coalesce(v_holdings_with_basis_count, 0),
    'holdingsCount', coalesce(v_holdings_count, 0),
    'balancesByCurrency', v_balances_by_currency,
    'holdingsValueByCurrency', v_holdings_value_by_currency,
    'currency', 'USD'
  );
end;
$$;

revoke all on function public.keel_investments_overview(uuid) from public, anon;
grant execute on function public.keel_investments_overview(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. keel_investments_value_daily v2 — byte-identical to the 20260719130000
--    definition except the formulaVersion bump: the broadened subtype set can
--    change which accounts' snapshots contribute (Law 9: new inputs, new
--    formula version).
-- ---------------------------------------------------------------------------
create or replace function public.keel_investments_value_daily(
  p_household_id uuid,
  p_from date default null,
  p_to date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_from date := coalesce(p_from, current_date - 365);
  v_to date := coalesce(p_to, current_date);
  v_points jsonb;
begin
  -- Fail CLOSED (mirrors keel_list_holdings): missing subject = hard auth error.
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  -- Sum USD holdings value per snapshot day across investment accounts.
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', snapshot_date,
           'valueMinor', total::text
         ) order by snapshot_date), '[]'::jsonb)
    into v_points
    from (
      select hs.snapshot_date, sum(hs.value_minor) as total
        from public.holdings_snapshots hs
        join public.accounts a
          on a.id = hs.account_id
         and a.archived_at is null
         and public.keel_is_investment_subtype(a.subtype)
       where hs.household_id = p_household_id
         and hs.currency = 'USD'
         and hs.snapshot_date between v_from and v_to
       group by hs.snapshot_date
    ) daily;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'investments-value-daily-v2',
    'from', v_from,
    'to', v_to,
    'points', v_points,
    'currency', 'USD'
  );
end;
$$;

revoke all on function public.keel_investments_value_daily(uuid, date, date) from public, anon;
grant execute on function public.keel_investments_value_daily(uuid, date, date) to authenticated, service_role;
