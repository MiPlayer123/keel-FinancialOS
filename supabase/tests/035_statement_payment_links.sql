-- Statement ingestion SLICE 8 (statement-ingestion-v2.md §5 [A7]): card-payment
-- ↔ statement links. Proves the DETERMINISTIC exact-only matcher (Law 1), the
-- suggest→approve decide/detach loop (Law 10, class B; confirm never
-- auto-confirms a transfer), rejected-not-resurrected, window inclusivity,
-- ambiguity-abstain, and tenant isolation (Law 7).
--
-- Alpha seed: household a001, entity a101, checking a401 (ledger a301, asset),
-- card a402 (ledger a302, LIABILITY). User 0001 owns a001 + card a402. Beta seed:
-- household b001, checking b401. Privileged direct inserts are pgTAP-only
-- scaffolding (this layer runs as the migration role by design); the runtime
-- surface goes through the procs below.
begin; select no_plan();

-- ---------------------------------------------------------------------------
-- 0. Structure guards.
-- ---------------------------------------------------------------------------
select has_table('public', 'statement_payment_links', 'payment link table exists');
select has_function('public', 'keel_statement_suggest_payments', array['uuid','uuid'],
  'deterministic suggester exists');
select has_function('public', 'keel_cmd_statements_decide_payment_link',
  array['uuid','text','jsonb','uuid','jsonb'], 'decide command exists');
select has_function('public', 'keel_cmd_statements_detach_payment_link',
  array['uuid','text','jsonb','uuid','jsonb'], 'detach command exists');
