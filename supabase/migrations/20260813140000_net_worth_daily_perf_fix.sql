-- Perf fix for the market-value net-worth read models (20260813120000).
--
-- DEFECT (caught in adversarial review before PR merge, live-measured):
-- keel_net_worth_daily took ~42s on the founder household and was killed by
-- the `authenticated` role's 8s statement_timeout — breaking the dashboard
-- net-worth trend (NetWorthHero fetches a 365-day window through
-- dashboard.net_worth_daily). Two compounding causes:
--   1. `inv_daily` was computed as `days CROSS JOIN inv` over the FULL days
--      CTE, which starts at min(flows.d) — 2021 on live (~1,830 days × 3
--      accounts ≈ 5,500 correlated subqueries) — even though the output
--      filters to d >= p_from at the end.
--   2. The correlated latest-snapshot subqueries omitted household_id and used
--      a non-sargable bound (`(b.as_of at time zone 'utc')::date <= d`), so
--      the only index — balance_snapshots(household_id, account_id, as_of
--      DESC) — couldn't serve an ordered probe: every execution scanned
--      ~12k rows and top-N sorted.
--
-- FIX: bound inv_daily to days >= p_from (pre-window contributions were
-- discarded anyway), add the household_id predicate, and make the as-of bound
-- sargable (`b.as_of < (day + 1) at UTC midnight` — equivalent to
-- `(as_of at time zone 'utc')::date <= day` for timestamptz), so each lookup
-- is a single backward index probe. Formula semantics are UNCHANGED — same
-- numbers, same JSON shape, same formulaVersion values as 20260813120000.

-- ===========================================================================
-- keel_net_worth_as_of
-- ===========================================================================
create or replace function public.keel_net_worth_as_of(p_household_id uuid, p_as_of date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
  -- Exclusive upper bound: snapshots strictly before the next UTC midnight are
  -- "on or before p_as_of" in UTC-date terms. Sargable against the
  -- (household_id, account_id, as_of DESC) index.
  v_cutoff timestamptz := ((p_as_of + 1)::timestamp at time zone 'utc');
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

  with
  inv as (
    select a.id as account_id, a.ledger_account_id
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
       and exists (
         select 1 from public.balance_snapshots b
          where b.household_id = p_household_id
            and b.account_id = a.id and b.source = 'plaid'
            and b.as_of < v_cutoff
       )
  ),
  inv_value as (
    select 'USD'::text as currency,
           sum((
             select b.current_minor from public.balance_snapshots b
              where b.household_id = p_household_id
                and b.account_id = inv.account_id and b.source = 'plaid'
                and b.as_of < v_cutoff
              order by b.as_of desc limit 1
           ))::bigint as amt
      from inv
     having sum(1) > 0
  ),
  ledger as (
    select p.currency, sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
     where b.household_id = p_household_id
       and b.effective_date <= p_as_of
       and la.kind in ('asset', 'liability')
       and la.pfc_key is distinct from 'investments'
       and not exists (
         select 1 from public.accounts a
          where a.ledger_account_id = p.ledger_account_id and a.archived_at is not null
       )
       and not exists (
         select 1 from inv where inv.ledger_account_id = p.ledger_account_id
       )
     group by p.currency
  ),
  combined as (
    select currency, amt from ledger
    union all
    select currency, amt from inv_value where amt is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'currency', currency,
           'netWorthMinor', total::text
         ) order by currency), '[]'::jsonb)
    into v_rows
    from (
      select currency, sum(amt)::bigint as total
        from combined
       group by currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-market-v1',
    'rows', v_rows
  );
end;
$function$;

-- ===========================================================================
-- keel_net_worth_daily
-- ===========================================================================
create or replace function public.keel_net_worth_daily(p_household_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
  if p_from > p_to or p_to - p_from > 366 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  with
  inv as (
    select a.id as account_id, a.ledger_account_id
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
       and exists (
         select 1 from public.balance_snapshots b
          where b.household_id = p_household_id
            and b.account_id = a.id and b.source = 'plaid'
       )
  ),
  flows as (
    select
      case when b.canonical_transaction_id is null
           then least(b.effective_date, p_from)
           else b.effective_date end as d,
      p.currency, sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date <= p_to
        and la.kind in ('asset', 'liability')
        and la.pfc_key is distinct from 'investments'
        and not exists (
          select 1 from public.accounts a
           where a.ledger_account_id = p.ledger_account_id and a.archived_at is not null
        )
        and not exists (
          select 1 from inv where inv.ledger_account_id = p.ledger_account_id
        )
      group by 1, 2
  ),
  currencies as (
    select currency from flows
    union
    select 'USD' where exists (select 1 from inv)
  ),
  days as (
    select generate_series(
      least(p_from, coalesce((select min(d) from flows), p_from)),
      p_to, interval '1 day'
    )::date as d
  ),
  cum as (
    select g.d, g.currency,
           sum(coalesce(f.amt, 0)) over (partition by g.currency order by g.d) as bal
      from (select days.d, c.currency from days cross join (select distinct currency from currencies) c) g
      left join flows f on f.d = g.d and f.currency = g.currency
  ),
  -- Latest snapshot value per (visible day × investment account). Bounded to
  -- the OUTPUT window (d >= p_from) — pre-window days only feed the flows
  -- cumsum, whose investment contribution is discarded anyway — and probed via
  -- the (household_id, account_id, as_of DESC) index (sargable bound).
  inv_daily as (
    select days.d, 'USD'::text as currency,
           sum((
             select b.current_minor from public.balance_snapshots b
              where b.household_id = p_household_id
                and b.account_id = inv.account_id and b.source = 'plaid'
                and b.as_of < ((days.d + 1)::timestamp at time zone 'utc')
              order by b.as_of desc limit 1
           ))::bigint as amt
      from days cross join inv
     where days.d >= p_from
     group by days.d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(x.d, 'YYYY-MM-DD'),
           'currency', x.currency,
           'balanceMinor', (x.bal + x.inv)::text
         ) order by x.d, x.currency), '[]'::jsonb)
    into v_rows
    from (
      select cum.d, cum.currency, cum.bal,
             coalesce(id.amt, 0)::bigint as inv
        from cum
        left join inv_daily id on id.d = cum.d and id.currency = cum.currency
       where cum.d >= p_from
    ) x;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-daily-market-v1',
    'rows', v_rows
  );
end;
$function$;
