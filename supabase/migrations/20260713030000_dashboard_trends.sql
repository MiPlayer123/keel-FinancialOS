-- Deterministic daily/monthly trend read models for the dashboard + account
-- pages. All series are computed from the ledger (bigint, per currency,
-- debit-positive — matching keel_trial_balance / keel_net_worth_as_of), so a
-- chart point is always reproducible from postings; provider balance
-- snapshots stay a reconciliation aid, not the display series.

-- Daily net worth (asset+liability running balance) per currency.
create or replace function public.keel_net_worth_daily(
  p_household_id uuid,
  p_from date,
  p_to date
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
  if p_from > p_to or p_to - p_from > 366 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  with flows as (
    select b.effective_date as d, p.currency, sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date <= p_to
        and la.kind in ('asset', 'liability')
      group by 1, 2
  ),
  currencies as (select distinct currency from flows),
  days as (
    select generate_series(
      least(p_from, coalesce((select min(d) from flows), p_from)),
      p_to, interval '1 day'
    )::date as d
  ),
  cum as (
    select g.d, g.currency,
           sum(coalesce(f.amt, 0)) over (partition by g.currency order by g.d) as bal
      from (select days.d, c.currency from days cross join currencies c) g
      left join flows f on f.d = g.d and f.currency = g.currency
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d, 'YYYY-MM-DD'),
           'currency', currency,
           'balanceMinor', bal::text
         ) order by d, currency), '[]'::jsonb)
    into v_rows
    from cum
    where d >= p_from;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-daily-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_net_worth_daily(uuid, date, date) from public, anon;
grant execute on function public.keel_net_worth_daily(uuid, date, date) to authenticated, service_role;

-- Daily ledger balance for ONE account (its cash ledger account), same
-- debit-positive convention the account list displays.
create or replace function public.keel_account_balance_daily(
  p_household_id uuid,
  p_account_id uuid,
  p_from date,
  p_to date
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
  v_ledger uuid;
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

  select ledger_account_id into v_ledger
    from public.accounts
    where id = p_account_id and household_id = p_household_id;
  if v_ledger is null then
    raise exception 'KEEL_NOT_FOUND: account' using errcode = 'P0006';
  end if;

  with flows as (
    select b.effective_date as d, p.currency, sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      where b.household_id = p_household_id
        and p.ledger_account_id = v_ledger
        and b.effective_date <= p_to
      group by 1, 2
  ),
  currencies as (select distinct currency from flows),
  days as (
    select generate_series(
      least(p_from, coalesce((select min(d) from flows), p_from)),
      p_to, interval '1 day'
    )::date as d
  ),
  cum as (
    select g.d, g.currency,
           sum(coalesce(f.amt, 0)) over (partition by g.currency order by g.d) as bal
      from (select days.d, c.currency from days cross join currencies c) g
      left join flows f on f.d = g.d and f.currency = g.currency
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(d, 'YYYY-MM-DD'),
           'currency', currency,
           'balanceMinor', bal::text
         ) order by d, currency), '[]'::jsonb)
    into v_rows
    from cum
    where d >= p_from;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'account-balance-daily-v1',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_account_balance_daily(uuid, uuid, date, date) from public, anon;
grant execute on function public.keel_account_balance_daily(uuid, uuid, date, date)
  to authenticated, service_role;

-- Monthly cash flow per currency, confirmed transfers excluded (same
-- exclusion rule as cash-flow-v2).
create or replace function public.keel_cash_flow_monthly(
  p_household_id uuid,
  p_from date,
  p_to date
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
  if p_from > p_to or p_to - p_from > 750 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'month', row->>'currency'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'month', to_char(date_trunc('month', b.effective_date), 'YYYY-MM'),
        'currency', p.currency,
        'inflowMinor', coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(p.amount_minor) filter (where la.kind = 'income'), 0)
          - coalesce(sum(p.amount_minor) filter (where la.kind = 'expense'), 0)
        )::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date between p_from and p_to
        and la.kind in ('income', 'expense')
        and not exists (
          select 1 from public.transfer_links tl
          where tl.household_id = p_household_id
            and tl.status = 'confirmed'
            and (tl.txn_out = b.canonical_transaction_id
                 or tl.txn_in = b.canonical_transaction_id)
        )
      group by date_trunc('month', b.effective_date), p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v1-transfer-excluded',
    'rows', v_rows
  );
end;
$$;

revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date)
  to authenticated, service_role;
