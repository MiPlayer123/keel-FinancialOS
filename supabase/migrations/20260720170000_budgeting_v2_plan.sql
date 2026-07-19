-- Budgeting v2 (SLICE B2) — "planned total + opt-in category targets + residual"
-- (docs/harness/plans/budgeting-v2-research.md §2/§3). Founder asks:
--   (a) only opted-in categories appear as budgets,
--   (b) toggle a budget between a percent and a dollar amount,
--   (c) an editable overall total that reconciles against per-category breakdowns,
--   (d) richer budgeting via standing, effective-dated targets.
--
-- This migration is ADDITIVE. The v1 `budgets` table and its read model
-- (keel_list_budgets, formulaVersion budget-v3-split-aware-rollover) are LEFT
-- INTACT until a later cutover — B2 introduces the parallel v4 model, backfills
-- existing budgets rows as amount targets, and proves keel_budget_month with
-- only amount targets reproduces v3 numbers exactly (equivalence test).
--
-- Laws honoured: 1 (no float ledger math — percent resolution is floor(base×bp/10000)
-- in BIGINT, the SAME integer arithmetic as packages/ledger/src/budget.ts); 2
-- (every write audited, soft removal via end_month — never DELETE); 4 (BIGINT
-- minor units, INT basis points, enums, no implicit defaults on the write path);
-- 6 (export chain extended); invariant 7 (the read model carries scope/asOf/
-- formulaVersion/exclusions).

-- ===========================================================================
-- 1. Enums
-- ===========================================================================
do $$begin
  if not exists (select 1 from pg_type where typname = 'budget_target_kind') then
    create type public.budget_target_kind as enum ('amount', 'percent_of_total');
  end if;
  if not exists (select 1 from pg_type where typname = 'budget_total_basis') then
    create type public.budget_total_basis as enum ('amount', 'percent_of_income');
  end if;
end$$;

-- ===========================================================================
-- 2. budget_targets — standing, effective-dated targets.
--    category_ledger_account_id NULL  = the plan-TOTAL row (uses total_basis).
--    category_ledger_account_id NOT NULL = a category target (uses target_kind).
--    A target is live from effective_month until end_month (exclusive); NULL
--    end_month = open-ended. Removal/override is a soft end-date, never DELETE.
-- ===========================================================================
create table if not exists public.budget_targets (
  id                         uuid primary key default gen_random_uuid(),
  household_id               uuid not null references public.households (id),
  category_ledger_account_id uuid references public.ledger_accounts (id),
  effective_month            date not null check (effective_month = date_trunc('month', effective_month)::date),
  end_month                  date check (end_month is null or end_month = date_trunc('month', end_month)::date),
  -- category rows carry target_kind; the total row carries total_basis. Exactly
  -- one of the two is populated, enforced by the row-shape CHECK below.
  target_kind                public.budget_target_kind,
  total_basis                public.budget_total_basis,
  amount_minor               bigint check (amount_minor is null or amount_minor >= 0),
  percent_bp                 integer check (percent_bp is null or percent_bp between 0 and 10000),
  rollover                   boolean not null,
  currency                   char(3) not null,
  created_at                 timestamptz not null default now(),

  -- end_month must not precede effective_month. end_month = effective_month is a
  -- TOMBSTONE: the row covers zero live months (used when a target is created and
  -- removed within the same month — soft removal, never DELETE). The read model's
  -- coverage predicate is (effective_month <= m AND (end_month IS NULL OR end_month > m)),
  -- so a tombstoned row is live for no month.
  constraint budget_targets_month_order
    check (end_month is null or end_month >= effective_month),

  -- Row-shape: a TOTAL row (category null) declares total_basis and no
  -- target_kind; a CATEGORY row declares target_kind and no total_basis.
  constraint budget_targets_row_shape check (
    (category_ledger_account_id is null
      and total_basis is not null and target_kind is null)
    or
    (category_ledger_account_id is not null
      and target_kind is not null and total_basis is null)
  ),

  -- Value shape: exactly one of amount_minor / percent_bp is present, and it
  -- must match the declared kind/basis (amount→amount_minor, percent→percent_bp).
  constraint budget_targets_value_shape check (
    -- total row
    (category_ledger_account_id is null and (
       (total_basis = 'amount'            and amount_minor is not null and percent_bp is null)
    or (total_basis = 'percent_of_income' and percent_bp   is not null and amount_minor is null)
    ))
    or
    -- category row
    (category_ledger_account_id is not null and (
       (target_kind = 'amount'           and amount_minor is not null and percent_bp is null)
    or (target_kind = 'percent_of_total' and percent_bp   is not null and amount_minor is null)
    ))
  )
);

