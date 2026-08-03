-- 20260720150000: confirming a transfer categorizes its legs (inflow →
-- Transfers In, outflow → Transfers Out, source 'transfer_confirm'); undo
-- restores the pre-confirm state (deletes those overlays). A user overlay on a
-- leg is never stomped (Law 9). The categorization detector suppresses
-- suggestions for a transaction already in an active link. Reversible
-- (invariant 5); audited (Law 2). Privileged direct inserts are pgTAP-only
-- scaffolding; confirm/undo go through the runtime procs.
begin; select no_plan();

-- ---------------------------------------------------------------------------
-- Structure guards.
-- ---------------------------------------------------------------------------
select has_function('public', 'keel_transfer_categorize_legs',
  array['uuid','uuid','uuid','jsonb'], 'the confirm-time leg categorizer exists');
select has_function('public', 'keel_transfer_restore_legs',
  array['uuid','uuid','uuid','jsonb'], 'the undo restore helper exists');
select ok(
  pg_get_functiondef('public.keel_decide_transfer(uuid,uuid,boolean)'::regprocedure)
    like '%keel_transfer_categorize_legs%',
  'keel_decide_transfer categorizes legs on confirm');
select ok(
  pg_get_functiondef('public.keel_undo_transfer(uuid,uuid)'::regprocedure)
    like '%keel_transfer_restore_legs%',
  'keel_undo_transfer restores leg categories');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: household a001, entity a101, accounts a401 (checking,
-- ledger a301) / a402 (card, ledger a302). Seed the Transfers In / Out / and an
-- uncategorized-expense/-income offset with pfc_keys (a101 excluded from the
-- migration backfill). A two-sided transfer: -$200 out (a301) / +$200 in (a302).
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values
  ('cb000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers Out', 'expense', 'USD', true, 'transfers_out', true),
  ('cb000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers In', 'income', 'USD', true, 'transfers_in', true),
  ('cb000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Groceries (fx)', 'expense', 'USD', true, 'food_drink_groceries', true);
-- NB: a101's uncategorized_expense (a317) and uncategorized_income (a318) are
-- already seeded WITH their pfc_keys by supabase/seed.sql, so we reference those
-- seeded accounts below instead of inserting duplicates (the (entity_id,
-- pfc_key) uniqueness constraint would otherwise reject the insert).

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('cb000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Transfer out', '2026-06-05', 'pgtap:cl:out'),
  ('cb000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Transfer in', '2026-06-05', 'pgtap:cl:in');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('cb000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000101', 'out', '2026-06-05', 'cb000000-0000-4000-8000-000000000c1'),
  ('cb000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000102', 'in', '2026-06-05', 'cb000000-0000-4000-8000-000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('cb000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  ('cb000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('cb000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('cb000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD');

-- Give the INFLOW leg a TRANSFER_IN PFC record — WITHOUT the suppression
-- predicate this would mint a 'Transfers In' suggestion (20260719020000). It
-- must be suppressed because the leg is in an active link. (Add the food_drink
-- parent so the outflow leg could also be resolved; here only the inflow carries
-- evidence.)
insert into public.raw_provider_events
  (id, household_id, connection_id, provider, provider_event_id, account_external_ref, body, body_text, received_at)
values
  ('cb000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a202', 'plaid', 'pgtap-cl-sync-1', 'sim-acct-card',
   '{}'::jsonb,
   '{"added":[{"transaction_id":"pgtap-cl-pt1","personal_finance_category":{"primary":"TRANSFER_IN"}}]}',
   now());
insert into public.normalized_source_records
  (id, raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency, effective_date, description, pending, pfc_primary)
values
  ('cb000000-0000-4000-8000-000000000801', 'cb000000-0000-4000-8000-000000000701',
   '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a402',
   'pgtap-cl-pt1', 20000, 'USD', '2026-06-05', 'Transfer in', false, 'TRANSFER_IN');
insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id, household_id)
values
  ('cb000000-0000-4000-8000-000000000102', 'cb000000-0000-4000-8000-000000000801',
   '00000000-0000-4000-8000-00000000a001');

-- A suggested link (as the detector would produce).
insert into public.transfer_links (id, household_id, txn_out, txn_in, status)
values
  ('cb000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000101', 'cb000000-0000-4000-8000-000000000102', 'suggested');

-- ---------------------------------------------------------------------------
-- Before confirm: neither leg has an overlay, so the detector WOULD normally
-- consider them — but the suppression predicate excludes them (they are in an
-- active suggested link). Assert no suggestion is minted for them.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id in
      ('cb000000-0000-4000-8000-000000000101','cb000000-0000-4000-8000-000000000102')),
  0, 'before confirm, the transfer legs have no overlay');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001');
