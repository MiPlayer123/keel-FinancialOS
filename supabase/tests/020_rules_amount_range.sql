-- C18 residual: rules multi-condition→action (design/TEARDOWN-STATUS-2026-07-17.md
-- queue item C18; migration 20260717220000). category_rules gains an
-- optional amount_min_minor/amount_max_minor RANGE, AND'd with the existing
-- pattern match inside keel_apply_rules — proves (1) backward compatibility
-- (Law 9): an existing null-range rule keeps matching exactly as before;
-- (2) the new AND semantics: below/within/above/at-the-edge of a range;
-- (3) the table CHECK constraints reject a negative bound or an inverted
-- range. Direct inserts into category_rules/canonical_transactions/
-- journal_* are pgTAP-only scaffolding (established ritual, see 019's
-- header) — the real command surface (keel_rule_save +
-- keel_worker_record_raw_event) is exercised end-to-end in
-- tests/integration/21-rules-amount-range.test.ts.
begin;select plan(13);

-- ---------------------------------------------------------------------------
-- Constraint tests: CHECK constraints reject bad amount-range payloads
-- before any rule matching ever runs.
-- ---------------------------------------------------------------------------
select throws_ok($$
  insert into public.category_rules
    (household_id, entity_id, pattern, category_ledger_account_id, amount_min_minor)
  values ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
          'BAD MIN', '00000000-0000-4000-8000-00000000a311', -100);
$$, '23514', null, 'negative amount_min_minor violates CHECK');

select throws_ok($$
  insert into public.category_rules
    (household_id, entity_id, pattern, category_ledger_account_id, amount_max_minor)
  values ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
          'BAD MAX', '00000000-0000-4000-8000-00000000a311', -1);
$$, '23514', null, 'negative amount_max_minor violates CHECK');

select throws_ok($$
  insert into public.category_rules
    (household_id, entity_id, pattern, category_ledger_account_id, amount_min_minor, amount_max_minor)
  values ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
          'INVERTED RANGE', '00000000-0000-4000-8000-00000000a311', 9000, 1000);
$$, '23514', null, 'amount_min_minor > amount_max_minor violates CHECK');

select lives_ok($$
  insert into public.category_rules
    (household_id, entity_id, pattern, category_ledger_account_id, amount_min_minor, amount_max_minor)
  values ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
          'EQUAL BOUNDS OK', '00000000-0000-4000-8000-00000000a311', 5000, 5000);
$$, 'amount_min_minor = amount_max_minor (a single-point range) is allowed');

-- ---------------------------------------------------------------------------
-- Fixtures: three rules — legacy (both bounds null), min-only ("$50+"), and
-- a closed range ($20-$80) — each on its own distinctive pattern so they
-- cannot cross-match each other's transactions.
-- ---------------------------------------------------------------------------
insert into public.category_rules
  (id, household_id, entity_id, pattern, category_ledger_account_id, priority, active)
values
  ('c8000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'LEGACY DINER',
   '00000000-0000-4000-8000-00000000a311', 100, true);
insert into public.category_rules
  (id, household_id, entity_id, pattern, category_ledger_account_id, priority, active, amount_min_minor)
values
  ('c8000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'SUB SERVICE',
   '00000000-0000-4000-8000-00000000a314', 100, true, 5000);
insert into public.category_rules
  (id, household_id, entity_id, pattern, category_ledger_account_id, priority, active,
   amount_min_minor, amount_max_minor)
values
  ('c8000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'RANGE SHOP',
   '00000000-0000-4000-8000-00000000a311', 100, true, 2000, 8000);