-- One LIVE row per (household, category-or-total, month). "Live" = end_month is
-- null (open) — a partial unique index over open rows guarantees at most one
-- open target per slot; overriding a target end-dates the old open row first.
-- coalesce(category, uuid-nil) folds the NULL total row into the same index.
create unique index if not exists budget_targets_one_live_total
  on public.budget_targets (household_id, effective_month)
  where category_ledger_account_id is null and end_month is null;

create unique index if not exists budget_targets_one_live_category
  on public.budget_targets (household_id, category_ledger_account_id, effective_month)
  where category_ledger_account_id is not null and end_month is null;

create index if not exists budget_targets_lookup
  on public.budget_targets (household_id, effective_month, end_month);

-- ===========================================================================
-- 3. budget_expected_income — user-confirmed expected income per month range.
--    Feeds a percent_of_income plan total. Effective-dated like targets.
-- ===========================================================================
create table if not exists public.budget_expected_income (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references public.households (id),
  effective_month date not null check (effective_month = date_trunc('month', effective_month)::date),
  end_month       date check (end_month is null or end_month = date_trunc('month', end_month)::date),
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null,
  created_at      timestamptz not null default now(),
  constraint budget_expected_income_month_order
    check (end_month is null or end_month >= effective_month)
);

create unique index if not exists budget_expected_income_one_live
  on public.budget_expected_income (household_id, effective_month)
  where end_month is null;

-- ===========================================================================
-- 4. RLS + grants (mirror the budgets/statement-cadence domains).
-- ===========================================================================
alter table public.budget_targets enable row level security;
alter table public.budget_expected_income enable row level security;
revoke all on public.budget_targets, public.budget_expected_income from public, anon, authenticated;
grant select on public.budget_targets, public.budget_expected_income to authenticated, service_role;
grant select, insert, update, delete on public.budget_targets, public.budget_expected_income to keel_api;

drop policy if exists budget_targets_member_read on public.budget_targets;
create policy budget_targets_member_read on public.budget_targets
  for select to authenticated
  using (exists (select 1 from public.household_memberships m
                 where m.household_id = budget_targets.household_id and m.user_id = auth.uid()));
drop policy if exists budget_targets_api_all on public.budget_targets;
create policy budget_targets_api_all on public.budget_targets for all to keel_api using (true) with check (true);

drop policy if exists budget_income_member_read on public.budget_expected_income;
create policy budget_income_member_read on public.budget_expected_income
  for select to authenticated
  using (exists (select 1 from public.household_memberships m
                 where m.household_id = budget_expected_income.household_id and m.user_id = auth.uid()));
drop policy if exists budget_income_api_all on public.budget_expected_income;
create policy budget_income_api_all on public.budget_expected_income for all to keel_api using (true) with check (true);

-- ===========================================================================
-- 5. Backfill: every existing v1 budgets row becomes an amount category target
--    effective that month, open-ended, carrying its rollover flag. Idempotent
--    (skips categories already targeted). No total row is invented — a
--    household with only category amounts has an implicit 'Left to budget' of
--    (total − Σ) which is undefined until it sets a total; the read model
--    handles a missing total by resolving total = Σ amount targets (see §7).
-- ===========================================================================
insert into public.budget_targets
  (household_id, category_ledger_account_id, effective_month, end_month,
   target_kind, amount_minor, rollover, currency)
select b.household_id, b.category_ledger_account_id, b.month, null,
       'amount'::public.budget_target_kind, b.amount_minor, b.rollover, b.currency
  from public.budgets b
 where not exists (
   select 1 from public.budget_targets t
    where t.household_id = b.household_id
      and t.category_ledger_account_id = b.category_ledger_account_id
      and t.effective_month = b.month
      and t.end_month is null
 );

-- ===========================================================================
-- 6. Commands. All follow the envelope ritual: member-write assert,
--    actor-from-jwt (forgery guard), idempotency, keel_finish_command. Soft
--    removal only. Effective-dating: setting a target end-dates any open row
--    for that slot BEFORE this month, then inserts the new open row. Setting a
--    target for a month that already has an open row starting THIS month
--    replaces it in place (same month = a correction, not a new era).
-- ===========================================================================

