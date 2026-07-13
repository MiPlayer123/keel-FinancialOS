-- Cash-flow projection (Law 10 Class C: preview-only — a read model, never a
-- write). Deterministic inputs only: current CASH balance (checking/savings/
-- cash asset accounts — manual property/vehicle assets must NOT enter the
-- runway) plus CONFIRMED recurring occurrences inside the window. Recurring
-- series that look like internal transfers (any matched occurrence sits in a
-- confirmed transfer link) are excluded — the same no-double-count rule as
-- cash-flow-v2, applied to the future. Reproducible numbers: envelope pins
-- scope, asOf, formulaVersion, and per-bill seriesId evidence (invariant 7).

create or replace function public.keel_cash_flow_forecast(
  p_household_id uuid,
  p_days integer default 30
) returns jsonb
language plpgsql
security definer
set search_path = public
-- volatile (default): the proc materializes a temp table; CREATE TEMP TABLE
-- is not allowed in a STABLE function. It performs no durable writes.
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_daily jsonb;
  v_bills jsonb;
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
  if p_days < 1 or p_days > 120 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  create temporary table _fc_bills on commit drop as
  select ro.expected_date, ro.expected_amount_minor, ro.currency,
         rs.sign, rs.id as series_id, rs.counterparty_key
    from public.recurring_occurrences ro
    join public.recurring_series rs on rs.id = ro.series_id
    where ro.household_id = p_household_id
      and rs.status = 'confirmed'
      and ro.candidate_version_id = rs.current_candidate_version_id
      and ro.status = 'expected'
      and ro.expected_date > current_date
      and ro.expected_date <= current_date + p_days
      and not exists (
        select 1
          from public.recurring_occurrences ro2
          join public.transfer_links tl
            on tl.status = 'confirmed'
           and (tl.txn_out = ro2.matched_txn_id or tl.txn_in = ro2.matched_txn_id)
          where ro2.series_id = rs.id and ro2.matched_txn_id is not null
      );

  with cash_accounts as (
    select a.ledger_account_id
      from public.accounts a
      join public.ledger_accounts la on la.id = a.ledger_account_id
      where a.household_id = p_household_id
        and la.kind = 'asset'
        and a.subtype in ('checking', 'savings', 'cash')
        and a.archived_at is null
  ),
  base as (
    select p.currency, coalesce(sum(p.amount_minor), 0)::bigint as bal
      from public.journal_postings p
      join cash_accounts ca on ca.ledger_account_id = p.ledger_account_id
      join public.journal_batches b on b.id = p.batch_id
      where b.household_id = p_household_id
      group by p.currency
  ),
  days as (
    select generate_series(current_date, current_date + p_days, interval '1 day')::date as d
  ),
  daily as (
    select d.d, b.currency,
           b.bal + coalesce((
             select sum(case when bi.sign = 'outflow'
                             then -bi.expected_amount_minor
                             else bi.expected_amount_minor end)
               from _fc_bills bi
               where bi.currency = b.currency and bi.expected_date <= d.d
           ), 0)::bigint as projected
      from days d
      cross join base b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d, 'YYYY-MM-DD'),
           'currency', currency,
           'balanceMinor', projected::text
         ) order by d, currency), '[]'::jsonb)
    into v_daily
    from daily;

  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(expected_date, 'YYYY-MM-DD'),
           'seriesId', series_id,
           'name', counterparty_key,
           'sign', sign,
           'amountMinor', expected_amount_minor::text,
           'currency', currency
         ) order by expected_date, series_id), '[]'::jsonb)
    into v_bills
    from _fc_bills;

  return jsonb_build_object(
    'scope', jsonb_build_object(
      'householdId', p_household_id,
      'days', p_days,
      'accountScope', 'cash: checking, savings, cash subtypes',
      'exclusions', 'suggested/paused/cancelled series; transfer-linked series'
    ),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-forecast-v1-preview',
    'rows', v_daily,
    'bills', v_bills
  );
end;
$$;

revoke all on function public.keel_cash_flow_forecast(uuid, integer) from public, anon;
grant execute on function public.keel_cash_flow_forecast(uuid, integer) to authenticated, service_role;
