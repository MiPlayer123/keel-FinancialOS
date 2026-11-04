-- 20261104120000: budget parent rollup (Copilot model).
-- A parent target counts its own spend PLUS spend in child categories that
-- have no target of their own. A child with its own target keeps its spend.
-- Each dollar lands in exactly one row (or "everything else"), so the plan
-- total / leftToBudget stay additive. Parent rows also report group totals
-- (own + children's targets, all spend underneath) for display.
-- Privileged direct inserts are pgTAP-only scaffolding (fictional, ce… prefix).
begin; select no_plan();

-- Categories (Alpha / Personal):
--   Food (parent, target 35000, rollover from Sep)
--     ├ Groceries  (child, own target 15000)
--     ├ Coffee     (child, no target)  -> rolls into Food
--     └ Restaurants(child, no target)  -> rolls into Food
--   Fun (parent, NO target)
--     └ Bars       (child, no target)  -> everything else
--   Household (seed a312, no parent, no target) -> everything else
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, created_at, parent_ledger_account_id)
values
  ('ce000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Food', 'expense', 'USD', true, now(), null),
  ('ce000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Groceries', 'expense', 'USD', true, now(),
   'ce000000-0000-4000-8000-000000000001'),
  ('ce000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Coffee', 'expense', 'USD', true, now(),
   'ce000000-0000-4000-8000-000000000001'),
  ('ce000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Restaurants', 'expense', 'USD', true, now(),
   'ce000000-0000-4000-8000-000000000001'),
  ('ce000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Fun', 'expense', 'USD', true, now(), null),
  ('ce000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'PG Bars', 'expense', 'USD', true, now(),
   'ce000000-0000-4000-8000-000000000005');

insert into public.budget_targets
  (household_id, category_ledger_account_id, effective_month, end_month, target_kind,
   amount_minor, rollover, currency)
values
  ('00000000-0000-4000-8000-00000000a001', 'ce000000-0000-4000-8000-000000000001',
   '2026-09-01', null, 'amount', 35000, true, 'USD'),
  ('00000000-0000-4000-8000-00000000a001', 'ce000000-0000-4000-8000-000000000002',
   '2026-10-01', null, 'amount', 15000, false, 'USD');

-- Spend: one single-offset expense per row (checking a301 -> category).
create temp table pg_spend (n int, cat uuid, amt bigint, d date);
insert into pg_spend values
  (1, 'ce000000-0000-4000-8000-000000000001', 1000, '2026-10-03'),  -- Food direct
  (2, 'ce000000-0000-4000-8000-000000000002', 2000, '2026-10-04'),  -- Groceries (own target)
  (3, 'ce000000-0000-4000-8000-000000000003',  500, '2026-10-05'),  -- Coffee -> Food
  (4, 'ce000000-0000-4000-8000-000000000004', 3000, '2026-10-06'),  -- Restaurants -> Food
  (5, 'ce000000-0000-4000-8000-000000000006',  800, '2026-10-07'),  -- Bars -> everything else
  (6, '00000000-0000-4000-8000-00000000a312',  700, '2026-10-08'),  -- Household -> everything else
  (7, 'ce000000-0000-4000-8000-000000000004', 4000, '2026-09-10');  -- Sep Restaurants -> Food carry

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
select ('ce000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-4000-8000-00000000a001'::uuid, '00000000-0000-4000-8000-00000000a101'::uuid,
       '00000000-0000-4000-8000-00000000a401'::uuid, 'posted', 'manual', 'PG SPEND ' || n, d,
       'pgtap:budroll:' || n
  from pg_spend;
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
select ('ce000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-4000-8000-00000000a001'::uuid,
       ('ce000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'PG SPEND ' || n, d,
       ('ce000000-0000-4000-8000-0000000003' || lpad(n::text, 2, '0'))::uuid
  from pg_spend;
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select ('ce000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-4000-8000-00000000a301'::uuid, '00000000-0000-4000-8000-00000000a101'::uuid, -amt, 'USD'
  from pg_spend
union all
select ('ce000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       cat, '00000000-0000-4000-8000-00000000a101'::uuid, amt, 'USD'
  from pg_spend;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temp view pg_oct as
  select public.keel_budget_month('00000000-0000-4000-8000-00000000a001', '2026-10-01') as j;
create temp view pg_rows as
  select r from pg_oct, jsonb_array_elements(j->'rows') r;

select is((select j->>'formulaVersion' from pg_oct), 'budget-v5-parent-rollup', 'formula version bumped');

-- Parent: own 1000 + Coffee 500 + Restaurants 3000 (Groceries has its own target).
select is((select r->>'spentMinor' from pg_rows where r->>'categoryName' = 'PG Food'),
  '4500', 'parent spent includes children without their own target');
select is((select r->>'spentMinor' from pg_rows where r->>'categoryName' = 'PG Groceries'),
  '2000', 'child with its own target keeps its spend');

-- Group totals for display: target 35000 + 15000; spend 4500 + 2000.
select is((select r->>'groupResolvedMinor' from pg_rows where r->>'categoryName' = 'PG Food'),
  '50000', 'parent group target = own + budgeted children');
select is((select r->>'groupSpentMinor' from pg_rows where r->>'categoryName' = 'PG Food'),
  '6500', 'parent group spent = everything underneath');
select is((select r->'rolledUpCategoryNames' from pg_rows where r->>'categoryName' = 'PG Food'),
  '["PG Coffee", "PG Restaurants"]'::jsonb, 'parent lists the unbudgeted children it absorbed');
select ok((select r->>'groupResolvedMinor' is null from pg_rows where r->>'categoryName' = 'PG Groceries'),
  'child rows carry no group totals');

-- Bars (parent Fun has no target) + Household fall to everything else.
-- Seed activity in Oct 2026 for other alpha categories is none, so exact.
select is((select j->>'everythingElseSpentMinor' from pg_oct),
  '1500', 'children under an untargeted parent stay in everything else; rolled-up spend is not double-counted');

-- Carry uses the same attribution: Sep target 35000 - Sep Restaurants 4000.
select is((select r->>'carryMinor' from pg_rows where r->>'categoryName' = 'PG Food'),
  '31000', 'rollover carry counts rolled-up child spend in prior months');

-- Plan stays additive: implicit total = 35000 + 15000, rows sum to it.
select is((select j->>'leftToBudgetMinor' from pg_oct), '0', 'left to budget unchanged (no double count)');

reset role;
select * from finish(); rollback;
