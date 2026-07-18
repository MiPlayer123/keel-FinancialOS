-- FEEDBACK.md F-012 + WS-E review: transfer counterparty flow (book / link+
-- confirm / undo). keel_book_transfer_counterparty posts the balanced opposite
-- cash leg on a chosen MANUAL account (never a connected one — the bank feed
-- delivers that side, WS-E P0-2), creates its canonical transaction, and
-- confirms a transfer_links pairing (booked_txn set) — atomically, idempotent
-- on a per-attempt nonce (WS-E P1-4). keel_link_and_confirm_transfer links two
-- existing opposite transactions and confirms in one call. keel_undo_transfer
-- reverses a booked leg (compensating reversal, never a delete) or plain-
-- unlinks a match pair. Privileged direct inserts here are pgTAP-only
-- scaffolding.
begin;select no_plan();

-- ---------------------------------------------------------------------------
-- Structure + ownership + grants (the keel_api definer ritual). The book proc
-- now takes a 4th arg: the per-attempt idempotency nonce (WS-E P1-4).
-- ---------------------------------------------------------------------------
select has_column('public', 'transfer_links', 'booked_txn',
  'transfer_links has the booked_txn column');
select has_function('public','keel_book_transfer_counterparty', array['uuid','uuid','uuid','text'],
  'book proc exists with the per-attempt nonce arg');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_book_transfer_counterparty(uuid,uuid,uuid,text)'::regprocedure),
  'keel_api', 'book proc owned by keel_api (touches canonical tables)');
select has_function('public','keel_link_and_confirm_transfer', array['uuid','uuid','uuid'],
  'link-and-confirm proc exists');
select has_function('public','keel_undo_transfer', array['uuid','uuid'],
  'undo proc exists');
select ok(not has_function_privilege('anon', 'public.keel_book_transfer_counterparty(uuid,uuid,uuid,text)', 'execute'),
  'anon may NOT book a counterparty leg');
select ok(has_function_privilege('authenticated', 'public.keel_book_transfer_counterparty(uuid,uuid,uuid,text)', 'execute'),
  'authenticated may book a counterparty leg');

-- P0-3: the concurrency-guard partial unique indexes exist.
select ok(
  (select count(*) = 2 from pg_indexes
    where schemaname = 'public'
      and indexname in ('transfer_links_active_out_once', 'transfer_links_active_in_once')),
  'partial unique indexes on active txn_out / txn_in exist (P0-3)');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed (seed.sql): household a001, entity a101, account a401
-- (ledger a301 Simulator Checking, CONNECTED) and a402 (ledger a302 Simulator
-- Card, CONNECTED), a317 Uncategorized Expense (offset fallback).
--
-- BOTH seeded accounts are connected, so we add a MANUAL account (a4f0, ledger
-- a3f0, connection_id NULL) as book-path scaffolding — the book path only ever
-- targets manual accounts now (WS-E P0-2).
--
-- SRC: a $200.00 outflow on checking (a401/a301) the user files as a transfer.
-- MATCH: a matching +$200.00 inflow already on the card (a402/a302) for the
-- link-and-confirm path.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, created_at, archived_at)
values
  ('00000000-0000-4000-8000-0000000003f0', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Cash Jar', 'asset', 'USD', false, now(), null);
insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref, created_at, archived_at)
values
  ('00000000-0000-4000-8000-0000000004f0', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', null, '00000000-0000-4000-8000-0000000003f0',
   'Cash Jar', 'checking', 'USD', 'sim-cash-jar', now(), null);

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('e5000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Sweep to savings', '2026-07-02', 'pgtap:book:src'),
  ('e5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Incoming sweep', '2026-07-03', 'pgtap:book:match'),
  -- An INFLOW source (WS-E P1-7): +$150 on checking the user files as a transfer.
  ('e5000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Inbound from cash jar', '2026-07-04', 'pgtap:book:inflow');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
   'e5000000-0000-4000-8000-000000000001', 'Sweep out', '2026-07-02',
   'e5000000-0000-4000-8000-0000000000e1'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a001',
   'e5000000-0000-4000-8000-000000000002', 'Sweep in', '2026-07-03',
   'e5000000-0000-4000-8000-0000000000e2'),
  ('e5000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a001',
   'e5000000-0000-4000-8000-000000000003', 'Inbound', '2026-07-04',
   'e5000000-0000-4000-8000-0000000000e3');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101',  15000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -15000, 'USD');

