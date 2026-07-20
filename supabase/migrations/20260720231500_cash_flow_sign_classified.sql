-- feat(cash-flow): split the money-in / money-out GRAPH by true CASH DIRECTION
-- (posting sign), not by the effective category KIND. Founder-reported bug,
-- 2026-07-20 screen-share: the monthly cash-flow bars "might be negative" and
-- the series "jumps at the end".
--
-- PROBLEM (money-out went NEGATIVE). v6 (20260720220000) classified each
-- category posting as inflow/outflow by its EFFECTIVE category KIND (overlay
-- kind if a single-offset overlay exists, else the offset's own kind). That is
-- exactly right for BUDGET math (a friend paying you back for dinner, tagged to
-- Restaurants, should REDUCE Restaurants spend). But the top-level cash-flow
-- GRAPH is a "money in vs money out" cash-direction view, and netting a
-- received payment INTO an expense category makes that month's "money out" bar
-- subtract a bank INFLOW. On live household a1ba3759-b7a7-4880-93e2-49eb6f91636c
-- this drove 6 of the last 12 months' outflow NEGATIVE — e.g. Oct-2025 outflow
-- = -$3,528 because a $7,470 "POSH Event Payout" (an income receipt, offset
-- category "Uncategorized Income") was user-overlaid to an event EXPENSE
-- category, plus many small "Zelle payment from ..." receipts overlaid to
-- Restaurants/Groceries. A negative "money out" bar is nonsense in a cash-flow
-- chart (and Law 8: red is reserved for negative money — a downward spend bar
-- reads as broken).
--
-- FIX. For the cash-flow read models ONLY, classify each surviving category
-- posting by the SIGN of its own amount_minor — the deterministic cash
-- direction on the ledger:
--   * amount_minor < 0  (a CREDIT to a category account, i.e. money the
--     household RECEIVED) -> INFLOW  (money in)
--   * amount_minor > 0  (a DEBIT to a category account, i.e. money the
--     household SPENT)    -> OUTFLOW (money out)
-- inflowMinor  = -Σ(amount_minor where amount_minor < 0)   (>= 0 always)
-- outflowMinor =  Σ(amount_minor where amount_minor > 0)   (>= 0 always)
-- Both are non-negative by construction, so a money-out bar can never dip below
-- zero. A received payment tagged to a spend category now counts as money IN
-- (its true direction) instead of negative money OUT.
--
-- The overlay/split classification (transaction_categories, offn.n) is DROPPED
-- from these two procs because cash DIRECTION is intrinsic to the posting sign
-- and does not depend on which category label the user chose — so the join to
-- transaction_categories / ledger_accounts overcat is no longer needed here.
-- keel_budget_month is UNCHANGED and remains the single overlay-aware budget
-- classifier (Law 9): budget still nets reimbursements into their category; the
-- cash-flow graph shows gross cash direction. These are two different, each
-- reproducible, scoped calculations — not two answers to the same question.
--
-- INVARIANTS (validated read-only against live before authoring):
--   * NET (inflow - outflow) is IDENTICAL to v6, per currency, per month, over
--     the last 12 months (net = -Σ amount_minor over the same surviving posting
--     set in BOTH formulations; verified equal for every month incl. the two
--     months where v6's income-kind filter was NULL). Only the gross split moves.
--   * Every month's inflow >= 0 AND outflow >= 0 (the reported bug is gone):
--     e.g. Oct-2025 outflow -$3,528 (v6) -> +$4,935 (v7), inflow $771 -> $9,234;
--     net +$4,299 unchanged.
--   * The exclusions are applied FIRST and UNCHANGED from v6: confirmed-transfer
--     legs, keel_is_non_income_settlement, and transfer-category overlays
--     ('transfers' / 'transfers_in' / 'transfers_out') still drop out before any
--     inflow/outflow split.
--   * Same posting set as v6: is_category = true selects exactly the postings v6
--     classified; only the inflow/outflow bucketing rule changed.
--   * Deterministic, BIGINT minor units, no floats (Law 1, Law 4).
--
-- NOTE. The "jumps at the end" half of the report is a PARTIAL-MONTH artifact:
-- the newest bucket is the current, incomplete month (the API requests
-- p_to = today), so it is plotted at full visual weight beside complete months.
-- That is fixed in the CHART (apps/web) by flagging the current month as
-- in-progress; the read model correctly returns the true month-to-date figures.
--
-- Ownership/grants (BC-v2.1 keel_api boundary): re-asserted exactly as v6 did
-- (keel_cash_flow owned by keel_api; keel_cash_flow_monthly left owned by the
-- migration runner / postgres). No column/table changes (Law 6 export DTO
-- unaffected).
--
-- APPLY (orchestrator, after review): the usual single-transaction psql:
--   source supabase/.env.remote
--   psql "postgresql://postgres@db.<ref>.supabase.co:5432/postgres" \
--     -v ON_ERROR_STOP=1 --single-transaction \
--     -f supabase/migrations/20260720231500_cash_flow_sign_classified.sql

-- ---------------------------------------------------------------------------
-- keel_cash_flow (formulaVersion cash-flow-v7-sign-classified)
-- ---------------------------------------------------------------------------
create or replace function public.keel_cash_flow(p_household_id uuid, p_from date, p_to date)
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
  if p_from > p_to then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'currency'), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
        'currency', dir.currency,
        -- CASH DIRECTION (v7): a CREDIT to a category account (amount_minor < 0)
        -- is money received -> inflow; a DEBIT (> 0) is money spent -> outflow.
        -- Both non-negative by construction.
        'inflowMinor', coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)::text,
        'outflowMinor', coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)::text,
        'netMinor', (
          coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)
          - coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)
        )::text
      ) as row
      from (
        select p.currency, p.amount_minor
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- EXCLUSIONS FIRST, UNCHANGED FROM v6:
          and not exists (
            select 1 from public.transfer_links tl
            where tl.household_id = p_household_id
              and tl.status = 'confirmed'
              and (tl.txn_out = b.canonical_transaction_id
                   or tl.txn_in = b.canonical_transaction_id)
          )
          and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
          and (b.canonical_transaction_id is null
               or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      ) dir
      group by dir.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v7-sign-classified',
    'rows', v_rows
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- keel_cash_flow_monthly (formulaVersion cash-flow-monthly-v6-sign-classified)
-- ---------------------------------------------------------------------------
create or replace function public.keel_cash_flow_monthly(p_household_id uuid, p_from date, p_to date)
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
  if p_from > p_to or p_to - p_from > 750 then
    raise exception 'KEEL_INVALID_RANGE' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(row order by row->>'month', row->>'currency'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
        'month', to_char(dir.month, 'YYYY-MM'),
        'currency', dir.currency,
        'inflowMinor', coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)::text,
        'outflowMinor', coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)::text,
        'netMinor', (
          coalesce(-sum(dir.amount_minor) filter (where dir.amount_minor < 0), 0)
          - coalesce(sum(dir.amount_minor) filter (where dir.amount_minor > 0), 0)
        )::text
      ) as row
      from (
        select date_trunc('month', b.effective_date) as month, p.currency, p.amount_minor
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- EXCLUSIONS FIRST, UNCHANGED FROM v6. See keel_cash_flow.
          and not exists (
            select 1 from public.transfer_links tl
            where tl.household_id = p_household_id
              and tl.status = 'confirmed'
              and (tl.txn_out = b.canonical_transaction_id
                   or tl.txn_in = b.canonical_transaction_id)
          )
          and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
          and (b.canonical_transaction_id is null
               or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      ) dir
      group by dir.month, dir.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v6-sign-classified',
    'rows', v_rows
  );
end;
$function$;

-- Re-apply ownership + grants exactly as v6 (20260720220000) did (a future DROP
-- resets them): keel_cash_flow owned by keel_api; keel_cash_flow_monthly left
-- owned by the migration runner (postgres).
grant create on schema public to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date) to authenticated, service_role;
