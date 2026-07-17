-- Categorization review loop (P0-B core): suggestion table + deterministic
-- detection + decision command. Privileged direct inserts here are pgTAP-only
-- scaffolding (this layer runs as the migration role by design); every
-- runtime surface goes through the procs under test. The command's RPC happy
-- path is also covered by tests/integration/17-categorization-review.test.ts.
begin;select no_plan();

-- Surface + ownership (keel_api, non-BYPASSRLS — the established ritual).
select has_table('public', 'category_suggestions', 'suggestion table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.category_suggestions'::regclass),
  'category_suggestions has RLS enabled');
select has_function('public','keel_detect_category_suggestions',
  array['uuid'],'detection proc exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_detect_category_suggestions(uuid)'::regprocedure),
  'keel_api','detection proc owned by keel_api');
select has_function('public','keel_cmd_decide_category_suggestion',
  array['uuid','text','jsonb','uuid','jsonb'],'decision command exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_cmd_decide_category_suggestion(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api','decision command owned by keel_api');
select has_function('public','keel_list_category_suggestions',
  array['uuid'],'suggestion read model exists');

-- Admin-read regression guard (CI run 29559262657): tables created after the
-- one-time 210500 service_role grant pass need their own re-grant, or every
-- admin-client read 42501s and masquerades as "no rows" downstream.
select ok(has_table_privilege('service_role', 'public.transaction_categories', 'select'),
  'service_role can read the category overlay (integration assertions depend on it)');
select ok(has_table_privilege('service_role', 'public.category_suggestions', 'select'),
  'service_role can read category_suggestions');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: entity a101, account a401 (ledger a301), categories
-- a311 Groceries / a314 Coffee Shops, a317 Uncategorized Expense (pfc_key
-- 'uncategorized_expense' via the 20260713090000 backfill). Add one PFC-keyed
-- category so the PFC branch has a mapping target.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values
  ('c5000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Food & Drink', 'expense', 'USD', true,
   'food_drink', true),
  ('c5000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Shopping', 'expense', 'USD', true,
   'shopping', true);