-- ---------------------------------------------------------------------------
-- P0-3 (review follow-up a): the partial UNIQUE indexes themselves must reject
-- a SECOND active link on a txn already in one — this is what makes cash-flow
-- exclusion safe under concurrency (a proc's advisory `exists` pre-check can
-- race; the index is the real serialization point). Insert a raw active link,
-- then a conflicting one on the SAME txn_out, and assert unique_violation
-- (23505) fires from the index predicate directly. Wrapped in a savepoint so it
-- does not consume the source txn for the book/match tests below.
-- ---------------------------------------------------------------------------
savepoint before_conflict_probe;
insert into public.transfer_links (id, household_id, txn_out, txn_in, status, created_at)
values ('e5000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000a001',
        'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002',
        'suggested', now());
select throws_ok($$
  insert into public.transfer_links (id, household_id, txn_out, txn_in, status, created_at)
  values ('e5000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-00000000a001',
          'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000003',
          'suggested', now())
$$, '23505', null,
  'a second ACTIVE transfer_link on the same txn_out violates transfer_links_active_out_once (protects the partial-index predicate)');
rollback to savepoint before_conflict_probe;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- P0-2: booking onto a CONNECTED account is refused (the bank feed delivers
-- that side; a synthetic leg would double-post the money).
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-00000000a402', 'pgtap:att:connected')
$$, 'P0009', null, 'booking onto a CONNECTED counterparty is rejected (P0-2)');

-- P1-4: an empty attempt key is rejected (the nonce is required).
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', '')
$$, 'P0009', null, 'an empty attempt key is rejected (P1-4)');

-- ---------------------------------------------------------------------------
-- BOOK path onto the MANUAL Cash Jar (a4f0): synthesize the opposite leg,
-- confirm the booked pairing, Σ postings = 0.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:book1')
$$, 'owner books the opposite leg on a MANUAL account');

select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and status = 'confirmed'
      and booked_txn is not null
      and (txn_out = 'e5000000-0000-4000-8000-000000000001'
           or txn_in = 'e5000000-0000-4000-8000-000000000001')),
  1, 'a confirmed booked transfer_link pairs the source with the synthesized leg');

select is(
  (select p.amount_minor
     from public.transfer_links tl
     join public.canonical_transactions bct on bct.id = tl.booked_txn
     join public.journal_batches jb on jb.canonical_transaction_id = bct.id
      and jb.reverses_batch_id is null
     join public.journal_postings p on p.batch_id = jb.id
     join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
    where tl.booked_txn is not null
      and (tl.txn_out = 'e5000000-0000-4000-8000-000000000001'
           or tl.txn_in = 'e5000000-0000-4000-8000-000000000001')),
  20000::bigint, 'the booked cash leg is +$200.00 (exact negation of the -$200.00 source)');

select is(
  (select sum(p.amount_minor)::bigint
     from public.transfer_links tl
     join public.journal_batches jb on jb.canonical_transaction_id = tl.booked_txn
      and jb.reverses_batch_id is null
     join public.journal_postings p on p.batch_id = jb.id
    where tl.booked_txn is not null
      and (tl.txn_out = 'e5000000-0000-4000-8000-000000000001'
           or tl.txn_in = 'e5000000-0000-4000-8000-000000000001')),
  0::bigint, 'the booked batch balances (Σ postings = 0)');

-- Idempotent economics: replaying the SAME attempt nonce is a no-op replay.
select is(
  (select (public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:book1') ->> 'idempotentReplay')),
  'true', 'replaying the book with the SAME attempt nonce is an idempotent no-op');
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and booked_txn is not null),
  1, 'still exactly ONE booked link after the replay (no duplicate phantom leg)');

-- A source already in an active transfer cannot be booked again — the "already
-- part of a transfer" guard fires regardless of the nonce.
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:book2')
$$, 'P0009', null, 'a source already in an active transfer cannot be re-booked (P0-3-backed check)');

