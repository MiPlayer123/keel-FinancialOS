-- WS-H / FEEDBACK.md F-005 + F-021: the bounded, keyset-paginated + searchable
-- rich read (keel_list_transactions_rich_page, keel_search_transactions,
-- 20260718150000). Proves: keyset pagination is complete + gapless + ordered,
-- the server account/category/search filters are correct, the read fails CLOSED
-- on a null JWT sub and rejects a non-member (mirrors the unbounded read's
-- auth), and the per-row DTO is byte-identical to the unbounded
-- keel_list_transactions_rich (the compatibility contract 7 pages + WS-I/WS-J
-- depend on). Privileged direct inserts here are pgTAP-only scaffolding
-- (established ritual) representing states real audited surfaces already
-- produce elsewhere.
begin;select no_plan();

-- ---------------------------------------------------------------------------
-- Structure + grants (the read-definer ritual: fail-closed, member-only,
-- authenticated + service_role may execute, anon may not).
-- ---------------------------------------------------------------------------
select has_function('public','keel_list_transactions_rich_page',
  array['uuid','integer','date','uuid','uuid','text'],
  'paginated rich read exists with the page/cursor/filter signature');
select has_function('public','keel_search_transactions', array['uuid','text','integer'],
  'command-palette search read exists');
select ok(not has_function_privilege('anon',
  'public.keel_list_transactions_rich_page(uuid,integer,date,uuid,uuid,text)', 'execute'),
  'anon may NOT read the paginated rich list');
select ok(has_function_privilege('authenticated',
  'public.keel_list_transactions_rich_page(uuid,integer,date,uuid,uuid,text)', 'execute'),
  'authenticated may read the paginated rich list');
select ok(not has_function_privilege('anon',
  'public.keel_search_transactions(uuid,text,integer)', 'execute'),
  'anon may NOT search transactions');
-- Hot-path indexes for the page order + account filter.
select ok(
  (select count(*) = 2 from pg_indexes where schemaname = 'public'
    and indexname in ('canonical_transactions_household_effdate_id',
                      'canonical_transactions_household_account_effdate')),
  'keyset + account-filter hot-path indexes exist');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: household a001, member owner user ...0001, entity a101,