-- 6a. budgets.set_total — plan total for a month (amount or percent_of_income).
create function public.keel_cmd_budgets_set_total(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_basis public.budget_total_basis; v_amount bigint; v_bp int;
  v_currency char(3); v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_basis := (p_payload->>'basis')::public.budget_total_basis;
  v_currency := coalesce(nullif(p_payload->>'currency',''), 'USD');
  if v_basis = 'amount' then
    v_amount := (p_payload->>'amount_minor')::bigint;
    if v_amount is null or v_amount < 0 then
      raise exception 'KEEL_INVALID_COMMAND: total amount must be non-negative' using errcode='P0009'; end if;
    v_bp := null;
  else
    v_bp := (p_payload->>'percent_bp')::int;
    if v_bp is null or v_bp < 0 or v_bp > 10000 then
      raise exception 'KEEL_INVALID_COMMAND: percent_bp out of range' using errcode='P0009'; end if;
    v_amount := null;
  end if;

  -- End-date any live total row that STARTED BEFORE this month (a new era).
  update public.budget_targets
     set end_month = v_month
   where household_id = p_household_id and category_ledger_account_id is null
     and end_month is null and effective_month < v_month;
  -- Replace a same-month open total row in place (correction), else insert.
  delete from public.budget_targets
   where household_id = p_household_id and category_ledger_account_id is null
     and end_month is null and effective_month = v_month;
  insert into public.budget_targets
    (household_id, category_ledger_account_id, effective_month, total_basis, amount_minor, percent_bp, rollover, currency)
  values (p_household_id, null, v_month, v_basis, v_amount, v_bp, false, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'basis', v_basis,
    'amountMinor', v_amount::text, 'percentBp', v_bp);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_total', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.total_set', 'household', p_household_id, v_after, v_result);
  return v_result;
end;
$$;

-- 6b. budgets.set_target — a category target (amount or percent_of_total).
create function public.keel_cmd_budgets_set_target(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_cat uuid; v_kind public.budget_target_kind; v_amount bigint; v_bp int;
  v_rollover boolean; v_currency char(3); v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_cat := (p_payload->>'category_ledger_account_id')::uuid;
  v_kind := (p_payload->>'kind')::public.budget_target_kind;
  v_rollover := coalesce((p_payload->>'rollover')::boolean, false);

  -- Category MUST be a live expense category in this household. currency is
  -- pinned to the category's own currency (Law 4), never caller-supplied.
  select la.currency into v_currency
    from public.ledger_accounts la
   where la.id = v_cat and la.household_id = p_household_id
     and la.is_category = true and la.kind = 'expense' and la.archived_at is null;
  if v_currency is null then
    raise exception 'KEEL_INVALID_COMMAND: invalid budget category' using errcode='P0009'; end if;

  if v_kind = 'amount' then
    v_amount := (p_payload->>'amount_minor')::bigint;
    if v_amount is null or v_amount < 0 then
      raise exception 'KEEL_INVALID_COMMAND: target amount must be non-negative' using errcode='P0009'; end if;
    v_bp := null;
  else
    v_bp := (p_payload->>'percent_bp')::int;
    if v_bp is null or v_bp < 0 or v_bp > 10000 then
      raise exception 'KEEL_INVALID_COMMAND: percent_bp out of range' using errcode='P0009'; end if;
    v_amount := null;
  end if;

  update public.budget_targets
     set end_month = v_month
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month < v_month;
  delete from public.budget_targets
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month = v_month;
  insert into public.budget_targets
    (household_id, category_ledger_account_id, effective_month, target_kind, amount_minor, percent_bp, rollover, currency)
  values (p_household_id, v_cat, v_month, v_kind, v_amount, v_bp, v_rollover, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'categoryLedgerAccountId', v_cat,
    'kind', v_kind, 'amountMinor', v_amount::text, 'percentBp', v_bp, 'rollover', v_rollover);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_target', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.target_set', 'ledger_account', v_cat, v_after, v_result);
  return v_result;
end;
$$;