-- ---------------------------------------------------------------------------
-- P1-5: the booked (source='manual') leg is part of an active transfer, so
-- keel_cmd_manual_void must refuse it (undo first).
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.keel_cmd_manual_void(
    gen_random_uuid(), 'pgtap:void:booked', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'transaction_id',
      (select booked_txn::text from public.transfer_links
         where booked_txn is not null
           and household_id = '00000000-0000-4000-8000-00000000a001' limit 1),
      'reason', 'nope'))
$$, 'P0009', null, 'voiding an active booked transfer leg is blocked — undo first (P1-5)');

-- ---------------------------------------------------------------------------
-- UNDO path (booked): reverse the synthesized leg + reject the link.
-- ---------------------------------------------------------------------------
select is(
  (select public.keel_undo_transfer(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.transfer_links
       where booked_txn is not null
         and household_id = '00000000-0000-4000-8000-00000000a001')) ->> 'status'),
  'rejected', 'undo marks the booked link rejected');

select is(
  (select count(*)::int from public.canonical_transactions ct
     where ct.source = 'manual' and ct.voided_at is not null
       and ct.household_id = '00000000-0000-4000-8000-00000000a001'
       and ct.description like 'Transfer:%'),
  1, 'the booked leg is voided (reversed, not deleted) on undo');
select is(
  (select count(*)::int from public.journal_batches jb
     where jb.reverses_batch_id is not null
       and jb.household_id = '00000000-0000-4000-8000-00000000a001'
       and jb.description like 'VOID: transfer undone%'),
  1, 'a compensating reversal batch was posted for the booked leg');

-- Undo is idempotent.
select is(
  (select (public.keel_undo_transfer(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.transfer_links
       where booked_txn is not null
         and household_id = '00000000-0000-4000-8000-00000000a001')) ->> 'idempotentReplay')),
  'true', 'undoing an already-undone transfer is an idempotent no-op');

-- Second undo leaves EXACTLY ONE reversal batch (no double reversal).
select is(
  (select count(*)::int from public.journal_batches jb
     where jb.reverses_batch_id is not null
       and jb.household_id = '00000000-0000-4000-8000-00000000a001'
       and jb.description like 'VOID: transfer undone%'),
  1, 'a second undo leaves exactly one reversal (idempotent, no double-reverse)');

-- ---------------------------------------------------------------------------
-- P1-4: rebook AFTER undo with a FRESH attempt nonce succeeds (the old
-- source-keyed idempotency key would have wedged this).
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:rebook-fresh')
$$, 'rebook after undo with a NEW attempt nonce succeeds (P1-4)');
-- Clean it up so later assertions on the source are unambiguous.
select public.keel_undo_transfer(
  '00000000-0000-4000-8000-00000000a001',
  (select id from public.transfer_links
     where booked_txn is not null and status = 'confirmed'
       and household_id = '00000000-0000-4000-8000-00000000a001'
       and (txn_out = 'e5000000-0000-4000-8000-000000000001'
            or txn_in = 'e5000000-0000-4000-8000-000000000001')));

-- ---------------------------------------------------------------------------
-- P1-7: an INFLOW source books a NEGATIVE leg on the manual counterparty. The
-- +$150 inbound on checking pairs with a synthesized -$150 leg on the Cash Jar.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:inflow')
$$, 'an INFLOW source books its opposite leg (P1-7)');
select is(
  (select p.amount_minor
     from public.transfer_links tl
     join public.canonical_transactions bct on bct.id = tl.booked_txn
     join public.journal_batches jb on jb.canonical_transaction_id = bct.id
      and jb.reverses_batch_id is null
     join public.journal_postings p on p.batch_id = jb.id
     join public.ledger_accounts la on la.id = p.ledger_account_id and la.is_category = false
    where tl.booked_txn is not null
      and (tl.txn_out = 'e5000000-0000-4000-8000-000000000003'
           or tl.txn_in = 'e5000000-0000-4000-8000-000000000003')),
  -15000::bigint, 'the inflow source books a NEGATIVE -$150.00 leg on the counterparty (P1-7)');
-- And the link orients the inflow as txn_in, the booked outflow as txn_out.
select is(
  (select tl.txn_in from public.transfer_links tl
     where tl.booked_txn is not null
       and (tl.txn_out = 'e5000000-0000-4000-8000-000000000003'
            or tl.txn_in = 'e5000000-0000-4000-8000-000000000003')),
  'e5000000-0000-4000-8000-000000000003'::uuid,
  'the inflow source is oriented as txn_in (money arriving)');