-- T1: uncategorized (offset on the landing pad, no overlay). Both a matching
-- user rule AND a PFC mapping propose a category — the rule must win.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c5000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'BLUE BOTTLE COFFEE ROASTERS', '2026-07-10', 'pgtap:cat:t1'),
  ('c5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'CORNER DELI 42', '2026-07-11', 'pgtap:cat:t2');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c5000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c5000000-0000-4000-8000-000000000001', 'BLUE BOTTLE COFFEE ROASTERS', '2026-07-10',
   'c5000000-0000-4000-8000-0000000000c1'),
  ('c5000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c5000000-0000-4000-8000-000000000002', 'CORNER DELI 42', '2026-07-11',
   'c5000000-0000-4000-8000-0000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c5000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('c5000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 4300, 'USD'),
  ('c5000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -1200, 'USD'),
  ('c5000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1200, 'USD');

-- T2 carries a PFC-written overlay (Groceries): the "PFC-defaulted" target
-- class. Its raw PFC event maps to Food & Drink (differs from current).
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('c5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a311', 'plaid_pfc');

-- Raw PFC evidence for BOTH transactions (T1's must lose to the rule).
-- T2 deliberately carries TWO source links with CONTRADICTORY primaries
-- (posted pt2 = FOOD_AND_DRINK, pending pt2b = GENERAL_MERCHANDISE → the
-- multi-link fan-out of adversarial review P2-1); the posted record must win
-- and T2 must get exactly ONE suggestion.
insert into public.raw_provider_events
  (id, household_id, connection_id, provider, provider_event_id, account_external_ref,
   body, body_text, received_at)
values
  ('c5000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a202', 'plaid', 'pgtap-cat-sync-1', 'sim-acct-checking',
   '{}'::jsonb,
   '{"added":[{"transaction_id":"pgtap-cat-pt1","personal_finance_category":{"primary":"FOOD_AND_DRINK"}},{"transaction_id":"pgtap-cat-pt2","personal_finance_category":{"primary":"FOOD_AND_DRINK"}},{"transaction_id":"pgtap-cat-pt2b","personal_finance_category":{"primary":"GENERAL_MERCHANDISE"}}]}',
   now());
insert into public.normalized_source_records
  (id, raw_event_id, household_id, account_id, provider_transaction_id,
   amount_minor, currency, effective_date, description, pending)
values
  ('c5000000-0000-4000-8000-000000000031', 'c5000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a401',
   'pgtap-cat-pt1', -4300, 'USD', '2026-07-10', 'BLUE BOTTLE COFFEE ROASTERS', false),
  ('c5000000-0000-4000-8000-000000000032', 'c5000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a401',
   'pgtap-cat-pt2', -1200, 'USD', '2026-07-11', 'CORNER DELI 42', false),
  ('c5000000-0000-4000-8000-000000000033', 'c5000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a401',
   'pgtap-cat-pt2b', -1200, 'USD', '2026-07-11', 'CORNER DELI 42', true);
insert into public.transaction_source_links
  (canonical_transaction_id, normalized_source_record_id, household_id)
values
  ('c5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000031',
   '00000000-0000-4000-8000-00000000a001'),
  ('c5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000032',
   '00000000-0000-4000-8000-00000000a001'),
  ('c5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000033',
   '00000000-0000-4000-8000-00000000a001');

-- User rule matching T1 only, filing to Coffee Shops.
insert into public.category_rules
  (id, household_id, entity_id, pattern, category_ledger_account_id, priority, active)
values
  ('c5000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'blue bottle',
   '00000000-0000-4000-8000-00000000a314', 10, true);

-- ---------------------------------------------------------------------------
-- Detection: deterministic, idempotent, rule-beats-PFC, suggestion-only.
-- ---------------------------------------------------------------------------
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  2, 'detection proposes one suggestion per target transaction');
select is(
  (select count(*)::int from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  1, 'rule beats PFC: the rule-matched transaction gets exactly one suggestion');
select is(
  (select source from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  'rule', 'T1 suggestion comes from the user rule');
select is(
  (select suggested_category_ledger_account_id from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-00000000a314'::uuid, 'T1 suggests Coffee Shops');
select is(
  (select count(*)::int from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  1, 'contradictory multi-link PFC evidence collapses to ONE suggestion (P2-1)');
select is(
  (select source from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  'pfc', 'PFC-defaulted T2 gets a PFC suggestion');
select is(
  (select suggested_category_ledger_account_id from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  'c5000000-0000-4000-8000-000000000010'::uuid, 'T2 suggests the PFC-mapped category');

-- Idempotent re-detection: two calls, no duplicates.
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  0, 'second detection pass inserts nothing');
select is(
  (select count(*)::int from public.category_suggestions
    where household_id = '00000000-0000-4000-8000-00000000a001'),
  2, 'suggestion rows are stable across re-detection');

-- Detection wrote NO classification (suggest→approve, Law 2).
select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  0, 'a suggestion alone never touches the overlay');

-- ---------------------------------------------------------------------------
-- Accept: applies the overlay via the user path, audits, replays idempotently.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d1', 'pgtap:cat:decide:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'suggestion_id', (select id from public.category_suggestions
        where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
      'accept', true))
$$, 'owner accepts the rule suggestion');
select is(
  (select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d2', 'pgtap:cat:decide:t1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'suggestion_id', (select id from public.category_suggestions
        where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
      'accept', true)) ->> 'idempotentReplay'),
  'true', 'replaying the same economic event key is a no-op replay');
reset role;

-- T1 had NO overlay row before this accept (asserted count=0 above), so this
-- proves the accept path INSERTS on absence — not merely updates an existing
-- row (CI round-3 hypothesis; the insert-on-absent path is the normal case
-- for synced/manual transactions parked on the landing pad).
select is(
  (select count(*)::int from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  1, 'accept INSERTS the overlay row when none existed');
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-00000000a314'::uuid,
  'accept applies the suggested category to the overlay');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  'user', 'an approved categorization is a USER classification (rules cannot clobber it)');
select is(
  (select status from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001'),
  'accepted', 'suggestion transitions to accepted');
select is(
  (select count(*)::int from public.audit_log
    where action = 'categorization.decide_suggestion'
      and object_id = (select id from public.category_suggestions
        where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000001')),
  1, 'the decision is on the append-only audit trail exactly once');

-- The accepted transaction is settled: re-detection leaves it alone.
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  0, 'an accepted (user-classified) transaction is never re-suggested');

-- ---------------------------------------------------------------------------
-- Dismiss: records the decision, never touches the overlay.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d3', 'pgtap:cat:decide:t2', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'suggestion_id', (select id from public.category_suggestions
        where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
      'accept', false))
$$, 'owner dismisses the PFC suggestion');

-- A new key against an already-decided suggestion fails typed.
select throws_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d4', 'pgtap:cat:decide:t2:again', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'suggestion_id', (select id from public.category_suggestions
        where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
      'accept', true))
$$, 'P0009', null, 'a decided suggestion cannot be decided again');
reset role;