-- 6c. budgets.remove_target — soft removal (end-date), never DELETE.
create function public.keel_cmd_budgets_remove_target(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_cat uuid; v_after jsonb; v_result jsonb; v_affected int;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_cat := (p_payload->>'category_ledger_account_id')::uuid;
  if v_cat is null then
    raise exception 'KEEL_INVALID_COMMAND: category required' using errcode='P0009'; end if;

  -- Soft removal from THIS month onward. A row that STARTED BEFORE this month is
  -- end-dated at v_month (it stays effective for prior months — reversible). A
  -- row that STARTS this month is tombstoned (end_month = effective_month), so
  -- it covers zero live months but is never DELETEd (soft-delete directive).
  update public.budget_targets
     set end_month = case when effective_month < v_month then v_month
                          else effective_month end
   where household_id = p_household_id and category_ledger_account_id = v_cat
     and end_month is null and effective_month <= v_month;
  get diagnostics v_affected = row_count;
  if v_affected = 0 then
    raise exception 'KEEL_INVALID_COMMAND: no live target to remove' using errcode='P0009'; end if;

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'categoryLedgerAccountId', v_cat, 'removed', true);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.remove_target', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.target_removed', 'ledger_account', v_cat, v_after, v_result);
  return v_result;
end;
$$;

