-- Balance read models must count ONLY current active (non-archived) accounts.
-- (User-authorized 2026-07-19. Seven invariants: reproducible numbers /
-- scope-safe calculation — "active accounts only" is a durable scope rule, not
-- a one-off patch.)
--
-- Root cause: every read model that sums asset/liability postings did so over
-- journal_postings without ever checking accounts.archived_at, so a
-- disconnect+reconnect (which archives the old account and books a fresh
-- opening anchor on the new one) double- or triple-counted the same real
-- balance. The companion migration 20260719120000 soft-archives the last stale
-- Fidelity duplicate (a08bc4aa); this migration makes the read models durably
-- ignore ANY archived account's postings so the class of bug cannot recur.
--
-- Filter shape (LEFT-JOIN-safe): drop a posting only when its ledger account
-- belongs to an ARCHIVED account. Equity legs ("Opening Balances") and any
-- account-less / manual ledger legs have NO row in public.accounts for their
-- ledger_account_id, so `not exists (... archived_at is not null)` keeps them —
-- it never over-excludes. (A plain join to accounts would have wrongly dropped
-- the equity leg and unbalanced the read model.)
--
-- Approach is a READ-MODEL FILTER only: no ledger posting is reversed, mutated,
-- or rewritten (Law 2 reversible correction / Law 3 balanced postings). The
-- archived accounts' postings remain intact and exportable; they simply stop
-- contributing to displayed balances.
--
-- Each function below is CREATE OR REPLACE'd from its exact CURRENT live
-- definition (pg_get_functiondef, 2026-07-19) with ONLY the archived-account
-- filter added — signature byte-identical, body otherwise verbatim. Ownership
-- and grants are re-asserted exactly as they exist live (owners and grantees
-- differ per function due to historical drift; do NOT normalize them here).

-- ---------------------------------------------------------------------------
-- 1. keel_net_worth_as_of  (owner keel_api; grants authenticated, service_role)
-- ---------------------------------------------------------------------------
create or replace function public.keel_net_worth_as_of(p_household_id uuid, p_as_of date)
  returns jsonb
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

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', p.currency,
        'netWorthMinor', sum(p.amount_minor)::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      join public.ledger_accounts la on la.id = p.ledger_account_id
      where b.household_id = p_household_id
        and b.effective_date <= p_as_of
        and la.kind in ('asset', 'liability')
        and not exists (
          select 1 from public.accounts a
           where a.ledger_account_id = p.ledger_account_id
             and a.archived_at is not null
        )
      group by p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_net_worth_as_of(uuid, date) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_net_worth_as_of(uuid, date) from public, anon;
grant execute on function public.keel_net_worth_as_of(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. keel_net_worth_daily  (owner postgres; grants authenticated, service_role)
-- ---------------------------------------------------------------------------
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
        and not exists (
          select 1 from public.accounts a
           where a.ledger_account_id = p.ledger_account_id
             and a.archived_at is not null
        )
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

-- ---------------------------------------------------------------------------
-- 3. keel_trial_balance  (owner keel_api; grants authenticated, service_role)
--    Emits per-ledger_account rows; exclude ledger accounts belonging to an
--    archived account (equity / account-less legs are kept by NOT EXISTS).
-- ---------------------------------------------------------------------------
create or replace function public.keel_trial_balance(p_household_id uuid) returns jsonb
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

  select coalesce(jsonb_agg(row order by row->>'ledgerAccountId'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'ledgerAccountId', p.ledger_account_id,
        'currency', p.currency,
        'balanceMinor', sum(p.amount_minor)::text
      ) as row
      from public.journal_postings p
      join public.journal_batches b on b.id = p.batch_id
      where b.household_id = p_household_id
        and not exists (
          select 1 from public.accounts a
           where a.ledger_account_id = p.ledger_account_id
             and a.archived_at is not null
        )
      group by p.ledger_account_id, p.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'rows', v_rows
  );
end;
$$;

grant create on schema public to keel_api;
alter function public.keel_trial_balance(uuid) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_trial_balance(uuid) from public, anon;
grant execute on function public.keel_trial_balance(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. keel_latest_balances  (owner postgres; grants authenticated, service_role)
--    balance_snapshots-based: filter on account_id directly — exclude accounts
--    that are archived. (LIVE definition is plpgsql and includes limit_minor;
--    preserved verbatim, filter added in the inner select.)
-- ---------------------------------------------------------------------------
create or replace function public.keel_latest_balances(p_household_id uuid)
returns jsonb
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
  -- Service path (worker/admin) carries no user claim; user paths must be
  -- household members.
  if v_uid is not null and not exists (
    select 1 from public.household_memberships m
     where m.household_id = p_household_id and m.user_id = v_uid
  ) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode = 'P0006';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'accountId', account_id,
           'currentMinor', current_minor::text,
           'availableMinor', available_minor::text,
           'limitMinor', limit_minor::text,
           'currency', currency,
           'asOf', as_of
         )), '[]'::jsonb)
    into v_rows
    from (
      select distinct on (bs.account_id)
             bs.account_id, bs.current_minor, bs.available_minor, bs.limit_minor, bs.currency, bs.as_of
        from public.balance_snapshots bs
        where bs.household_id = p_household_id
          and not exists (
            select 1 from public.accounts a
             where a.id = bs.account_id
               and a.archived_at is not null
          )
        order by bs.account_id, bs.as_of desc
    ) latest;
  return v_rows;
end;
$$;

revoke all on function public.keel_latest_balances(uuid) from public, anon;
grant execute on function public.keel_latest_balances(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. keel_investments_value_daily  (owner postgres; grants authenticated,
--    service_role) — add archived-account filter to the accounts join so an
--    archived investment account's holdings snapshots stop contributing.
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
    'formulaVersion', 'investments-value-daily-v1',
    'from', v_from,
    'to', v_to,
    'points', v_points,
    'currency', 'USD'
  );
end;
$$;

revoke all on function public.keel_investments_value_daily(uuid, date, date) from public, anon;
grant execute on function public.keel_investments_value_daily(uuid, date, date) to authenticated, service_role;
