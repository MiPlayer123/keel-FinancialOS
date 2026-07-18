-- WS-C / FEEDBACK.md F-015 — Investments workstream, part 3 of 4.
--
-- Read models for the investments page (authenticated, member-scoped, STABLE):
--   keel_investments_overview   — investment accounts (connected + manual)
--                                 with latest balances; household holdings
--                                 (latest snapshot per account); total value;
--                                 allocation breakdown; and any per-connection
--                                 holdings sync errors (F-014 surfacing).
--   keel_investments_value_daily — total holdings value per day from
--                                 holdings_snapshots, for the value-over-time
--                                 chart. Sparse initially (one point per sync
--                                 day) and that is fine.
--
-- Reproducible numbers (Law 9): every payload carries asOf + formulaVersion.
-- All money is text (bigint never rides a JSON number).

-- Immutable SQL mirror of apps/web/src/lib/investment-subtype.ts /
-- _shared/investment-subtype.ts. Keeps the three in sync; this one decides
-- which accounts the read model surfaces. Broadened vs. the worker's
-- call-avoidance list to include 'cash management' — a brokerage
-- cash-management account IS an investment-adjacent account the user expects
-- to see on this page (the worker separately handles those by Plaid account
-- `type`, not subtype).
create or replace function public.keel_is_investment_subtype(p_subtype text)
returns boolean
language sql
immutable
as $$
  select case
    when p_subtype is null then false
    else lower(p_subtype) similar to
      '%(investment|brokerage|ira|401k|403b|roth|hsa|mutual fund|529|pension|retirement|annuity|stock plan|cash management)%'
  end;
$$;

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
    select a.id, a.name, a.subtype, a.currency, a.connection_id, a.entity_id
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
      'balanceAsOf', lb.as_of
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
      'currency', r.currency,
      'source', r.source
    ) order by r.account_name, r.symbol), '[]'::jsonb),
    coalesce(sum(r.value_minor) filter (where r.currency = 'USD'), 0)
    into v_holdings, v_total_value
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
    'formulaVersion', 'investments-overview-v1',
    'accounts', v_accounts,
    'holdings', v_holdings,
    'allocation', v_allocation,
    'holdingsErrors', v_errors,
    'totalHoldingsValueMinor', v_total_value::text,
    'totalBalanceMinor', v_total_balance::text,
    'balancesByCurrency', v_balances_by_currency,
    'holdingsValueByCurrency', v_holdings_value_by_currency,
    'currency', 'USD'
  );
end;
$$;

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
         and public.keel_is_investment_subtype(a.subtype)
       where hs.household_id = p_household_id
         and hs.currency = 'USD'
         and hs.snapshot_date between v_from and v_to
       group by hs.snapshot_date
    ) daily;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'investments-value-daily-v1',
    'from', v_from,
    'to', v_to,
    'points', v_points,
    'currency', 'USD'
  );
end;
$$;

revoke all on function public.keel_is_investment_subtype(text) from public, anon;
grant execute on function public.keel_is_investment_subtype(text) to authenticated, service_role;

revoke all on function public.keel_investments_overview(uuid) from public, anon;
grant execute on function public.keel_investments_overview(uuid) to authenticated, service_role;

revoke all on function public.keel_investments_value_daily(uuid, date, date) from public, anon;
grant execute on function public.keel_investments_value_daily(uuid, date, date) to authenticated, service_role;
