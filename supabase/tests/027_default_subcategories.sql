-- WS-G / FEEDBACK.md F-016a: default subcategory seed
-- (20260718140000_default_subcategories.sql). Fixture entities are excluded
-- from seeding by design, so the probe creates a FRESH entity in the alpha
-- household — the entities-insert trigger runs the full seed — and asserts
-- against that. Everything rolls back.
begin;select no_plan();

-- Probe entity: trigger seeds parents + subcategories.
insert into public.entities (id, household_id, name, kind)
values ('d0240000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-00000000a001',
        'Subcategory Seed Probe', 'personal');

-- T1: the top-level taxonomy still seeds (21 rows: 19 expense/income categories
-- + Opening Balances + the income-kind "Transfers In" added by 20260719020000)
-- and the subcategory layer lands on top of it.
select is(
  (select count(*)::int from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'
      and parent_ledger_account_id is null),
  21, 'fresh entity gets the 21 top-level seeded ledger accounts');
select is(
  (select count(*)::int from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'
      and parent_ledger_account_id is not null),
  53, 'fresh entity gets the 53 default subcategories');

-- T2: subs sit under the RIGHT parents, keyed (spot checks across kinds).
select is(
  (select p.pfc_key from public.ledger_accounts c
     join public.ledger_accounts p on p.id = c.parent_ledger_account_id
    where c.entity_id = 'd0240000-0000-4000-8000-000000000001'
      and c.pfc_key = 'food_drink_groceries'),
  'food_drink', 'Groceries nests under Food & Drink');
select is(
  (select p.pfc_key from public.ledger_accounts c
     join public.ledger_accounts p on p.id = c.parent_ledger_account_id
    where c.entity_id = 'd0240000-0000-4000-8000-000000000001'
      and c.pfc_key = 'travel_flights'),
  'travel', 'Flights nests under Travel');
select is(
  (select p.pfc_key from public.ledger_accounts c
     join public.ledger_accounts p on p.id = c.parent_ledger_account_id
    where c.entity_id = 'd0240000-0000-4000-8000-000000000001'
      and c.pfc_key = 'income_paycheck'),
  'income', 'Paycheck nests under Income (income kind)');

-- T3: structural sanity over the WHOLE seeded set — every sub matches its
-- parent's kind, is a system category, and the tree is exactly one level.
select is(
  (select count(*)::int from public.ledger_accounts c
     join public.ledger_accounts p on p.id = c.parent_ledger_account_id
    where c.entity_id = 'd0240000-0000-4000-8000-000000000001'
      and (c.kind <> p.kind or c.is_system is not true or c.is_category is not true
           or p.parent_ledger_account_id is not null)),
  0, 'every seeded sub matches parent kind, is system, and nests one level only');

-- T4: idempotent double-apply — re-running the seed inserts nothing.
select public.keel_seed_entity_categories(
  'd0240000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001');
select is(
  (select count(*)::int from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'),
  74, 'double-apply adds no rows (pfc_key dedupe)');

-- T5: an archived seeded sub is NOT resurrected by a re-run, and a re-run
-- does not re-insert it under its canonical name either.
update public.ledger_accounts set archived_at = now()
 where entity_id = 'd0240000-0000-4000-8000-000000000001'
   and pfc_key = 'travel_flights';
select public.keel_seed_entity_categories(
  'd0240000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001');
select is(
  (select count(*)::int from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'
      and pfc_key = 'travel_flights'),
  1, 'archived seeded sub stays a single (archived) row after re-seed');
select ok(
  (select archived_at is not null from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'
      and pfc_key = 'travel_flights'),
  'archived seeded sub stays archived after re-seed');

-- T6: a user category that name-collides with a would-be seed is respected —
-- the seed skips instead of erroring or duplicating. Archive 'Lodging' (frees
-- its live name slot), create a USER category named 'Lodging', re-run: pfc_key
-- travel_lodging stays deduped by the archived row, the name guard protects
-- the user's row, and re-seed must not raise on the CI name index.
update public.ledger_accounts set archived_at = now()
 where entity_id = 'd0240000-0000-4000-8000-000000000001'
   and pfc_key = 'travel_lodging';
insert into public.ledger_accounts
  (household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values ('00000000-0000-4000-8000-00000000a001',
        'd0240000-0000-4000-8000-000000000001',
        'Lodging', 'expense', 'USD', true, null, false);
select lives_ok(
  $$select public.keel_seed_entity_categories(
      'd0240000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-00000000a001')$$,
  're-seed survives a live user category shadowing a seeded name');
select is(
  (select count(*)::int from public.ledger_accounts
    where entity_id = 'd0240000-0000-4000-8000-000000000001'
      and lower(name) = 'lodging' and archived_at is null),
  1, 'exactly one live Lodging (the user''s) after re-seed');

-- T7: one-level constraint — nesting anything under a SUBCATEGORY is refused
-- by the tree trigger.
select throws_ok(
  $$insert into public.ledger_accounts
      (household_id, entity_id, name, kind, currency, is_category,
       pfc_key, is_system, parent_ledger_account_id)
    values ('00000000-0000-4000-8000-00000000a001',
            'd0240000-0000-4000-8000-000000000001',
            'Too Deep', 'expense', 'USD', true, null, false,
            (select id from public.ledger_accounts
              where entity_id = 'd0240000-0000-4000-8000-000000000001'
                and pfc_key = 'food_drink_groceries'))$$,
  'P0009', null, 'a subcategory cannot itself become a parent (one level only)');

-- T8: scope gate — the seed still fails closed on a forged entity/household
-- pairing (regression guard for the SECURITY DEFINER surface).
select throws_ok(
  $$select public.keel_seed_entity_categories(
      'd0240000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-00000000b001')$$,
  'P0006', null, 'seed rejects an entity/household mismatch');

select * from finish();rollback;
