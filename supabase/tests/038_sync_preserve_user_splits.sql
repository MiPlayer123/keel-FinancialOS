-- Sync must not clobber user-authored splits (migration 20260803120000).
-- keel_worker_apply_action's 'revise' path used to reverse the live batch and
-- re-book a flat cash + Uncategorized pair, destroying a user's split when a
-- PENDING transaction they had already split settled (pending -> posted is a
-- money-unchanged 'revise'). The guard preserves a user-authored batch across a
-- same-amount revise; a plain 2-leg sync batch still re-books; a void still
-- reverses. Fictional deterministic UUIDs in the 'e9' band on the shared alpha
-- household (00000000-...-a001 / entity a101). Plain INSERT/SELECT fixtures, no
-- DO blocks -- house style (pgTAP is not run locally here).
begin;select no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures: an active connection + account on a001/a101, and the alpha seed
-- categories a311 Groceries / a314 Coffee Shops / a317 Uncategorized Expense.
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status, institution_id) values
  ('e9000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:preserve:item', 'active', null);
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category) values
  ('e9000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Preserve Cash Ledger', 'asset', 'USD', false);
insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref)
values
  ('e9000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e9000000-0000-4000-8000-000000000001',
   'e9000000-0000-4000-8000-000000000011', 'Preserve Checking', 'checking', 'USD',
   'pgtap:preserve:acct');

-- ===========================================================================
-- CASE 1 — a user-authored 3-leg split on a PENDING transaction. A same-amount
-- settle (revise, pending -> posted) must PRESERVE it.
-- ===========================================================================
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000001', 'plaid',
   'split1:raw', 'pgtap:preserve:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e9000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e9000000-0000-4000-8000-000000000021',
   'pending', 'sync', 'COSTCO WHOLESALE (pending)', '2026-07-10',
   'txn:plaid:pgtap:preserve:item:split1');

insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('e9000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
   'e9000000-0000-4000-8000-0000000000a1', 'COSTCO WHOLESALE (pending)', '2026-07-10', gen_random_uuid());
-- cash −4300 + Groceries +3000 + Coffee +1300 = 0  (3 postings → user-authored)
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('e9000000-0000-4000-8000-0000000000b1', 'e9000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a101', -4300, 'USD'),
  ('e9000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 3000, 'USD'),
  ('e9000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a314',
   '00000000-0000-4000-8000-00000000a101', 1300, 'USD');

-- The settle: SAME amount (−4300), now posted, description drifted.
insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, kind)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000021',
       'split1', -4300, 'USD', '2026-07-10', 'COSTCO WHOLESALE #482', false, 'modified'
  from public.raw_provider_events r where r.provider_event_id = 'split1:raw';

-- Apply the revise (the call also performs the mutation). Reports preservation.
select is(
  (public.keel_worker_apply_action(
     (select id from public.normalized_source_records where provider_transaction_id = 'split1'),
     'revise', 'txn:plaid:pgtap:preserve:item:split1', 'pgtap:apply:split1'
   )->'effects'->>'postingsPreserved'),
  'true',
  'a same-amount revise of a user-authored split reports postingsPreserved');

select is(
  (select count(*)::int from public.journal_postings jp
     join public.journal_batches jb on jb.id = jp.batch_id
    where jb.canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a1'
      and jb.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)),
  3, 'the user split (3 legs) is preserved intact — not re-booked to Uncategorized');
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a1'
      and description like 'REVERSAL: sync%'),
  0, 'no sync reversal batch was created for the preserved split');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e9000000-0000-4000-8000-0000000000a1'),
  'posted', 'the settle still advances status pending -> posted');
