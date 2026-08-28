create or replace function public.keel_net_worth_as_of(
  p_household_id uuid,
  p_as_of date
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_rows jsonb;
  v_cutoff timestamptz := ((p_as_of + 1)::timestamp at time zone 'utc');
begin
  if v_uid is null then
    raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004';
  end if;
  if not exists (
    select 1
      from public.household_memberships m
     where m.household_id = p_household_id
       and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  with inv as (
    select a.id as account_id, a.ledger_account_id
      from public.accounts a
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
       and exists (
         select 1
           from public.balance_snapshots b
          where b.household_id = p_household_id
            and b.account_id = a.id
            and b.source = 'plaid'
            and b.as_of < v_cutoff
       )
  ),
  inv_value as (
    select latest.currency, sum(latest.current_minor)::bigint as amt
      from inv
      cross join lateral (
        select b.currency, b.current_minor
          from public.balance_snapshots b
         where b.household_id = p_household_id
           and b.account_id = inv.account_id
           and b.source = 'plaid'
           and b.as_of < v_cutoff
         order by b.as_of desc, b.id desc
         limit 1
      ) latest
     group by latest.currency
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
         select 1
           from public.accounts a
          where a.ledger_account_id = p.ledger_account_id
            and a.archived_at is not null
       )
       and not exists (
         select 1
           from inv
          where inv.ledger_account_id = p.ledger_account_id
       )
     group by p.currency
  ),
  combined as (
    select currency, amt from ledger
    union all
    select currency, amt from inv_value
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', currency,
        'netWorthMinor', total::text
      )
      order by currency
    ),
    '[]'::jsonb
  )
    into v_rows
    from (
      select currency, sum(amt)::bigint as total
        from combined
       group by currency
    ) totals;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-market-v2',
    'rows', v_rows
  );
end;
$$;

create or replace function public.keel_net_worth_daily(
  p_household_id uuid,
  p_from date,
  p_to date
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
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
    select 1
      from public.household_memberships m
     where m.household_id = p_household_id
       and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;
  if p_from > p_to or p_to - p_from > 366 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  with inv as (
    select a.id as account_id,
           a.ledger_account_id,
           latest.currency as latest_currency
      from public.accounts a
      cross join lateral (
        select b.currency
          from public.balance_snapshots b
         where b.household_id = p_household_id
           and b.account_id = a.id
           and b.source = 'plaid'
           and b.as_of < ((p_to + 1)::timestamp at time zone 'utc')
         order by b.as_of desc, b.id desc
         limit 1
      ) latest
     where a.household_id = p_household_id
       and a.archived_at is null
       and public.keel_is_investment_subtype(a.subtype)
  ),
  flows as (
    select
      case
        when b.canonical_transaction_id is null then least(b.effective_date, p_from)
        else b.effective_date
      end as d,
      p.currency,
      sum(p.amount_minor)::bigint as amt
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
     where b.household_id = p_household_id
       and b.effective_date <= p_to
       and la.kind in ('asset', 'liability')
       and la.pfc_key is distinct from 'investments'
       and not exists (
         select 1
           from public.accounts a
          where a.ledger_account_id = p.ledger_account_id
            and a.archived_at is not null
       )
       and not exists (
         select 1
           from inv
          where inv.ledger_account_id = p.ledger_account_id
       )
     group by 1, 2
  ),
  days as (
    select generate_series(
      least(p_from, coalesce((select min(d) from flows), p_from)),
      p_to,
      interval '1 day'
    )::date as d
  ),
  inv_daily as (
    select days.d,
           latest.currency,
           sum(latest.current_minor)::bigint as amt
      from days
      cross join inv
      cross join lateral (
        select b.currency, b.current_minor
          from public.balance_snapshots b
         where b.household_id = p_household_id
           and b.account_id = inv.account_id
           and b.source = 'plaid'
           and b.as_of < ((days.d + 1)::timestamp at time zone 'utc')
         order by b.as_of desc, b.id desc
         limit 1
      ) latest
     where days.d >= p_from
     group by days.d, latest.currency
  ),
  currencies as (
    select currency from flows
    union
    select latest_currency from inv
    union
    select currency from inv_daily
  ),
  cum as (
    select grid.d,
           grid.currency,
           sum(coalesce(flows.amt, 0))
             over (partition by grid.currency order by grid.d) as bal
      from (
        select days.d, currencies.currency
          from days
          cross join (select distinct currency from currencies) currencies
      ) grid
      left join flows
        on flows.d = grid.d
       and flows.currency = grid.currency
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(result.d, 'YYYY-MM-DD'),
        'currency', result.currency,
        'balanceMinor', (result.bal + result.inv)::text
      )
      order by result.d, result.currency
    ),
    '[]'::jsonb
  )
    into v_rows
    from (
      select cum.d,
             cum.currency,
             cum.bal,
             coalesce(inv_daily.amt, 0)::bigint as inv
        from cum
        left join inv_daily
          on inv_daily.d = cum.d
         and inv_daily.currency = cum.currency
       where cum.d >= p_from
    ) result;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'net-worth-daily-market-v2',
    'rows', v_rows
  );
end;
$$;

grant execute on function public.keel_is_investment_subtype(text) to keel_api;

grant create on schema public to keel_api;
alter function public.keel_net_worth_as_of(uuid, date) owner to keel_api;
revoke create on schema public from keel_api;

alter function public.keel_net_worth_daily(uuid, date, date) owner to postgres;

revoke all on function public.keel_net_worth_as_of(uuid, date) from public, anon;
grant execute on function public.keel_net_worth_as_of(uuid, date) to authenticated, service_role;

revoke all on function public.keel_net_worth_daily(uuid, date, date) from public, anon;
grant execute on function public.keel_net_worth_daily(uuid, date, date)
  to authenticated, service_role;