-- Six single-offset transactions, each landed Uncategorized (a317) at the
-- ledger level so keel_apply_rules has somewhere to move them FROM.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c8000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'LEGACY DINER #1', '2026-07-11', 'pgtap:amtrange:t1'),
  ('c8000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'SUB SERVICE BELOW', '2026-07-11', 'pgtap:amtrange:t2'),
  ('c8000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'SUB SERVICE ABOVE', '2026-07-11', 'pgtap:amtrange:t3'),
  ('c8000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'RANGE SHOP TOO LOW', '2026-07-11', 'pgtap:amtrange:t4'),
  ('c8000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'RANGE SHOP INSIDE', '2026-07-11', 'pgtap:amtrange:t5'),
  ('c8000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'RANGE SHOP TOO HIGH', '2026-07-11', 'pgtap:amtrange:t6');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000011', 'LEGACY DINER #1', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d1'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000012', 'SUB SERVICE BELOW', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d2'),
  ('c8000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000013', 'SUB SERVICE ABOVE', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d3'),
  ('c8000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000014', 'RANGE SHOP TOO LOW', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d4'),
  ('c8000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000015', 'RANGE SHOP INSIDE', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d5'),
  ('c8000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-00000000a001',
   'c8000000-0000-4000-8000-000000000016', 'RANGE SHOP TOO HIGH', '2026-07-11', 'c8000000-0000-4000-8000-0000000000d6');
-- amount_minor magnitudes: t1=1500 (legacy, any amount); t2=3000 (< 5000
-- floor, no match); t3=6000 (>= 5000 floor, matches); t4=1000 (< 2000
-- floor, no match); t5=5000 (inside [2000,8000], matches); t6=9000 (> 8000
-- ceiling, no match). Cash leg negative (expense), category leg positive —
-- abs() makes the sign irrelevant either way (comment in the migration).
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -1500, 'USD'),
  ('c8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 1500, 'USD'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -3000, 'USD'),
  ('c8000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 3000, 'USD'),
  ('c8000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -6000, 'USD'),
  ('c8000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 6000, 'USD'),
  ('c8000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c8000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 1000, 'USD'),
  ('c8000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -5000, 'USD'),
  ('c8000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 5000, 'USD'),
  ('c8000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -9000, 'USD'),
  ('c8000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 9000, 'USD');

-- ---------------------------------------------------------------------------
-- Dry-run preview: exactly the 3 transactions inside their rule's range
-- (t1 legacy, t3 above-floor, t5 inside-range) should count; the 3 outside
-- (t2, t4, t6) must not. keel_apply_rules is SECURITY DEFINER and accepts a
-- null auth.uid() (system/service_role caller path) — no JWT needed here.
-- ---------------------------------------------------------------------------
select is(
  (select (public.keel_apply_rules('00000000-0000-4000-8000-00000000a001', true)->>'categorized')::int),
  3,
  'dry run: exactly 3 of 6 fixture transactions match their rule (amount-range AND pattern)'
);

select is(
  (select (public.keel_apply_rules('00000000-0000-4000-8000-00000000a001', false)->>'categorized')::int),
  3,
  'apply matches the dry-run count exactly (preview integrity, BC-v2.1 §3)'
);

select is(
  (select category_ledger_account_id from public.transaction_categories
     where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000011'),
  '00000000-0000-4000-8000-00000000a311'::uuid,
  't1 (legacy, null-range rule): categorized regardless of amount — backward compatible (Law 9)'
);
select ok(
  not exists (select 1 from public.transaction_categories
    where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000012'),
  't2 (SUB SERVICE, $30 < $50 floor): amount below amount_min_minor does NOT match'
);
select is(
  (select category_ledger_account_id from public.transaction_categories
     where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000013'),
  '00000000-0000-4000-8000-00000000a314'::uuid,
  't3 (SUB SERVICE, $60 >= $50 floor): amount at/above amount_min_minor matches'
);
select ok(
  not exists (select 1 from public.transaction_categories
    where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000014'),
  't4 (RANGE SHOP, $10 < $20 floor): below the range does NOT match'
);
select is(
  (select category_ledger_account_id from public.transaction_categories
     where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000015'),
  '00000000-0000-4000-8000-00000000a311'::uuid,
  't5 (RANGE SHOP, $50 inside [$20,$80]): matches'
);
select ok(
  not exists (select 1 from public.transaction_categories
    where canonical_transaction_id = 'c8000000-0000-4000-8000-000000000016'),
  't6 (RANGE SHOP, $90 > $80 ceiling): above the range does NOT match'
);

-- ---------------------------------------------------------------------------
-- Re-running apply is idempotent: a second dry-run reports 0 (already
-- applied), proving the amount-range predicate doesn't perpetually re-fire.
-- ---------------------------------------------------------------------------
select is(
  (select (public.keel_apply_rules('00000000-0000-4000-8000-00000000a001', true)->>'categorized')::int),
  0,
  're-running dry-run after apply reports 0 — already-applied rows are stable, not re-matched forever'
);

select * from finish();rollback;