-- 6d. budgets.set_expected_income — user-confirmed expected income for a month.
create function public.keel_cmd_budgets_set_expected_income(
  p_command_id uuid, p_economic_event_key text, p_actor jsonb, p_household_id uuid, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_hash text := public.keel_payload_hash(p_payload); v_replay jsonb; v_actor jsonb;
  v_month date; v_amount bigint; v_currency char(3); v_after jsonb; v_result jsonb;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_actor := public.keel_actor_from_jwt();
  v_replay := public.keel_idempotency_check(p_household_id, p_economic_event_key, v_hash);
  if v_replay is not null then return v_replay; end if;

  v_month := date_trunc('month', (p_payload->>'month')::date)::date;
  v_amount := (p_payload->>'amount_minor')::bigint;
  v_currency := coalesce(nullif(p_payload->>'currency',''), 'USD');
  if v_amount is null or v_amount < 0 then
    raise exception 'KEEL_INVALID_COMMAND: expected income must be non-negative' using errcode='P0009'; end if;

  update public.budget_expected_income
     set end_month = v_month
   where household_id = p_household_id and end_month is null and effective_month < v_month;
  delete from public.budget_expected_income
   where household_id = p_household_id and end_month is null and effective_month = v_month;
  insert into public.budget_expected_income
    (household_id, effective_month, amount_minor, currency)
  values (p_household_id, v_month, v_amount, v_currency);

  v_after := jsonb_build_object('month', to_char(v_month,'YYYY-MM'), 'amountMinor', v_amount::text);
  v_result := jsonb_build_object('commandId', p_command_id, 'economicEventKey', p_economic_event_key,
    'idempotentReplay', false, 'effects', v_after,
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  perform public.keel_finish_command(p_command_id, 'budgets.set_expected_income', p_economic_event_key,
    p_household_id, v_actor, v_hash, 'budgets.expected_income_set', 'household', p_household_id, v_after, v_result);
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Read model — keel_budget_month, formulaVersion 'budget-v4-plan'.
--    Integer-only resolution mirroring packages/ledger/src/budget.ts EXACTLY.
--    Spent uses the UNCHANGED pinned v3 split-aware formula (bucketed by month
--    over the rollover horizon), so v3-equivalence holds. Carry is computed
--    against RESOLVED targets. Percent categories don't need to sum to 100% —
--    the residual is the visible leftToBudget.
-- ===========================================================================
create function public.keel_budget_month(p_household_id uuid, p_month date)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_uid uuid := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_month date := date_trunc('month', p_month)::date;
  v_next  date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_expected_income bigint;
  v_total_basis public.budget_total_basis;
  v_total_amount bigint;
  v_total_bp int;
  v_total_minor bigint;
  v_sum_amount_targets bigint;
  v_has_total boolean;
  v_rows jsonb;
  v_everything_else bigint;
begin
  if v_uid is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode='P0004'; end if;
  if not exists (select 1 from public.household_memberships m
                 where m.household_id = p_household_id and m.user_id = v_uid) then
    raise exception 'KEEL_SCOPE_VIOLATION' using errcode='P0006';
  end if;

  -- Live expected income for the month (row covering v_month).
  select amount_minor into v_expected_income
    from public.budget_expected_income
   where household_id = p_household_id and effective_month <= v_month
     and (end_month is null or end_month > v_month)
   order by effective_month desc limit 1;

  -- Live plan total for the month.
  select total_basis, amount_minor, percent_bp
    into v_total_basis, v_total_amount, v_total_bp
    from public.budget_targets
   where household_id = p_household_id and category_ledger_account_id is null
     and effective_month <= v_month and (end_month is null or end_month > v_month)
   order by effective_month desc limit 1;
  v_has_total := v_total_basis is not null;

  -- Sum of live AMOUNT category targets for the month (needed when there is no
  -- explicit total: the implicit total is the sum of amount targets — this is
  -- what makes the amount-only case reproduce v3 with leftToBudget = 0).
  select coalesce(sum(amount_minor), 0)::bigint into v_sum_amount_targets
    from public.budget_targets
   where household_id = p_household_id and category_ledger_account_id is not null
     and target_kind = 'amount'
     and effective_month <= v_month and (end_month is null or end_month > v_month);

  -- Resolve the total (floor for percent_of_income; 0 if income unknown).
  if not v_has_total then
    v_total_minor := v_sum_amount_targets;                       -- implicit total
  elsif v_total_basis = 'amount' then
    v_total_minor := v_total_amount;
  else
    v_total_minor := coalesce((coalesce(v_expected_income,0) * v_total_bp) / 10000, 0);
  end if;

  -- Per-month spent (the UNCHANGED v3 split-aware formula), across the whole
  -- horizon so carry is exact. Identical predicate to keel_list_budgets v3.
  with offn as (
    select jp.batch_id, count(*) as n
      from public.journal_postings jp
      join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
      join public.journal_batches jb2 on jb2.id = jp.batch_id
     where jb2.household_id = p_household_id
     group by 1
  ),
  monthly_spent as (
    select case when offn.n = 1 then coalesce(tc.category_ledger_account_id, offcat.id)
                else offcat.id end as category_id,
           date_trunc('month', jb.effective_date)::date as month,
           sum(offp.amount_minor)::bigint as spent_minor
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join offn on offn.batch_id = jb.id
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts overcat on overcat.id = tc.category_ledger_account_id
     where ct.household_id = p_household_id
       and ct.voided_at is null
       and jb.effective_date < v_next
       and (case when offn.n = 1 then coalesce(overcat.kind, offcat.kind) else offcat.kind end) = 'expense'
       and offp.currency = (case when offn.n = 1 then coalesce(overcat.currency, offcat.currency) else offcat.currency end)
       and not exists (
         select 1 from public.transfer_links tl
          where tl.household_id = p_household_id and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id))
     group by 1, 2
  ),
  -- Live category targets for the month, resolved to minor units.
  live_targets as (
    select t.category_ledger_account_id as category_id,
           t.target_kind, t.amount_minor, t.percent_bp, t.rollover, t.currency
      from public.budget_targets t
     where t.household_id = p_household_id and t.category_ledger_account_id is not null
       and t.effective_month <= v_month and (t.end_month is null or t.end_month > v_month)
  ),
  resolved as (
    select lt.category_id, la.name as category_name, la.parent_ledger_account_id,
           lt.target_kind, lt.rollover, lt.currency,
           case when lt.target_kind = 'amount' then lt.amount_minor
                else (v_total_minor * lt.percent_bp) / 10000 end as resolved_minor,
           lt.percent_bp, lt.amount_minor as declared_amount
      from live_targets lt
      join public.ledger_accounts la on la.id = lt.category_id
  ),
  -- Carry: Σ over PRIOR months (< v_month) of (resolved_target − spent) for
  -- rollover-enabled targets. Resolve each prior month's target against THAT
  -- month's total. Since the founder model keeps percents stable within a
  -- month, resolving prior amounts is exact; prior percents resolve against the
  -- prior total (looked up per month). To stay deterministic and bounded, carry
  -- resolves prior AMOUNT targets directly and prior PERCENT targets against the
  -- prior month's resolved total via a lateral per-month total lookup.
  prior_targets as (
    select t.category_ledger_account_id as category_id, t.effective_month,
           t.end_month, t.target_kind, t.amount_minor, t.percent_bp
      from public.budget_targets t
     where t.household_id = p_household_id and t.category_ledger_account_id is not null
       and t.rollover = true and t.effective_month < v_month
  ),
  prior_months as (
    -- expand each rollover target to the concrete prior months it covers
    select pt.category_id, gs::date as month, pt.target_kind, pt.amount_minor, pt.percent_bp
      from prior_targets pt
      cross join lateral generate_series(
        pt.effective_month,
        (least(coalesce(pt.end_month, v_month), v_month) - interval '1 month')::date,
        interval '1 month') gs
  ),
  prior_total as (
    -- resolved total for each prior month (amount, or income×bp, or Σ amount targets)
    select pm_month.month,
           case
             when tot.total_basis = 'amount' then tot.amount_minor
             when tot.total_basis = 'percent_of_income'
               then coalesce((coalesce(inc.amount_minor,0) * tot.percent_bp)/10000, 0)
             else coalesce((select sum(a.amount_minor) from public.budget_targets a
                             where a.household_id = p_household_id and a.category_ledger_account_id is not null
                               and a.target_kind='amount' and a.effective_month <= pm_month.month
                               and (a.end_month is null or a.end_month > pm_month.month)), 0)
           end as total_minor
      from (select distinct month from prior_months) pm_month
      left join lateral (
        select total_basis, amount_minor, percent_bp from public.budget_targets tt
         where tt.household_id = p_household_id and tt.category_ledger_account_id is null
           and tt.effective_month <= pm_month.month and (tt.end_month is null or tt.end_month > pm_month.month)
         order by tt.effective_month desc limit 1) tot on true
      left join lateral (
        select amount_minor from public.budget_expected_income ii
         where ii.household_id = p_household_id and ii.effective_month <= pm_month.month
           and (ii.end_month is null or ii.end_month > pm_month.month)
         order by ii.effective_month desc limit 1) inc on true
  ),
  carry as (
    select pm.category_id,
           sum(
             (case when pm.target_kind='amount' then pm.amount_minor
                   else (coalesce(ptot.total_minor,0) * pm.percent_bp)/10000 end)
             - coalesce(ms.spent_minor, 0)
           )::bigint as carry_minor
      from prior_months pm
      left join prior_total ptot on ptot.month = pm.month
      left join monthly_spent ms on ms.category_id = pm.category_id and ms.month = pm.month
     group by pm.category_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'categoryLedgerAccountId', r.category_id,
           'categoryName', r.category_name,
           'parentLedgerAccountId', r.parent_ledger_account_id,
           'currency', r.currency,
           'kind', r.target_kind,
           'declared', case when r.target_kind = 'amount'
                            then jsonb_build_object('amountMinor', r.declared_amount::text)
                            else jsonb_build_object('percentBp', r.percent_bp) end,
           'resolvedMinor', r.resolved_minor::text,
           'spentMinor', coalesce(s.spent_minor, 0)::text,
           'rollover', r.rollover,
           'carryMinor', case when r.rollover then coalesce(c.carry_minor, 0)::text end,
           'availableMinor', case when r.rollover
             then (r.resolved_minor + coalesce(c.carry_minor, 0))::text
             else r.resolved_minor::text end
         ) order by r.category_name), '[]'::jsonb)
    into v_rows
    from resolved r
    left join monthly_spent s on s.category_id = r.category_id and s.month = v_month
    left join carry c on c.category_id = r.category_id;

  -- Everything else = spend this month in expense categories WITHOUT a live
  -- target (the residual bucket). Uses the same monthly_spent CTE shape via a
  -- fresh aggregate over non-targeted categories.
  with offn as (
    select jp.batch_id, count(*) as n
      from public.journal_postings jp
      join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
      join public.journal_batches jb2 on jb2.id = jp.batch_id
     where jb2.household_id = p_household_id group by 1
  ),
  ms as (
    select case when offn.n = 1 then coalesce(tc.category_ledger_account_id, offcat.id)
                else offcat.id end as category_id,
           sum(offp.amount_minor)::bigint as spent_minor
      from public.canonical_transactions ct
      join public.journal_batches jb
        on jb.canonical_transaction_id = ct.id and jb.reverses_batch_id is null
       and not exists (select 1 from public.journal_revisions rev where rev.original_batch_id = jb.id)
      join public.journal_postings offp on offp.batch_id = jb.id
      join public.ledger_accounts offcat on offcat.id = offp.ledger_account_id and offcat.is_category = true
      join offn on offn.batch_id = jb.id
      left join public.transaction_categories tc on tc.canonical_transaction_id = ct.id
      left join public.ledger_accounts overcat on overcat.id = tc.category_ledger_account_id
     where ct.household_id = p_household_id and ct.voided_at is null
       and jb.effective_date >= v_month and jb.effective_date < v_next
       and (case when offn.n = 1 then coalesce(overcat.kind, offcat.kind) else offcat.kind end) = 'expense'
       and offp.currency = (case when offn.n = 1 then coalesce(overcat.currency, offcat.currency) else offcat.currency end)
       and not exists (
         select 1 from public.transfer_links tl
          where tl.household_id = p_household_id and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id))
     group by 1
  )
  select coalesce(sum(ms.spent_minor) filter (
           where not exists (
             select 1 from public.budget_targets t
              where t.household_id = p_household_id and t.category_ledger_account_id = ms.category_id
                and t.effective_month <= v_month and (t.end_month is null or t.end_month > v_month))
         ), 0)::bigint
    into v_everything_else
    from ms;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'month', to_char(v_month,'YYYY-MM')),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'budget-v4-plan',
    'total', jsonb_build_object(
      'basis', coalesce(v_total_basis::text, 'implicit_sum'),
      'resolvedMinor', v_total_minor::text,
      'declaredAmountMinor', v_total_amount::text,
      'declaredPercentBp', v_total_bp),
    'expectedIncomeMinor', case when v_expected_income is null then null else v_expected_income::text end,
    'leftToBudgetMinor', (v_total_minor - (
       select coalesce(sum((elem->>'resolvedMinor')::bigint), 0) from jsonb_array_elements(v_rows) elem
    ))::text,
    'everythingElseSpentMinor', v_everything_else::text,
    'rows', v_rows
  );
