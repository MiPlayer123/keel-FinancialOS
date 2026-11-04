-- Budget parent rollup (Stage 2; BC-v2.1 §Budgets; Laws 1, 9).
-- Bug: keel_budget_month matched spend to a target by EXACT category, so spend
-- in subcategories never reached a parent's target (Oct 2026: Food & Drink
-- showed $185 while Restaurants/Bars/Coffee went to "everything else").
-- Model (Copilot "camp 1", user decision 2026-11-04): each target owns its own
-- slice. A parent target counts its own spend plus spend in children that have
-- no live target of their own; a child with its own target keeps its spend.
-- Plan total / leftToBudget stay additive (no double count). Parent rows gain
-- display-only group totals: groupResolvedMinor (own + budgeted children),
-- groupSpentMinor (everything underneath), rolledUpCategoryNames.
-- formulaVersion budget-v4-plan -> budget-v5-parent-rollup. Pure SQL, BIGINT.

create or replace function public.keel_budget_spent_attributed(p_household_id uuid, p_next date)
returns table (category_id uuid, source_category_id uuid, month date, spent_minor bigint)
language sql stable set search_path = public as $$
  -- v4 split-aware spend per (category, month), unchanged predicate.
  with offn as (
    select jp.batch_id, count(*) as n
      from public.journal_postings jp
      join public.ledger_accounts l on l.id = jp.ledger_account_id and l.is_category
      join public.journal_batches jb2 on jb2.id = jp.batch_id
     where jb2.household_id = p_household_id
     group by 1
  ),
  raw as (
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
       and jb.effective_date < p_next
       and (case when offn.n = 1 then coalesce(overcat.kind, offcat.kind) else offcat.kind end) = 'expense'
       and offp.currency = (case when offn.n = 1 then coalesce(overcat.currency, offcat.currency) else offcat.currency end)
       and not exists (
         select 1 from public.transfer_links tl
          where tl.household_id = p_household_id and tl.status = 'confirmed'
            and (tl.txn_out = ct.id or tl.txn_in = ct.id))
     group by 1, 2
  )
  -- Attribution (v5): own live target wins; else the parent's live target;
  -- else the category itself (unbudgeted -> "everything else").
  select case
           when exists (select 1 from public.budget_targets t
                         where t.household_id = p_household_id and t.category_ledger_account_id = raw.category_id
                           and t.effective_month <= raw.month and (t.end_month is null or t.end_month > raw.month))
             then raw.category_id
           when la.parent_ledger_account_id is not null and exists (
                  select 1 from public.budget_targets t
                   where t.household_id = p_household_id
                     and t.category_ledger_account_id = la.parent_ledger_account_id
                     and t.effective_month <= raw.month and (t.end_month is null or t.end_month > raw.month))
             then la.parent_ledger_account_id
           else raw.category_id
         end as category_id,
         raw.category_id as source_category_id,
         raw.month,
         raw.spent_minor
    from raw
    left join public.ledger_accounts la on la.id = raw.category_id
$$;

create or replace function public.keel_budget_month(p_household_id uuid, p_month date)
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

  -- Per-month spent across the whole horizon (so carry is exact), attributed
  -- to the row that owns it (v5): a category with its own
  -- live target keeps its spend; an untargeted child rolls into its parent's
  -- target; anything else stays unbudgeted. Same predicate as v4 otherwise.
  with attributed as (
    select * from public.keel_budget_spent_attributed(p_household_id, v_next)
  ),
  monthly_spent as (
    select a.category_id, a.month, sum(a.spent_minor)::bigint as spent_minor
      from attributed a group by 1, 2
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
             else r.resolved_minor::text end,
           -- Group view (parents only): own target + budgeted children's
           -- targets, and all spend underneath. Display-only; the plan math
           -- above stays per-row so nothing is counted twice.
           'groupResolvedMinor', case when g.is_parent
             then (r.resolved_minor + g.child_resolved)::text end,
           'groupSpentMinor', case when g.is_parent
             then (coalesce(s.spent_minor, 0) + g.child_spent)::text end,
           'rolledUpCategoryNames', case when g.is_parent then g.rolled_names end
         ) order by r.category_name), '[]'::jsonb)
    into v_rows
    from resolved r
    left join monthly_spent s on s.category_id = r.category_id and s.month = v_month
    left join carry c on c.category_id = r.category_id
    cross join lateral (
      select exists (select 1 from public.ledger_accounts ch
                      where ch.parent_ledger_account_id = r.category_id) as is_parent,
             coalesce((select sum(cr.resolved_minor) from resolved cr
                        where cr.parent_ledger_account_id = r.category_id), 0)::bigint as child_resolved,
             coalesce((select sum(cs.spent_minor) from resolved cr
                         join monthly_spent cs on cs.category_id = cr.category_id and cs.month = v_month
                        where cr.parent_ledger_account_id = r.category_id), 0)::bigint as child_spent,
             coalesce((select jsonb_agg(distinct la2.name order by la2.name)
                         from attributed a2
                         join public.ledger_accounts la2 on la2.id = a2.source_category_id
                        where a2.category_id = r.category_id and a2.month = v_month
                          and a2.source_category_id <> r.category_id and a2.spent_minor <> 0),
                      '[]'::jsonb) as rolled_names
    ) g;

  -- Everything else = this month's spend that no live target owns after
  -- attribution (so rolled-up child spend is not double-counted here).
  select coalesce(sum(a.spent_minor) filter (
           where not exists (
             select 1 from public.budget_targets t
              where t.household_id = p_household_id and t.category_ledger_account_id = a.category_id
                and t.effective_month <= v_month and (t.end_month is null or t.end_month > v_month))
         ), 0)::bigint
    into v_everything_else
    from public.keel_budget_spent_attributed(p_household_id, v_next) a
   where a.month = v_month;

  return jsonb_build_object(
    'scope', jsonb_build_object('householdId', p_household_id, 'month', to_char(v_month,'YYYY-MM')),
    'asOf', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'formulaVersion', 'budget-v5-parent-rollup',
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

-- Ownership + grants: same as v4 (definer read owned by keel_api). The helper
-- is invoker-mode and internal (no membership check) — never granted to users.
grant create on schema public to keel_api;
alter function public.keel_budget_month(uuid,date) owner to keel_api;
alter function public.keel_budget_spent_attributed(uuid,date) owner to keel_api;
revoke create on schema public from keel_api;
revoke all on function public.keel_budget_month(uuid,date) from public, anon;
revoke all on function public.keel_budget_spent_attributed(uuid,date) from public, anon, authenticated;
grant execute on function public.keel_budget_month(uuid,date) to authenticated, service_role;

do $$begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='public' and p.proname = 'keel_budget_month' and p.prosecdef and r.rolname<>'keel_api') then
    raise exception 'KEEL_OWNERSHIP: keel_budget_month definer owner'; end if;
end$$;