select is(
  (select sum(jp.amount_minor)::bigint from public.journal_postings jp
     join public.journal_batches jb on jb.id = jp.batch_id
    where jb.canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a1'),
  0::bigint, 'the transaction still nets to zero (Law 3)');

-- ===========================================================================
-- CASE 2 (control) — a PLAIN 2-leg sync batch (cash + Uncategorized) is NOT
-- user-authored, so a revise still reverses + re-books, exactly as before.
-- ===========================================================================
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000001', 'plaid',
   'plain1:raw', 'pgtap:preserve:acct', '{}'::jsonb, now());
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e9000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e9000000-0000-4000-8000-000000000021',
   'pending', 'sync', 'SOME SHOP (pending)', '2026-07-11',
   'txn:plaid:pgtap:preserve:item:plain1');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('e9000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a001',
   'e9000000-0000-4000-8000-0000000000a2', 'SOME SHOP (pending)', '2026-07-11', gen_random_uuid());
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('e9000000-0000-4000-8000-0000000000b2', 'e9000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a101', -1500, 'USD'),
  ('e9000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101', 1500, 'USD');
insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, kind)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000021',
       'plain1', -1500, 'USD', '2026-07-11', 'SOME SHOP #9', false, 'modified'
  from public.raw_provider_events r where r.provider_event_id = 'plain1:raw';

select is(
  (public.keel_worker_apply_action(
     (select id from public.normalized_source_records where provider_transaction_id = 'plain1'),
     'revise', 'txn:plaid:pgtap:preserve:item:plain1', 'pgtap:apply:plain1'
   )->'effects'->>'postingsPreserved'),
  null,
  'a plain 2-leg sync batch is NOT preserved (no postingsPreserved flag)');
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a2'
      and description like 'REVERSAL: sync%'),
  1, 'a plain sync batch is reversed + re-booked exactly as before');

-- ===========================================================================
-- CASE 3 — a user split whose settle also MOVES THE DATE (Jul-12 pending ->
-- Jul-13 posted, same amount). The split must be preserved AND re-dated: a
-- metadata-only date bump would strand the batch (and thus every ledger read
-- model) in the old period. Verbatim copy onto a new-dated replacement.
-- ===========================================================================
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000001', 'plaid',
   'redate1:raw', 'pgtap:preserve:acct', '{}'::jsonb, now());
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e9000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e9000000-0000-4000-8000-000000000021',
   'pending', 'sync', 'MARKET (pending)', '2026-07-12',
   'txn:plaid:pgtap:preserve:item:redate1');
insert into public.journal_batches (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('e9000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a001',
   'e9000000-0000-4000-8000-0000000000a3', 'MARKET (pending)', '2026-07-12', gen_random_uuid());
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  ('e9000000-0000-4000-8000-0000000000b3', 'e9000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a101', -6000, 'USD'),
  ('e9000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a311',
   '00000000-0000-4000-8000-00000000a101', 4000, 'USD'),
  ('e9000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a314',
   '00000000-0000-4000-8000-00000000a101', 2000, 'USD');
insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, kind)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e9000000-0000-4000-8000-000000000021',
       'redate1', -6000, 'USD', '2026-07-13', 'MARKET #7', false, 'modified'
  from public.raw_provider_events r where r.provider_event_id = 'redate1:raw';

select is(
  (public.keel_worker_apply_action(
     (select id from public.normalized_source_records where provider_transaction_id = 'redate1'),
     'revise', 'txn:plaid:pgtap:preserve:item:redate1', 'pgtap:apply:redate1'
   )->'effects'->>'reDated'),
  'true',
  'a same-amount revise that MOVES the date reports reDated=true');
select is(
  (select count(*)::int from public.journal_postings jp
     join public.journal_batches jb on jb.id = jp.batch_id
    where jb.canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a3'
      and jb.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)),
  3, 're-dated split keeps all 3 legs (verbatim copy)');
select is(
  (select jb.effective_date from public.journal_batches jb
    where jb.canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a3'
      and jb.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = jb.id)),
  date '2026-07-13', 'the live split batch is moved to the settled date');
select is(
  (select sum(jp.amount_minor)::bigint from public.journal_postings jp
     join public.journal_batches jb on jb.id = jp.batch_id
    where jb.canonical_transaction_id = 'e9000000-0000-4000-8000-0000000000a3'),
  0::bigint, 're-dated transaction still nets to zero (Law 3)');

select * from finish();rollback;