-- checking a401/ledger a301, card a402/ledger a302, categories a311 Groceries /
-- a314 Coffee Shops / a317 Uncategorized Expense.
--
-- Five live transactions across THREE dates and TWO accounts, one carrying a
-- distinctive search token ("ZORPCORP"), one a two-way split, so a single page
-- exercises ordering, the account/category/search filters and DTO parity at
-- once:
--   P1 2026-07-15 checking  -1000  Uncategorized      "GROCERY RUN"
--   P2 2026-07-15 checking  -2000  Groceries (a311)   "ZORPCORP MARKET"   <- search + category
--   P3 2026-07-14 card      -3000  Uncategorized      "CARD SWIPE"        <- other account
--   P4 2026-07-13 checking  -4000  split a311/a314    "SPLIT DINER"
--   P5 2026-07-13 checking  -5000  Uncategorized      "OLDEST ROW"        <- same date as P4 (tie-break)
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('d8000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','GROCERY RUN','2026-07-15','pgtap:page:t1'),
  ('d8000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','ZORPCORP MARKET','2026-07-15','pgtap:page:t2'),
  ('d8000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a402','posted','sync','CARD SWIPE','2026-07-14','pgtap:page:t3'),
  ('d8000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','SPLIT DINER','2026-07-13','pgtap:page:t4'),
  ('d8000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401','posted','sync','OLDEST ROW','2026-07-13','pgtap:page:t5');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d8000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a001','d8000000-0000-4000-8000-000000000001','GROCERY RUN','2026-07-15','d8000000-0000-4000-8000-0000000000c1'),
  ('d8000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a001','d8000000-0000-4000-8000-000000000002','ZORPCORP MARKET','2026-07-15','d8000000-0000-4000-8000-0000000000c2'),
  ('d8000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a001','d8000000-0000-4000-8000-000000000003','CARD SWIPE','2026-07-14','d8000000-0000-4000-8000-0000000000c3'),
  ('d8000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a001','d8000000-0000-4000-8000-000000000004','SPLIT DINER','2026-07-13','d8000000-0000-4000-8000-0000000000c4'),
  ('d8000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a001','d8000000-0000-4000-8000-000000000005','OLDEST ROW','2026-07-13','d8000000-0000-4000-8000-0000000000c5');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('d8000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-1000,'USD'),
  ('d8000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-00000000a317','00000000-0000-4000-8000-00000000a101',1000,'USD'),
  ('d8000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-2000,'USD'),
  ('d8000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',2000,'USD'),
  ('d8000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a302','00000000-0000-4000-8000-00000000a101',-3000,'USD'),
  ('d8000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-00000000a317','00000000-0000-4000-8000-00000000a101',3000,'USD'),
  ('d8000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-4000,'USD'),
  ('d8000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',2500,'USD'),
  ('d8000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-00000000a314','00000000-0000-4000-8000-00000000a101',1500,'USD'),
  ('d8000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-5000,'USD'),
  ('d8000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-00000000a317','00000000-0000-4000-8000-00000000a101',5000,'USD');
-- P2's single-offset category overlay (Groceries a311) — the category filter target.
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('d8000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a311','user');

-- ===========================================================================
-- As the member owner (JWT sub = ...0001).
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The full unbounded read (parity reference) and a 2-page keyset walk over
-- ONLY the fixture rows. We constrain to the five d8… ids so the assertions are
-- deterministic regardless of whatever else the seed leaves in a001.
create temporary table _unbounded on commit drop as
  select elem from jsonb_array_elements(
    public.keel_list_transactions_rich('00000000-0000-4000-8000-00000000a001')->'rows') as t(elem)
  where elem->>'transactionId' like 'd8000000-%';

-- Page 1: limit 2, no cursor.
create temporary table _p1 on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 2) as r;
-- Page 2: seeded by page 1's nextCursor.
create temporary table _p2 on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 2,
    ((select r from _p1)->'nextCursor'->>'effectiveDate')::date,
    ((select r from _p1)->'nextCursor'->>'transactionId')::uuid) as r;

-- Ordering: first row is the newest, id-desc within a tie. P1/P2 share
-- 2026-07-15; P2's id (…002) > P1's (…001), so P2 comes first.
select is(
  (select (r->'rows'->0->>'transactionId') from _p1),
  'd8000000-0000-4000-8000-000000000002',
  'page 1 first row is the newest (date desc, id desc tie-break)');
select is(
  (select (r->'rows'->1->>'transactionId') from _p1),
  'd8000000-0000-4000-8000-000000000001',
  'page 1 second row is the id-desc tie-break of the same date');
select is((select jsonb_array_length(r->'rows') from _p1), 2, 'page 1 honours the limit');
select isnt((select r->'nextCursor' from _p1), 'null'::jsonb, 'page 1 carries a nextCursor');

-- Page 2 continues strictly after page 1 with no overlap.
select is(
  (select count(*) from jsonb_array_elements((select r from _p1)->'rows') a
     join jsonb_array_elements((select r from _p2)->'rows') b
       on a->>'transactionId' = b->>'transactionId'),
  0::bigint, 'pages do not overlap (keyset, not offset)');

-- A big page returns every fixture row exactly once, in order, then terminates.
create temporary table _all on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 200) as r;
select is(
  (select count(*) from jsonb_array_elements((select r from _all)->'rows') e
     where e->>'transactionId' like 'd8000000-%'),
  5::bigint, 'a full page contains all five fixture rows');
select is((select r->'nextCursor' from _all), null::jsonb,
  'nextCursor is null on the last page (no more rows)');

-- Account filter: only the card account (a402) → just P3.
create temporary table _byacct on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 200, null, null,
    '00000000-0000-4000-8000-00000000a402') as r;
select is(
  (select count(*) from jsonb_array_elements((select r from _byacct)->'rows') e),
  1::bigint, 'account filter returns exactly the one row on that account');
select is(
  (select (r->'rows'->0->>'transactionId') from _byacct),
  'd8000000-0000-4000-8000-000000000003',
  'account filter returns the RIGHT row (the card transaction)');
select is(
  (select count(*) from jsonb_array_elements((select r from _byacct)->'rows') e
     where e->>'accountId' <> '00000000-0000-4000-8000-00000000a402'),
  0::bigint, 'account filter never leaks a row from another account');

-- Category filter: Groceries (a311) single-offset → P2 only (the split P4 also
-- touches a311 but is multi-offset, so it must NOT match a single-category filter).
create temporary table _bycat on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 200, null, null, null,
    '00000000-0000-4000-8000-00000000a311') as r;
select is(
  (select count(*) from jsonb_array_elements((select r from _bycat)->'rows') e
     where e->>'transactionId' like 'd8000000-%'),
  1::bigint, 'category filter matches only the single-offset Groceries row');
