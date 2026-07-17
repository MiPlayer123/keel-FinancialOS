-- Reviewed/unreviewed transaction state + "Auto" badge (P0-B follow-ups —
-- design/TEARDOWN-STATUS-2026-07-17.md queue items 2/3). Pure read-model
-- addition: keel_list_transactions_rich gains 'categorySource', sourced
-- straight from the transaction_categories.source primitive that already
-- existed (no new table/column/command — see 20260717200000's header
-- comment). Privileged direct inserts here are pgTAP-only scaffolding
-- (established ritual): these fixtures represent states that arise from
-- REAL surfaces already proven elsewhere (016 detection/decide, 20260713040000
-- rules engine, 20260713090000 PFC autocategorize, 018 set-splits) — this
-- file only proves the NEW field's derivation is correct for each state.
begin;select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: entity a101, checking ledger a301 (account a401),
-- categories a311 Groceries / a314 Coffee Shops / a317 Uncategorized Expense.
-- Five single-purpose transactions, one per categorySource state.
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c7000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'NEVER TOUCHED DINER', '2026-07-10', 'pgtap:reviewstate:t1'),
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'USER CONFIRMED DINER', '2026-07-10', 'pgtap:reviewstate:t2'),
  ('c7000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'RULE FILED DINER', '2026-07-10', 'pgtap:reviewstate:t3'),
  ('c7000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'PFC MAPPED DINER', '2026-07-10', 'pgtap:reviewstate:t4'),
  ('c7000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'SPLIT DINER', '2026-07-10', 'pgtap:reviewstate:t5');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000001', 'NEVER TOUCHED DINER', '2026-07-10',
   'c7000000-0000-4000-8000-0000000000c1'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000002', 'USER CONFIRMED DINER', '2026-07-10',
   'c7000000-0000-4000-8000-0000000000c2'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000003', 'RULE FILED DINER', '2026-07-10',
   'c7000000-0000-4000-8000-0000000000c3'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000004', 'PFC MAPPED DINER', '2026-07-10',
   'c7000000-0000-4000-8000-0000000000c4'),
  ('c7000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a001',
   'c7000000-0000-4000-8000-000000000005', 'SPLIT DINER', '2026-07-10',
   'c7000000-0000-4000-8000-0000000000c5');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  -- T1-T4: single offset, parked on the Uncategorized landing pad at the
  -- ledger level (the overlay, inserted separately below, is what actually
  -- carries the user-facing category for T2-T4).
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1000, 'USD'),
  -- T5: TWO category offsets (a real split, same shape 018 tests) — no
  -- transaction_categories row is ever written for it.
  ('c7000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1000, 'USD'),
  ('c7000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 600, 'USD'),
  ('c7000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-00000000a314',
   '00000000-0000-4000-8000-00000000a101', 400, 'USD');
-- T2/T3/T4 overlay rows — one per source value under test. T1 and T5
-- deliberately get NONE (the two "no overlay row" states).
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('c7000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a311', 'user'),
  ('c7000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a314', 'rule'),
  ('c7000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a311', 'plaid_pfc');

-- ---------------------------------------------------------------------------
-- Read model: one categorySource per state, exactly as Law 9 (explicit
-- ownership) requires — machine provenance is never silently equated with a
-- human decision.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table _rich on commit drop as
  select elem from jsonb_array_elements(
    public.keel_list_transactions_rich('00000000-0000-4000-8000-00000000a001')->'rows') as t(elem);
reset role;

select is(
  (select elem->'categorySource' from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000001'),
  'null'::jsonb,
  'never-categorized transaction (no overlay row): categorySource is null, not "auto"');
select is(
  (select elem->>'categorySource' from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000002'),
  'user', 'user-confirmed overlay: categorySource is user (reviewed)');
select is(
  (select elem->>'categorySource' from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000003'),
  'rule', 'rule-filed overlay: categorySource is rule (auto, unreviewed)');
select is(
  (select elem->>'categorySource' from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000004'),
  'plaid_pfc', 'PFC-mapped overlay: categorySource is plaid_pfc (auto, unreviewed)');
select is(
  (select elem->>'categorySource' from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000005'),
  'user',
  'split (no overlay row at all): categorySource reports user — reviewed by construction, '
  'the split can only exist via the audited transactions.set_splits command');
select is(
  (select jsonb_array_length(elem->'splits') from _rich where elem->>'transactionId' = 'c7000000-0000-4000-8000-000000000005'),
  2, 'sanity: T5 really is the two-way split it claims to be');

select * from finish();rollback;
