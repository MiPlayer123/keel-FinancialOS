-- FEEDBACK.md F-012: transfer counterparty flow (book / link+confirm / undo).
-- keel_book_transfer_counterparty posts the balanced opposite cash leg on a
-- chosen account, creates its canonical transaction, and confirms a
-- transfer_links pairing (booked_txn set) — atomically, idempotent on the
-- source transaction id. keel_link_and_confirm_transfer links two existing
-- opposite transactions and confirms in one call. keel_undo_transfer reverses
-- a booked leg (compensating reversal, never a delete) or plain-unlinks a
-- match pair. Privileged direct inserts here are pgTAP-only scaffolding.
begin;select no_plan();

-- ---------------------------------------------------------------------------
-- Structure + ownership + grants (the keel_api definer ritual).
-- ---------------------------------------------------------------------------
select has_column('public', 'transfer_links', 'booked_txn',
  'transfer_links has the booked_txn column');
select has_function('public','keel_book_transfer_counterparty', array['uuid','uuid','uuid'],
  'book proc exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
     where p.oid = 'public.keel_book_transfer_counterparty(uuid,uuid,uuid)'::regprocedure),
  'keel_api', 'book proc owned by keel_api (touches canonical tables)');
select has_function('public','keel_link_and_confirm_transfer', array['uuid','uuid','uuid'],
  'link-and-confirm proc exists');
select has_function('public','keel_undo_transfer', array['uuid','uuid'],
  'undo proc exists');
select ok(not has_function_privilege('anon', 'public.keel_book_transfer_counterparty(uuid,uuid,uuid)', 'execute'),
  'anon may NOT book a counterparty leg');
select ok(has_function_privilege('authenticated', 'public.keel_book_transfer_counterparty(uuid,uuid,uuid)', 'execute'),
  'authenticated may book a counterparty leg');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed (seed.sql): household a001, entity a101, account a401
-- (ledger a301 Simulator Checking) and a402 (ledger a302 Simulator Card),
-- a317 Uncategorized Expense (pfc_key 'uncategorized_expense' via the
-- 20260713090000 backfill — the book proc's offset fallback when no seeded
-- 'Transfers' category exists on the entity, which is the case for the fixture
-- entity a101).
--
-- SRC: a $200.00 outflow on checking (a401/a301) the user files as a transfer.
-- MATCH: a matching +$200.00 inflow already on the card (a402/a302) for the
-- link-and-confirm path.
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('e5000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Sweep to savings', '2026-07-02', 'pgtap:book:src'),
  ('e5000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Incoming sweep', '2026-07-03', 'pgtap:book:match');
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
   'e5000000-0000-4000-8000-000000000001', 'Sweep out', '2026-07-02',
   'e5000000-0000-4000-8000-0000000000e1'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a001',
   'e5000000-0000-4000-8000-000000000002', 'Sweep in', '2026-07-03',
   'e5000000-0000-4000-8000-0000000000e2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('e5000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD');

-- ---------------------------------------------------------------------------
-- BOOK path: no opposite txn on card a402? There IS one (the match), but the
-- book proc doesn't look for matches — it always synthesizes a leg on the
-- given account. Book SRC's opposite onto a fresh manual account is the real
-- use case; here we book onto the CARD to keep fixtures minimal and assert the
-- synthesized leg + confirmed booked link + Σ=0 postings.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-00000000a402')
$$, 'owner books the opposite leg on the card');

-- A confirmed booked link now pairs SRC with a synthesized leg.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and status = 'confirmed'
      and booked_txn is not null
      and (txn_out = 'e5000000-0000-4000-8000-000000000001'
           or txn_in = 'e5000000-0000-4000-8000-000000000001')),
  1, 'a confirmed booked transfer_link pairs the source with the synthesized leg');

-- The synthesized leg is a real canonical transaction on the card, opposite
-- sign, same magnitude.
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

-- Σ per batch = 0 on the booked leg (two postings, opposite signs).
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

-- Idempotent economics: replaying with the SAME source id is a no-op replay,
-- not a second phantom leg.
select is(
  (select (public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-00000000a402') ->> 'idempotentReplay')),
  'true', 'replaying the book with the same source id is an idempotent no-op');
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and booked_txn is not null),
  1, 'still exactly ONE booked link after the replay (no duplicate phantom leg)');

-- A source already in a transfer cannot be booked again with a different
-- counterparty (payload hash differs → typed idempotency conflict).
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-00000000a401')
$$, 'P0007', null, 'rebooking the same source with a different counterparty is a conflict');

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

-- The synthesized leg is voided (compensating reversal exists), not deleted.
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

-- Undo is idempotent (a retry after a timeout is a no-op).
select is(
  (select (public.keel_undo_transfer(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.transfer_links
       where booked_txn is not null
         and household_id = '00000000-0000-4000-8000-00000000a001')) ->> 'idempotentReplay')),
  'true', 'undoing an already-undone transfer is an idempotent no-op');

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

-- A match link has NO booked leg — undo there is a plain unlink (no reversal).
select is(
  (select public.keel_undo_transfer(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.transfer_links
       where booked_txn is null and status = 'confirmed'
         and household_id = '00000000-0000-4000-8000-00000000a001'
         and (txn_out = 'e5000000-0000-4000-8000-000000000001'
              or txn_in = 'e5000000-0000-4000-8000-000000000001'))) ->> 'reversalBatchId'),
  null, 'undoing a MATCH pair reverses nothing (both legs are real bank transactions)');

reset role;

-- ---------------------------------------------------------------------------
-- Auth: a non-member cannot book on this household (fail CLOSED).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_book_transfer_counterparty(
    '00000000-0000-4000-8000-00000000a001',
    'e5000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-00000000a402')
$$, 'P0006', null, 'a non-member cannot book a transfer on someone else''s household');
reset role;

select * from finish();rollback;