-- Undo it to free the source for the match test below is not needed (different txn).

-- ---------------------------------------------------------------------------
-- LINK+CONFIRM path (MATCH): pair SRC with the pre-existing +$200 inflow and
-- confirm in one call. (SRC's booked leg was undone above, freeing it.)
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_link_and_confirm_transfer(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    'e5000000-0000-4000-8000-000000000002')
$$, 'owner links two existing opposite transactions and confirms them');

select is(
  (select tl.status::text from public.transfer_links tl
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and tl.booked_txn is null
      and ((tl.txn_out = 'e5000000-0000-4000-8000-000000000001'
            and tl.txn_in = 'e5000000-0000-4000-8000-000000000002')
           or (tl.txn_out = 'e5000000-0000-4000-8000-000000000002'
               and tl.txn_in = 'e5000000-0000-4000-8000-000000000001'))),
  'confirmed', 'the matched pair is CONFIRMED immediately (no intermediate suggested state)');

-- Byte-identical bank postings after a MATCH undo: undoing a match pair
-- reverses NOTHING (both legs are real bank transactions).
select is(
  (select public.keel_undo_transfer(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.transfer_links
       where booked_txn is null and status = 'confirmed'
         and household_id = '00000000-0000-4000-8000-00000000a001'
         and (txn_out = 'e5000000-0000-4000-8000-000000000001'
              or txn_in = 'e5000000-0000-4000-8000-000000000001'))) ->> 'reversalBatchId'),
  null, 'undoing a MATCH pair reverses nothing (both legs are real bank transactions)');
-- The two bank txns' postings are untouched (no reversal batch for either).
select is(
  (select count(*)::int from public.journal_batches jb
     where jb.reverses_batch_id is not null
       and jb.canonical_transaction_id in
         ('e5000000-0000-4000-8000-000000000001','e5000000-0000-4000-8000-000000000002')),
  0, 'a matched-pair undo leaves both bank txns'' postings byte-identical (no reversal)');

reset role;

-- ---------------------------------------------------------------------------
-- Auth: fail-CLOSED matrix. Non-member, viewer, professional, cross-household,
-- currency mismatch, null-JWT (WS-E P0-1 / P2-9).
-- ---------------------------------------------------------------------------

-- Non-member (user 3 is owner of household b001, not a member of a001).
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:nonmember')
$$, null, null, 'a non-member cannot book a transfer on someone else''s household');
reset role;

-- VIEWER: user 1 is a viewer of household b001 (seed). Read-only must NOT write.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000b001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:viewer')
$$, 'P0005', null, 'a VIEWER may not book a transfer (read-only, P0-1)');
reset role;

-- PROFESSIONAL: user 4 is professional of household a001 (seed). Read-only.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:prof')
$$, 'P0005', null, 'a PROFESSIONAL may not book a transfer (read-only, P0-1)');
-- Same read-only rejection on undo and link-confirm.
select throws_ok($$
  select public.keel_undo_transfer('00000000-0000-4000-8000-00000000a001', gen_random_uuid())
$$, 'P0005', null, 'a PROFESSIONAL may not undo a transfer (read-only, P0-1)');
select throws_ok($$
  select public.keel_link_and_confirm_transfer(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    'e5000000-0000-4000-8000-000000000002')
$$, 'P0005', null, 'a PROFESSIONAL may not link-and-confirm a transfer (read-only, P0-1)');
reset role;

-- NULL JWT: no claims at all → fail closed. keel_assert_member_write reads the
-- caller from request.jwt claims; with none set v_uid is null and it raises
-- KEEL_NOT_AUTHENTICATED (P0004). Pinned to the exact code (review follow-up b)
-- so a future refactor that lets a null caller slip past auth can't pass by
-- raising some other error. Must clear the claim the prior (professional) block
-- set — `set local role` alone does NOT reset request.jwt.claims.
set local role authenticated;
set local request.jwt.claims to '';
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000004f0', 'pgtap:att:nojwt')
$$, 'P0004', null, 'a null JWT fails closed with KEEL_NOT_AUTHENTICATED (P0004)');
reset role;

select * from finish();rollback;
