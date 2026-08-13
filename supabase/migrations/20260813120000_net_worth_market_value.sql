-- Market-value net worth for investment accounts (read-model only; no ledger
-- mutation, no data migration — fully reversible by restoring the prior bodies).
--
-- BUG (user-reported): (1) the headline net worth and the sidebar assets/
-- liabilities disagree, and (2) investment holdings are not tracked at market —
-- a brokerage buy shows as a bare negative and the account's value never moves
-- with the market.
--
-- ROOT CAUSE (investigation, live-verified 2026-08-13):
--   * Plaid `balances.current` for a brokerage is the TOTAL account value
--     (settlement cash + securities at market). `keel_apply_account_balance`
--     anchors the account's cash ledger to that total ONCE and never re-anchors,
--     so the ledger is (a) stale vs market and (b) already contains securities
--     value. Proof: `balance_snapshots.current_minor − Σ holdings market` is
--     stable to the cent day-over-day while holdings move with the market — the
--     residual is the true settlement cash.
--   * The investment-flow classifier also books each buy's offset into an
--     account-less `pfc_key='investments'` cost-basis asset ledger. Net worth
--     summed BOTH the anchored cash ledger (already incl. securities) AND that
--     cost-basis ledger → double-count. The sidebar iterates the `accounts`
--     table and never sees the account-less ledger → it silently dropped that
--     value. That gap is exactly the headline-vs-sidebar discrepancy.
--
-- FIX: value every investment-subtype account (keel_is_investment_subtype) that
-- has a Plaid balance snapshot at its LATEST snapshot `current_minor` (the
-- market total, refreshed every sync), and EXCLUDE from the ledger sum both
-- (a) those accounts' own cash ledgers and (b) the account-less
-- `pfc_key='investments'` cost-basis ledgers. Manual investment accounts with no
-- snapshot (e.g. a hand-entered Roth 401k) fall back to their ledger unchanged.
-- Non-investment accounts (checking, credit, cash) are untouched — their ledger
-- IS the register truth.
--
-- This never DECOMPOSES an account into cash+holdings (the double-count trap):
-- one authoritative number per investment account. `keel_trial_balance` stays
-- ledger-truth (the accounting view); only the net-worth read models change, so
-- the sidebar (which sums per-account balances and can adopt the same
-- market-value source in the client) and the headline converge on the identical
-- figure. Laws: reproducible numbers (Law 9 — the number is Plaid's own
-- as-of-dated snapshot), no float (Law 4 — BIGINT minor throughout).

-- keel_net_worth_as_of is SECURITY DEFINER owned by keel_api and now calls
-- keel_is_investment_subtype, which had EXECUTE only for authenticated/
-- service_role. Grant it to keel_api too (an IMMUTABLE pure helper; safe).
grant execute on function public.keel_is_investment_subtype(text) to keel_api;

-- ===========================================================================
-- keel_net_worth_as_of — single as-of total.
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
  -- Investment accounts valued by their latest Plaid snapshot on/before as-of.
  inv as (
    select a.id as account_id, a.ledger_account_id
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
       and exists (
         select 1 from public.balance_snapshots b
          where b.account_id = a.id and b.source = 'plaid'
            and (b.as_of at time zone 'utc')::date <= p_as_of
       )
  ),
  inv_value as (
    select 'USD'::text as currency,
           sum((
             select b.current_minor from public.balance_snapshots b
              where b.account_id = inv.account_id and b.source = 'plaid'
                and (b.as_of at time zone 'utc')::date <= p_as_of
              order by b.as_of desc limit 1
           ))::bigint as amt
      from inv
     having sum(1) > 0
  ),
  -- Ledger sum, EXCLUDING investment cash ledgers (replaced by the snapshot) and
  -- the account-less cost-basis Investments ledgers (subsumed by the snapshot).
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
-- keel_net_worth_daily — per-day series. Non-investment ledgers accumulate as
-- before; each investment account contributes its latest Plaid snapshot value
-- as-of that day (a step function that tracks market movement), and the
-- cost-basis Investments ledgers are excluded. Days before an investment
-- account's first snapshot contribute 0 for it (it had not synced yet).
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
          where b.account_id = a.id and b.source = 'plaid'
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
  -- Investment market value per day (USD): latest snapshot on/before each day,
  -- summed across investment accounts.
  inv_daily as (
    select days.d, 'USD'::text as currency,
           sum((
             select b.current_minor from public.balance_snapshots b
              where b.account_id = inv.account_id and b.source = 'plaid'
                and (b.as_of at time zone 'utc')::date <= days.d
              order by b.as_of desc limit 1
           ))::bigint as amt
      from days cross join inv
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
