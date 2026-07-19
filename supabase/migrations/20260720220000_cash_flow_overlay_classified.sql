-- feat(cash-flow): classify top-level cash flow by the EFFECTIVE OVERLAY
-- CATEGORY KIND, exactly as keel_budget_month already does — single source of
-- truth (Law 9, scope-safe calculation: ONE classification compiler for
-- budget + cash-flow). Founder-approved fix, 2026-07-19.
--
-- PROBLEM. keel_cash_flow / keel_cash_flow_monthly (v5) classified each
-- transaction by its OFFSET (category) posting's ledger-account KIND
-- (income/expense) taken RAW off the posting, ignoring the user's overlay in
-- transaction_categories. keel_budget_month, in contrast, classifies by the
-- EFFECTIVE category (overlay if a single-offset overlay exists, else the offset
-- category). So a reimbursement "payback" the user categorized INTO a spend
-- category (a friend Zelles them back for dinner -> tagged to Restaurants)
-- correctly NETS in budget (reduces Restaurants spend) but still counted as
-- gross INCOME in cash-flow. Net was correct; gross income AND gross spend were
-- both inflated by the same amount.
--
-- VERIFIED on live household a1ba3759-b7a7-4880-93e2-49eb6f91636c: exactly 789
-- txns (income-kind offset posting, single-offset user overlay to an EXPENSE
-- category) totaling $178,767.79 were inflating gross income under the raw v5
-- rule. Of those, 735 ($82,743.76) survive the transfer/settlement exclusions
-- and actually moved the read model; 11 more txns run the OTHER direction
-- (expense-kind offset overlaid to an INCOME category, -$2,678.66) and were
-- inflating gross spend. Net is unchanged; only the gross split changes.
--
-- FIX. For each transaction that survives the (unchanged, first-applied)
-- exclusions, classify by the EFFECTIVE category kind — overlay category kind if
-- a single-offset overlay exists, else the offset posting's own category kind —
-- exactly the resolution keel_budget_month uses. Money-in stays signed positive
-- (inflow = -Σ over income-kind), money-out positive (outflow = +Σ over
-- expense-kind). A bank-INFLOW overlaid to an EXPENSE category therefore
-- contributes a NEGATIVE amount to outflow (reduces that spend, matching
-- "reduces Restaurants spend"); a bank-OUTFLOW overlaid to income reduces
-- inflow. Split transactions (offn > 1) are classified per-split by each split's
-- own offset category kind (mirroring keel_budget_month's monthly_spent CTE):
-- a whole-transaction overlay only applies when there is a single offset.
--
-- INVARIANTS (validated read-only against live before authoring):
--   * NET (inflow - outflow) is IDENTICAL to v5, per currency, over ALL history
--     (net5 = net6 = 7,835,485; net_diff = 0) and 2026 YTD (net 3,435,624
--     unchanged). Only the gross split moves.
--   * 2026 YTD: inflow 6,043,183 -> 3,671,574; outflow 2,607,559 -> 235,950
--     (both drop by 2,371,609 = the in-window paybacks, keeping net fixed).
--   * The exclusions are applied FIRST and UNCHANGED: confirmed-transfer legs,
--     keel_is_non_income_settlement, and transfer-category overlays
--     ('transfers' / 'transfers_in' / 'transfers_out') still drop out before any
--     income/expense classification.
--   * Deterministic, BIGINT minor units, no floats (Law 1, Law 4).
--
-- NOTE on the posting set. Every CATEGORY ledger account (is_category = true) is
-- income- or expense-kind (Transfers In/Out are income/expense kind
-- distinguished by pfc_key, not a separate 'transfer' kind), so the v6 base
-- (is_category = true) selects exactly the same posting set that v5's
-- `la.kind in ('income','expense')` did — verified by the net-invariance check.
--
-- Ownership/grants (BC-v2.1 keel_api boundary): CREATE OR REPLACE preserves the
-- live owner, but we re-assert exactly as 20260719020000 / 20260720140000 did so
-- a future full DROP+recreate stays correct — keel_cash_flow owned by keel_api;
-- keel_cash_flow_monthly left owned by the migration runner (postgres).
-- No column/table changes (Law 6 export DTO unaffected).

-- ---------------------------------------------------------------------------
-- keel_cash_flow (formulaVersion cash-flow-v6-overlay-classified)
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
        'currency', eff.currency,
        'inflowMinor', coalesce(-sum(eff.amount_minor) filter (where eff.eff_kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(eff.amount_minor) filter (where eff.eff_kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(eff.amount_minor) filter (where eff.eff_kind = 'income'), 0)
          - coalesce(sum(eff.amount_minor) filter (where eff.eff_kind = 'expense'), 0)
        )::text
      ) as row
      from (
        -- Per offset (category) posting, resolve the EFFECTIVE category kind:
        -- overlay kind when the batch has a single offset AND an overlay exists,
        -- else the offset's own kind (split-aware, per keel_budget_month).
        select p.currency, p.amount_minor,
          case when offn.n = 1 then coalesce(overcat.kind, offcat.kind) else offcat.kind end as eff_kind
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        join (
          select jp.batch_id, count(*) as n
            from public.journal_postings jp
            join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
           group by jp.batch_id
        ) offn on offn.batch_id = p.batch_id
        left join public.transaction_categories tc
          on tc.canonical_transaction_id = b.canonical_transaction_id
        left join public.ledger_accounts overcat on overcat.id = tc.category_ledger_account_id
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- EXCLUSIONS FIRST, UNCHANGED FROM v5:
          and not exists (
            select 1 from public.transfer_links tl
            where tl.household_id = p_household_id
              and tl.status = 'confirmed'
              and (tl.txn_out = b.canonical_transaction_id
                   or tl.txn_in = b.canonical_transaction_id)
          )
          and not public.keel_is_non_income_settlement(b.household_id, b.canonical_transaction_id)
          -- 20260719020000 + 20260720140000: a transaction categorized as a
          -- transfer ('transfers' / 'transfers_in' / 'transfers_out') is money
          -- movement, not income/spend — excluded even with no paired opposite
          -- leg (one-sided Venmo inflow, or an unconnected-card payoff debit).
          and (b.canonical_transaction_id is null
               or not public.keel_txn_is_transfer_category(p_household_id, b.canonical_transaction_id))
      ) eff
      group by eff.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-v6-overlay-classified',
    'rows', v_rows
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- keel_cash_flow_monthly (formulaVersion cash-flow-monthly-v5-overlay-classified)
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
        'month', to_char(eff.month, 'YYYY-MM'),
        'currency', eff.currency,
        'inflowMinor', coalesce(-sum(eff.amount_minor) filter (where eff.eff_kind = 'income'), 0)::text,
        'outflowMinor', coalesce(sum(eff.amount_minor) filter (where eff.eff_kind = 'expense'), 0)::text,
        'netMinor', (
          coalesce(-sum(eff.amount_minor) filter (where eff.eff_kind = 'income'), 0)
          - coalesce(sum(eff.amount_minor) filter (where eff.eff_kind = 'expense'), 0)
        )::text
      ) as row
      from (
        select date_trunc('month', b.effective_date) as month, p.currency, p.amount_minor,
          case when offn.n = 1 then coalesce(overcat.kind, offcat.kind) else offcat.kind end as eff_kind
        from public.journal_postings p
        join public.journal_batches b on b.id = p.batch_id
        join public.ledger_accounts offcat
          on offcat.id = p.ledger_account_id and offcat.is_category = true
        join (
          select jp.batch_id, count(*) as n
            from public.journal_postings jp
            join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
           group by jp.batch_id
        ) offn on offn.batch_id = p.batch_id
        left join public.transaction_categories tc
          on tc.canonical_transaction_id = b.canonical_transaction_id
        left join public.ledger_accounts overcat on overcat.id = tc.category_ledger_account_id
        where b.household_id = p_household_id
          and b.effective_date between p_from and p_to
          -- EXCLUSIONS FIRST, UNCHANGED FROM v4. See keel_cash_flow.
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
      ) eff
      group by eff.month, eff.currency
    ) t;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'cash-flow-monthly-v5-overlay-classified',
    'rows', v_rows
  );
end;
$function$;

-- Re-apply ownership + grants exactly as 20260719020000 / 20260720140000 did
-- (a future DROP resets them): keel_cash_flow owned by keel_api;
-- keel_cash_flow_monthly left owned by the migration runner (postgres).
grant create on schema public to keel_api;
alter function public.keel_cash_flow(uuid, date, date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cash_flow(uuid, date, date) from public, anon;
revoke all on function public.keel_cash_flow_monthly(uuid, date, date) from public, anon;
grant execute on function public.keel_cash_flow(uuid, date, date) to authenticated;
grant execute on function public.keel_cash_flow_monthly(uuid, date, date) to authenticated, service_role;