select has_function('public', 'keel_list_statement_payment_links', array['uuid','uuid'],
  'payment link read exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='public.keel_cmd_statements_decide_payment_link(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api', 'decide command owned by keel_api');
-- Guarantee by construction: the decide command NEVER calls
-- keel_decide_transfer with a true confirm (Law 10 — the transfer keeps its own
-- approval). It may only run the detector (which writes 'suggested' only).
select ok(
  pg_get_functiondef('public.keel_cmd_statements_decide_payment_link(uuid,text,jsonb,uuid,jsonb)'::regprocedure)
    not like '%keel_decide_transfer%',
  'decide command NEVER calls keel_decide_transfer (never auto-confirms a transfer, Law 10)');
select ok(
  pg_get_functiondef('public.keel_statement_suggest_payments(uuid,uuid)'::regprocedure)
    not like '%keel_decide_transfer%',
  'suggester NEVER calls keel_decide_transfer');

-- ---------------------------------------------------------------------------
-- Fixtures. A LIABILITY statement on card a402: period 2026-05-01..2026-05-31,
-- ending_minor 50000 (a $500 balance). A card-side INFLOW of +$500 on 2026-06-10
-- (inside [period_end, period_end+35d]) is the exact payment. Also a NON-match
-- $300 inflow (wrong amount) and a $500 OUTFLOW (wrong sign) to prove the guards.
-- ---------------------------------------------------------------------------
insert into public.statements
  (id, household_id, account_id, period_start, period_end, opening_minor, ending_minor, currency, source_hash, created_by)
values
  ('d1000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a402', '2026-05-01', '2026-05-31', 0, 50000, 'USD',
   repeat('a', 64), '00000000-0000-4000-8000-000000000001');

-- The exact card-side payment (+$500 inflow on the liability account).
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('d1000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'PAYMENT - THANK YOU', '2026-06-10', 'pgtap:pay:exact'),
  -- Wrong amount ($300) — must NOT match.
  ('d1000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'PARTIAL PAYMENT', '2026-06-11', 'pgtap:pay:wrongamt'),
  -- Right amount but OUTFLOW (a purchase, sign wrong) — must NOT match.
  ('d1000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'BIG PURCHASE 500', '2026-06-12', 'pgtap:pay:outflow'),
  -- Exact amount but OUTSIDE the window (period_end + 36d) — must NOT match.
  ('d1000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'LATE PAYMENT', '2026-07-06', 'pgtap:pay:late');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d1000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000101', 'exact pay', '2026-06-10', 'd1000000-0000-4000-8000-0000000000c1'),
  ('d1000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000102', 'partial', '2026-06-11', 'd1000000-0000-4000-8000-0000000000c2'),
  ('d1000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000103', 'purchase', '2026-06-12', 'd1000000-0000-4000-8000-0000000000c3'),
  ('d1000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000104', 'late pay', '2026-07-06', 'd1000000-0000-4000-8000-0000000000c4');
-- Card-side posting on a302 (liability). +50000 = payment (inflow); -50000 = purchase.
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('d1000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  50000, 'USD'),
  ('d1000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101', -50000, 'USD'),
  ('d1000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  30000, 'USD'),
  ('d1000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101', -30000, 'USD'),
  ('d1000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101', -50000, 'USD'),
  ('d1000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101',  50000, 'USD'),
  ('d1000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  50000, 'USD'),
  ('d1000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101', -50000, 'USD');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- 1. EXACT match: exactly one exact inflow → one 'suggested' link (score 100),
--    NOT auto-confirmed, on the exact-amount txn only (guards prove exclusivity).
-- ---------------------------------------------------------------------------
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000001'),
  1, 'exact-only matcher writes exactly one suggestion');
select is(
  (select count(*)::int from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  1, 'exactly one link row written');
select is(
  (select canonical_transaction_id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  'd1000000-0000-4000-8000-000000000101',
  'the link points at the exact-amount inflow (not the $300, the outflow, or the late one)');
select is(
  (select status::text from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  'suggested', 'NEVER auto-confirmed — status is suggested (Law 10)');
select is(
  (select score from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  100, 'exact score is 100');
select ok(
  (select 'exact_amount' = any(reason_codes) from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  'reason_codes carry exact_amount');

-- 1b. Idempotent replay: a second suggester pass adds no duplicate.
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000001'),
  0, 'replay writes no new suggestion');

-- 1c. Read model surfaces the link.
select is(
  jsonb_array_length(public.keel_list_statement_payment_links(
    '00000000-0000-4000-8000-00000000a001', 'd1000000-0000-4000-8000-000000000001')->'rows'),
  1, 'read model returns the one active link');

-- ---------------------------------------------------------------------------
-- 2. WINDOW INCLUSIVITY. A statement whose period_end == the payment date and
--    another whose period_end+35d == the payment date must both match (both
--    ends inclusive). period_end just past the payment must not.
-- ---------------------------------------------------------------------------
-- Statement B: period_end = 2026-06-10 (== payment date) → inclusive start.
insert into public.statements
  (id, household_id, account_id, period_start, period_end, opening_minor, ending_minor, currency, source_hash, created_by)
values
  ('d1000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a402', '2026-05-10', '2026-06-10', 0, 50000, 'USD',
   repeat('b', 64), '00000000-0000-4000-8000-000000000001');
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000002'),
  1, 'window START is inclusive: period_end == payment date matches');

-- Statement C: period_end = 2026-05-06 → period_end+35d = 2026-06-10 (== payment
-- date) → inclusive end.
insert into public.statements
  (id, household_id, account_id, period_start, period_end, opening_minor, ending_minor, currency, source_hash, created_by)
values
  ('d1000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a402', '2026-04-06', '2026-05-06', 0, 50000, 'USD',
   repeat('c', 64), '00000000-0000-4000-8000-000000000001');
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000003'),
  1, 'window END is inclusive: period_end+35d == payment date matches');

-- Statement D: period_end = 2026-06-11 → payment (2026-06-10) is BEFORE the
-- window start → no match.
insert into public.statements
  (id, household_id, account_id, period_start, period_end, opening_minor, ending_minor, currency, source_hash, created_by)
values
  ('d1000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a402', '2026-05-11', '2026-06-11', 0, 50000, 'USD',
   repeat('d', 64), '00000000-0000-4000-8000-000000000001');
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000004'),
  0, 'a payment BEFORE period_end is outside the window — no match');

-- ---------------------------------------------------------------------------
-- 3. AMBIGUITY ABSTAIN. Two exact inflows in-window for one statement → write
--    NOTHING (reason 'ambiguous'). Statement E ending 25000; two +$250 inflows.
-- ---------------------------------------------------------------------------
insert into public.statements
  (id, household_id, account_id, period_start, period_end, opening_minor, ending_minor, currency, source_hash, created_by)
values
  ('d1000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a402', '2026-01-01', '2026-01-31', 0, 25000, 'USD',
   repeat('e', 64), '00000000-0000-4000-8000-000000000001');
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('d1000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'PAYMENT A', '2026-02-05', 'pgtap:pay:ambigA'),
  ('d1000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'PAYMENT B', '2026-02-06', 'pgtap:pay:ambigB');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d1000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000301', 'ambig a', '2026-02-05', 'd1000000-0000-4000-8000-000000000e1'),
  ('d1000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-00000000a001',
   'd1000000-0000-4000-8000-000000000302', 'ambig b', '2026-02-06', 'd1000000-0000-4000-8000-000000000e2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('d1000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  25000, 'USD'),
  ('d1000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101', -25000, 'USD'),
  ('d1000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  25000, 'USD'),
  ('d1000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-00000000a316',
   '00000000-0000-4000-8000-00000000a101', -25000, 'USD');
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000005'),
  0, 'AMBIGUITY: >1 exact candidate → abstain, no link written');
select is(
  (select count(*)::int from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000005'),
  0, 'ambiguous statement has zero links');
select ok(
  exists(select 1 from public.audit_log
    where action='statements.payment_abstained'
      and object_id='d1000000-0000-4000-8000-000000000005'),
  'abstention is audited for provenance');

-- ---------------------------------------------------------------------------
-- 4. DECIDE — reject then rejected-NOT-resurrected. Reject the statement-A link,
--    then re-run the suggester: it must NOT re-create a suggestion for that pair.
-- ---------------------------------------------------------------------------
select lives_ok($$select public.keel_cmd_statements_decide_payment_link(
  'd1000000-0000-4000-8000-000000000f01','pgtap:decide:reject','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('linkId',(select id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),'confirm',false))$$,
  'reject a suggested payment link');
select is(
  (select status::text from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  'rejected', 'link is rejected');
select is(
  public.keel_statement_suggest_payments('00000000-0000-4000-8000-00000000a001',
    'd1000000-0000-4000-8000-000000000001'),
  0, 'REJECTED pair is NEVER resurrected on a re-run (on-conflict do nothing)');
select is(
  (select count(*)::int from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),
  1, 'still exactly one (rejected) row — no duplicate resurrected');

-- ---------------------------------------------------------------------------
-- 5. CONFIRM → DETACH round trip on statement B. Confirm binds the link; the
--    detector runs but NEVER auto-confirms a transfer. Detach undoes it.
-- ---------------------------------------------------------------------------
select lives_ok($$select public.keel_cmd_statements_decide_payment_link(
  'd1000000-0000-4000-8000-000000000f02','pgtap:decide:confirm','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('linkId',(select id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000002'),'confirm',true))$$,
  'confirm a suggested payment link');
select is(
  (select status::text from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000002'),
  'confirmed', 'link is confirmed');
-- The detector may have raised a transfer SUGGESTION, but nothing is a
-- CONFIRMED transfer (Law 10 — the transfer keeps its own approval).
select is(
  (select count(*)::int from public.transfer_links
    where household_id='00000000-0000-4000-8000-00000000a001' and status='confirmed'),
  0, 'confirm raised NO confirmed transfer (never auto-confirms)');
select ok(
  exists(select 1 from public.audit_log where action='statements.payment_confirmed'),
  'confirm is audited');

select lives_ok($$select public.keel_cmd_statements_detach_payment_link(
  'd1000000-0000-4000-8000-000000000f03','pgtap:detach','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('linkId',(select id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000002')))$$,
  'detach a confirmed payment link (undo, not delete)');
select is(
  (select status::text from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000002'),
  'detached', 'link is detached (row preserved — Law 2)');

-- 5b. Cannot re-decide a decided link; cannot detach a non-confirmed link.
select throws_ok($$select public.keel_cmd_statements_decide_payment_link(
  'd1000000-0000-4000-8000-000000000f04','pgtap:decide:again','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('linkId',(select id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),'confirm',true))$$,
  'P0009', null, 'a decided (rejected) link cannot be re-decided');

reset role;

-- ---------------------------------------------------------------------------
-- 6. TENANT ISOLATION (Law 7). User 0003 owns beta b001 but NOT alpha a001;
--    they must not suggest/read/decide alpha's statement payment links.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.keel_statement_suggest_payments(
  '00000000-0000-4000-8000-00000000a001','d1000000-0000-4000-8000-000000000003')$$,
  'P0006', null, 'a non-member cannot run the suggester on another household');
select throws_ok($$select public.keel_list_statement_payment_links(
  '00000000-0000-4000-8000-00000000a001','d1000000-0000-4000-8000-000000000001')$$,
  'P0006', null, 'a non-member cannot read another household payment links');
select throws_ok($$select public.keel_cmd_statements_decide_payment_link(
  'd1000000-0000-4000-8000-000000000f05','pgtap:cross','{}',
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('linkId',(select id from public.statement_payment_links
    where statement_id='d1000000-0000-4000-8000-000000000001'),'confirm',true))$$,
  null, null, 'a non-member cannot decide another household payment link');
reset role;

select * from finish(); rollback;