end;
$$;

-- ===========================================================================
-- 8. Ownership + grants (keel_api owns definer procs; ownership guard).
-- ===========================================================================
grant create on schema public to keel_api;
alter function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
alter function public.keel_budget_month(uuid,date) owner to keel_api;
revoke create on schema public from keel_api;

revoke all on function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb),
  public.keel_budget_month(uuid,date) from public, anon;
grant execute on function public.keel_cmd_budgets_set_total(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_set_target(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_remove_target(uuid,text,jsonb,uuid,jsonb),
  public.keel_cmd_budgets_set_expected_income(uuid,text,jsonb,uuid,jsonb) to authenticated;
grant execute on function public.keel_budget_month(uuid,date) to authenticated, service_role;

do $$begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname in ('keel_cmd_budgets_set_total','keel_cmd_budgets_set_target',
      'keel_cmd_budgets_remove_target','keel_cmd_budgets_set_expected_income','keel_budget_month')
      and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: budget v2 definer owner'; end if;
end$$;

-- ===========================================================================
-- 9. Export chain (Law 6 — durable user configuration).
-- ===========================================================================
grant select on public.budget_targets, public.budget_expected_income to keel_export;
drop policy if exists budget_targets_export on public.budget_targets;
create policy budget_targets_export on public.budget_targets for select to keel_export using (true);
drop policy if exists budget_income_export on public.budget_expected_income;
create policy budget_income_export on public.budget_expected_income for select to keel_export using (true);

alter function public.keel_export_household(uuid,timestamptz) rename to keel_export_household_pre_budget_v2;
revoke all on function public.keel_export_household_pre_budget_v2(uuid,timestamptz) from public,anon,authenticated,service_role;
create function public.keel_export_household(p_household_id uuid, p_as_of timestamptz default null)
returns jsonb language plpgsql security definer stable set search_path = pg_catalog, public as $$
declare v_base jsonb; v_tables jsonb; begin
  v_base := public.keel_export_household_pre_budget_v2(p_household_id, p_as_of);
  select jsonb_build_object(
    'budget_targets', coalesce((select jsonb_agg(
        to_jsonb(x) || jsonb_build_object('amount_minor', x.amount_minor::text)
        order by x.category_ledger_account_id, x.effective_month)
      from public.budget_targets x where x.household_id = p_household_id), '[]'::jsonb),
    'budget_expected_income', coalesce((select jsonb_agg(
        to_jsonb(y) || jsonb_build_object('amount_minor', y.amount_minor::text)
        order by y.effective_month)
      from public.budget_expected_income y where y.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;
  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end$$;
revoke all on function public.keel_export_household(uuid,timestamptz) from public,anon,authenticated,service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid,timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid,timestamptz) to service_role;