select is(
  (select status from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  'dismissed', 'suggestion transitions to dismissed');
select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  '00000000-0000-4000-8000-00000000a311'::uuid,
  'dismiss leaves the overlay exactly as it was');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000002'),
  'plaid_pfc', 'dismiss preserves the overlay provenance too');

-- Dismissed slot is held by the unique key: never re-suggested.
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  0, 'a dismissed suggestion is never re-raised');

-- ---------------------------------------------------------------------------
-- Scope safety: a member of ANOTHER household cannot decide alpha's
-- suggestions (casey is beta's owner; the suggestion is alpha's).
-- ---------------------------------------------------------------------------
-- Re-arm a fresh suggestion to attack (T2's rule-free sibling is decided, so
-- plant a new uncategorized transaction + suggestion for the probe).
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('c5000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'BLUE BOTTLE KIOSK', '2026-07-12', 'pgtap:cat:t3');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c5000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a001',
   'c5000000-0000-4000-8000-000000000003', 'BLUE BOTTLE KIOSK', '2026-07-12',
   'c5000000-0000-4000-8000-0000000000c3');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c5000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -900, 'USD'),
  ('c5000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 900, 'USD');
select is(public.keel_detect_category_suggestions('00000000-0000-4000-8000-00000000a001'),
  1, 'probe transaction gets a fresh suggestion');

-- Capture the probe suggestion id OUTSIDE RLS: casey's member_read policy
-- hides alpha rows, so an in-payload subquery would resolve to NULL and hit
-- the wrong (P0009) gate instead of the scope check under test.
create temporary table _probe on commit drop as
  select id as sid from public.category_suggestions
   where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000003';
grant select on _probe to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
-- Casey targets the alpha suggestion through his OWN household: not found.
select throws_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d5', 'pgtap:cat:decide:xhh:1', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000b001',
    jsonb_build_object('suggestion_id', (select sid from _probe), 'accept', true))
$$, 'P0006', null, 'cross-household suggestion id is a scope violation');
-- Casey targets alpha directly: membership gate fails first.
select throws_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d6', 'pgtap:cat:decide:xhh:2', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('suggestion_id', (select sid from _probe), 'accept', true))
$$, 'P0006', null, 'non-member cannot command against alpha at all');
reset role;

select is(
  (select status from public.category_suggestions
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000003'),
  'suggested', 'attacked suggestion is untouched');

-- Read model: member sees pending rows; non-member is scope-blocked.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  jsonb_array_length(public.keel_list_category_suggestions('00000000-0000-4000-8000-00000000a001')->'rows'),
  1, 'read model lists only PENDING suggestions with display data');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_list_category_suggestions('00000000-0000-4000-8000-00000000a001')
$$, 'P0006', null, 'read model is scope-safe');
reset role;

-- ---------------------------------------------------------------------------
-- Stale-suggestion guard (adversarial review P1-2): the user settles the
-- classification AFTER detection; the pending suggestion must (a) drop off
-- the read model and (b) fail typed on accept — never silently overwrite the
-- user's own decision (Law 9).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
-- Alex recategorizes the probe transaction himself (Groceries, source user).
select lives_ok($$
  select public.keel_categorize_transaction(
    '00000000-0000-4000-8000-00000000a001',
    'c5000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-00000000a311')
$$, 'user recategorizes the probe transaction after detection');
-- (b) The settled row leaves the Review read model.
select is(
  jsonb_array_length(public.keel_list_category_suggestions('00000000-0000-4000-8000-00000000a001')->'rows'),
  0, 'a user-settled classification drops its pending card from the read model');
-- (a) Accepting the stale suggestion fails typed; nothing is overwritten.
select throws_ok($$
  select public.keel_cmd_decide_category_suggestion(
    'c5000000-0000-4000-8000-0000000000d7', 'pgtap:cat:decide:stale', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('suggestion_id', (select sid from _probe), 'accept', true))
$$, 'P0009', null, 'accepting a stale suggestion fails typed instead of clobbering the user');
reset role;

select is(
  (select category_ledger_account_id from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000003'),
  '00000000-0000-4000-8000-00000000a311'::uuid,
  'the user''s own categorization survives the stale accept attempt');
select is(
  (select source from public.transaction_categories
    where canonical_transaction_id = 'c5000000-0000-4000-8000-000000000003'),
  'user', 'overlay provenance stays user after the blocked accept');
select is(
  (select status from public.category_suggestions where id = (select sid from _probe)),
  'suggested', 'the blocked decision leaves the suggestion undecided');

select * from finish();rollback;
