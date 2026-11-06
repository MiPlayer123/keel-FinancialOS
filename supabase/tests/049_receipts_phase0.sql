-- 20261106120000: receipts phase 0. An inbox upload (no target) files the
-- receipt without an attachment; identical bytes are not filed twice; purchase
-- receipts only match money out; direct attachments read as attached.
-- Privileged inserts are pgTAP scaffolding.
begin;select no_plan();

-- Fixtures (alpha seed: household a001, entity a101, member user 0001,
-- checking a401/a301, Groceries a311). One purchase and one refund, same size.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('c9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a401', 'posted', 'sync', 'CORNER HARDWARE', '2026-09-10', 'pgtap:receipts0:1'),
  ('c9000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
   '00000000-0000-4000-8000-00000000a401', 'posted', 'sync', 'CORNER HARDWARE REFUND', '2026-09-10', 'pgtap:receipts0:2');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000001', 'CORNER HARDWARE', '2026-09-10', 'c9000000-0000-4000-8000-0000000000c1'),
  ('c9000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a001',
   'c9000000-0000-4000-8000-000000000002', 'CORNER HARDWARE REFUND', '2026-09-10', 'c9000000-0000-4000-8000-0000000000c2');
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', -4217, 'USD'),
  ('c9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a101', 4217, 'USD'),
  ('c9000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a301', '00000000-0000-4000-8000-00000000a101', 4217, 'USD'),
  ('c9000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a101', -4217, 'USD');

-- 1. Inbox upload: no target, no attachment, no error.
select is(
  (public.keel_documents_confirm_upload(
     '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
     'c9000000-0000-4000-8000-0000000000d1', 'receipt', 'receipts',
     '00000000-0000-4000-8000-00000000a001/c9000000-0000-4000-8000-0000000000d1/x',
     repeat('a', 64), 'image/jpeg', 1000, 'receipt.jpg',
     '00000000-0000-4000-8000-000000000001', null, null) -> 'effects' ->> 'duplicate'),
  'false', 'an inbox upload with no target is filed');
select is(
  (select count(*)::int from public.document_attachments
    where document_id = 'c9000000-0000-4000-8000-0000000000d1'),
  0, 'an inbox upload creates no attachment');
select is(
  (select count(*)::int from public.documents where id = 'c9000000-0000-4000-8000-0000000000d1'),
  1, 'the document row exists');

-- 2. Same bytes again under a new document id: reused, not filed twice.
select is(
  (public.keel_documents_confirm_upload(
     '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
     'c9000000-0000-4000-8000-0000000000d2', 'receipt', 'receipts',
     '00000000-0000-4000-8000-00000000a001/c9000000-0000-4000-8000-0000000000d2/x',
     repeat('a', 64), 'image/jpeg', 1000, 'receipt-again.jpg',
     '00000000-0000-4000-8000-000000000001', null, null) -> 'effects'),
  jsonb_build_object(
    'documentId', 'c9000000-0000-4000-8000-0000000000d1',
    'documentVersionId', (select id from public.document_versions where document_id = 'c9000000-0000-4000-8000-0000000000d1'),
    'attachmentId', null,
    'duplicate', true),
  'identical bytes reuse the existing document');
select is(
  (select count(*)::int from public.documents where id = 'c9000000-0000-4000-8000-0000000000d2'),
  0, 'no second document row for identical bytes');

-- 3. Half a target pair is refused.
select throws_ok($$
  select public.keel_documents_confirm_upload(
     '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
     'c9000000-0000-4000-8000-0000000000d3', 'receipt', 'receipts',
     '00000000-0000-4000-8000-00000000a001/c9000000-0000-4000-8000-0000000000d3/x',
     repeat('b', 64), 'image/jpeg', 1000, 'r.jpg',
     '00000000-0000-4000-8000-000000000001', 'transaction', null)
$$, 'P0009', null, 'targetType without targetId is refused');

-- 4. Candidates: a purchase receipt only sees money out; a refund only money in.
select is(
  (select jsonb_path_query_array(
     public.keel_worker_receipt_candidates('00000000-0000-4000-8000-00000000a001', 'USD', '2026-09-10', 4217),
     '$.rows[*].transactionId')),
  '["c9000000-0000-4000-8000-000000000001"]'::jsonb, 'a purchase receipt matches only money out');
select is(
  (select jsonb_path_query_array(
     public.keel_worker_receipt_candidates('00000000-0000-4000-8000-00000000a001', 'USD', '2026-09-10', -4217),
     '$.rows[*].transactionId')),
  '["c9000000-0000-4000-8000-000000000002"]'::jsonb, 'a refund receipt matches only money in');
select is(
  (select jsonb_path_query_first(
     public.keel_worker_receipt_candidates('00000000-0000-4000-8000-00000000a001', 'USD', '2026-09-10', 4217),
     '$.rows[0].hasAttachment')),
  'false'::jsonb, 'no receipt attached yet');

-- 5. Upload with a target attaches; the purchase now has a receipt.
select isnt(
  (public.keel_documents_confirm_upload(
     '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
     'c9000000-0000-4000-8000-0000000000d4', 'receipt', 'receipts',
     '00000000-0000-4000-8000-00000000a001/c9000000-0000-4000-8000-0000000000d4/x',
     repeat('c', 64), 'image/jpeg', 1000, 'hardware.jpg',
     '00000000-0000-4000-8000-000000000001', 'transaction', 'c9000000-0000-4000-8000-000000000001')
   -> 'effects' ->> 'attachmentId'),
  null, 'an upload with a target attaches');
select is(
  (select jsonb_path_query_first(
     public.keel_worker_receipt_candidates('00000000-0000-4000-8000-00000000a001', 'USD', '2026-09-10', 4217),
     '$.rows[0].hasAttachment')),
  'true'::jsonb, 'the purchase now reads as having a receipt');

-- 6. Inbox (as the member): the attached receipt carries its transaction,
--    the inbox upload has none.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select jsonb_path_query_first(public.keel_receipts_inbox('00000000-0000-4000-8000-00000000a001'),
     '$.rows[*] ? (@.documentId == "c9000000-0000-4000-8000-0000000000d4").attached.transactionId') #>> '{}'),
  'c9000000-0000-4000-8000-000000000001', 'a directly attached receipt reads as attached');
select is(
  (select jsonb_path_query_first(public.keel_receipts_inbox('00000000-0000-4000-8000-00000000a001'),
     '$.rows[*] ? (@.documentId == "c9000000-0000-4000-8000-0000000000d1").attached')),
  'null'::jsonb, 'an inbox upload is not attached');
select is(
  (public.keel_receipts_inbox('00000000-0000-4000-8000-00000000a001') ->> 'formulaVersion'),
  'receipts-inbox-v2', 'inbox formula version');

select * from finish();
rollback;