reset role;
select is(
  (select count(*)::int from public.category_suggestions
    where canonical_transaction_id in
      ('cb000000-0000-4000-8000-000000000101','cb000000-0000-4000-8000-000000000102')),
  0, 'the detector suppresses suggestions for a transaction already in an active link');

-- ---------------------------------------------------------------------------
-- Confirm via keel_decide_transfer → both legs categorized.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select public.keel_decide_transfer('00000000-0000-4000-8000-00000000a001',
  'cb000000-0000-4000-8000-000000000301', true);
reset role;

select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000101'),
  'cb000000-0000-4000-8000-000000000010'::uuid,
  'the OUTFLOW leg is categorized Transfers Out on confirm');
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000102'),
  'cb000000-0000-4000-8000-000000000011'::uuid,
  'the INFLOW leg is categorized Transfers In on confirm');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000101'),
  'transfer_confirm', 'the leg overlay carries source transfer_confirm');
-- Audited (Law 2): a categorize_leg audit row exists for each leg.
select is(
  (select count(*)::int from public.audit_log
    where action = 'transfers.categorize_leg'
      and object_id in ('cb000000-0000-4000-8000-000000000101','cb000000-0000-4000-8000-000000000102')),
  2, 'each leg categorization writes an audit row');

-- ---------------------------------------------------------------------------
-- Undo via keel_undo_transfer → both leg overlays restored (deleted).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select public.keel_undo_transfer('00000000-0000-4000-8000-00000000a001',
  'cb000000-0000-4000-8000-000000000301');
reset role;

select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id in
      ('cb000000-0000-4000-8000-000000000101','cb000000-0000-4000-8000-000000000102')),
  0, 'undo restores the pre-confirm state: the transfer_confirm overlays are removed');
select is(
  (select count(*)::int from public.audit_log
    where action = 'transfers.restore_leg'
      and object_id in ('cb000000-0000-4000-8000-000000000101','cb000000-0000-4000-8000-000000000102')),
  2, 'each leg restore writes an audit row');

-- ---------------------------------------------------------------------------
-- Explicit-ownership guard (Law 9): a user overlay on a leg is NEVER stomped by
-- confirm, and NEVER deleted by undo. New pair; put a user Groceries overlay on
-- the outflow leg first.
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('cb000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Transfer out (user-cat)', '2026-06-07', 'pgtap:cl:out2'),
  ('cb000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Transfer in 2', '2026-06-07', 'pgtap:cl:in2');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('cb000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000401', 'out2', '2026-06-07', 'cb000000-0000-4000-8000-000000000d1'),
  ('cb000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000402', 'in2', '2026-06-07', 'cb000000-0000-4000-8000-000000000d2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('cb000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -15000, 'USD'),
  ('cb000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  15000, 'USD'),
  ('cb000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  15000, 'USD'),
  ('cb000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -15000, 'USD');
-- User already filed the outflow leg as Groceries.
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('cb000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000014', 'user');
insert into public.transfer_links (id, household_id, txn_out, txn_in, status)
values
  ('cb000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-00000000a001',
   'cb000000-0000-4000-8000-000000000401', 'cb000000-0000-4000-8000-000000000402', 'suggested');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select public.keel_decide_transfer('00000000-0000-4000-8000-00000000a001',
  'cb000000-0000-4000-8000-000000000601', true);
reset role;

select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000401'),
  'cb000000-0000-4000-8000-000000000014'::uuid,
  'Law 9: a user Groceries overlay on a leg is NOT overwritten by confirm');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000401'),
  'user', 'the user overlay keeps its source');
-- The inflow leg (no prior overlay) still gets Transfers In.
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000402'),
  'cb000000-0000-4000-8000-000000000011'::uuid,
  'the un-owned inflow leg still gets Transfers In');

-- Undo must not delete the user overlay.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select public.keel_undo_transfer('00000000-0000-4000-8000-00000000a001',
  'cb000000-0000-4000-8000-000000000601');
reset role;
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000401'),
  'cb000000-0000-4000-8000-000000000014'::uuid,
  'undo leaves the user Groceries overlay intact');
select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id = 'cb000000-0000-4000-8000-000000000402'),
  0, 'undo removes the transfer_confirm overlay from the un-owned inflow leg');

select * from finish(); rollback;