select is(
  (select (r->'rows'->0->>'transactionId') from _bycat),
  'd8000000-0000-4000-8000-000000000002',
  'category filter returns P2 (not the a311-touching SPLIT)');

-- Search filter (page read): "zorp" → P2 only, case-insensitive.
create temporary table _bysearch on commit drop as
  select public.keel_list_transactions_rich_page(
    '00000000-0000-4000-8000-00000000a001', 200, null, null, null, null, 'zorp') as r;
select is(
  (select count(*) from jsonb_array_elements((select r from _bysearch)->'rows') e),
  1::bigint, 'search "zorp" matches exactly one row (case-insensitive)');
select is(
  (select (r->'rows'->0->>'transactionId') from _bysearch),
  'd8000000-0000-4000-8000-000000000002', 'search returns the ZORPCORP row');

-- keel_search_transactions (command palette): same token, slim DTO.
create temporary table _search on commit drop as
  select public.keel_search_transactions('00000000-0000-4000-8000-00000000a001','zorp',8) as r;
select is(
  (select jsonb_array_length((select r from _search)->'rows')), 1,
  'command-palette search returns the one ZORPCORP hit');
select is(
  (select (r->'rows'->0->>'description') from _search), 'ZORPCORP MARKET',
  'command-palette hit carries the display description');
select is(
  (select (r->'rows'->0->>'amountMinor') from _search), '-2000',
  'command-palette hit carries the signed minor amount (BIGINT text, no float)');
-- An empty term returns an empty page, never the whole history.
select is(
  (select jsonb_array_length(public.keel_search_transactions('00000000-0000-4000-8000-00000000a001','',8)->'rows')),
  0, 'blank search term returns no hits (never a full dump)');

-- ---------------------------------------------------------------------------
-- DTO PARITY: every field the paginated read emits for a fixture row is
-- byte-identical to the unbounded keel_list_transactions_rich for the same row.
-- This is the compatibility contract the consuming pages + WS-I/WS-J rely on.
-- ---------------------------------------------------------------------------
select is(
  (select e from jsonb_array_elements((select r from _all)->'rows') t(e)
     where e->>'transactionId' = 'd8000000-0000-4000-8000-000000000002'),
  (select elem from _unbounded where elem->>'transactionId' = 'd8000000-0000-4000-8000-000000000002'),
  'paginated DTO for the categorized row is byte-identical to the unbounded read');
select is(
  (select e from jsonb_array_elements((select r from _all)->'rows') t(e)
     where e->>'transactionId' = 'd8000000-0000-4000-8000-000000000004'),
  (select elem from _unbounded where elem->>'transactionId' = 'd8000000-0000-4000-8000-000000000004'),
  'paginated DTO for the SPLIT row (splits array, categorySource=user) is byte-identical');
select is(
  (select count(*) from jsonb_array_elements((select r from _all)->'rows') p(e)
     join _unbounded u on u.elem->>'transactionId' = p.e->>'transactionId'
     where p.e is distinct from u.elem
       and p.e->>'transactionId' like 'd8000000-%'),
  0::bigint, 'ALL fixture rows are byte-identical between the paginated and unbounded reads');

reset role;

-- ===========================================================================
-- Auth: fail CLOSED with no JWT sub; scope violation for a non-member.
-- ===========================================================================
-- No request.jwt.claims set at all → v_uid is null → KEEL_NOT_AUTHENTICATED.
set local role authenticated;
set local request.jwt.claims to '{"role":"authenticated"}';
select throws_ok(
  $$ select public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 10) $$,
  'P0004', 'KEEL_NOT_AUTHENTICATED',
  'paginated read fails CLOSED when the JWT carries no sub');
select throws_ok(
  $$ select public.keel_search_transactions('00000000-0000-4000-8000-00000000a001', 'zorp', 8) $$,
  'P0004', 'KEEL_NOT_AUTHENTICATED',
  'search read fails CLOSED when the JWT carries no sub');

-- A real user who is NOT a member of a001 (…0009) → KEEL_SCOPE_VIOLATION.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000009","role":"authenticated"}';
select throws_ok(
  $$ select public.keel_list_transactions_rich_page('00000000-0000-4000-8000-00000000a001', 10) $$,
  'P0006', 'KEEL_SCOPE_VIOLATION',
  'paginated read rejects a non-member of the household');
select throws_ok(
  $$ select public.keel_search_transactions('00000000-0000-4000-8000-00000000a001', 'zorp', 8) $$,
  'P0006', 'KEEL_SCOPE_VIOLATION',
  'search read rejects a non-member of the household');
reset role;

select * from finish();rollback;
