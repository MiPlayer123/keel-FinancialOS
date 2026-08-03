-- Pair-gated suppression of regular-sync core-account (SPAXX) sweeps.
-- Spec: the Fidelity cash-management double-booking fix (20260725000000).
-- Fictional, deterministic UUIDs in the 'e7'/'e8' bands on the shared alpha
-- household (00000000-...-a001 / entity a101) and beta household
-- (00000000-...-b001 / entity b101) -- both established fixture households
-- per house style (see 036_investment_flow_classifier.sql). Plain INSERT/
-- SELECT fixture setup throughout (no helper functions/DO blocks -- matches
-- every other file in this suite; pgTAP cannot be run locally here, so this
-- avoids any unproven procedural pattern).
begin;
select no_plan();

-- ---------------------------------------------------------------------------
-- Function existence / grants.
-- ---------------------------------------------------------------------------
select has_function('public', 'keel_reconcile_regular_core_sweeps', array['uuid', 'uuid'],
  'reconcile RPC exists with the (household_id, connection_id) signature');
select has_function('public', 'keel_cmd_restore_regular_core_sweep',
  array['uuid', 'text', 'jsonb', 'uuid', 'jsonb'],
  'restore command exists with the standard KEEL command-proc signature');
select ok(
  has_function_privilege('service_role',
    'public.keel_reconcile_regular_core_sweeps(uuid,uuid)', 'EXECUTE'),
  'service_role can execute the reconcile RPC');
select ok(
  has_function_privilege('authenticated',
    'public.keel_cmd_restore_regular_core_sweep(uuid,text,jsonb,uuid,jsonb)', 'EXECUTE'),
  'authenticated can execute the restore command');

-- ---------------------------------------------------------------------------
-- Fixtures: a Fidelity-like cash-management connection/account on household
-- a001/entity a101. institution_id is deliberately NULL (mirrors the live
-- connection this fix targets) to prove the allowlist is connection_id-keyed,
-- not institution_id-keyed.
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status, institution_id) values
  ('e7000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   'plaid', 'pgtap:coresweep:item', 'active', null);

insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category) values
  ('e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Coresweep Cash Ledger', 'asset', 'USD', false);

insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref)
values
  ('e7000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000001',
   'e7000000-0000-4000-8000-000000000011', 'Coresweep Cash Mgmt', 'cash management', 'USD',
   'pgtap:coresweep:acct');

-- NOT allowlisted yet: prove the gate actually blocks before we allowlist it.
select is(
  (public.keel_reconcile_regular_core_sweeps(
    '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001'
  )->>'allowlisted')::boolean,
  false,
  'a connection not yet on the allowlist is a cheap no-op (allowlisted=false)');

insert into public.regular_core_sweep_allowlist (household_id, connection_id, note) values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'pgtap fixture');

-- ===========================================================================
-- Fixture transactions. Each is: raw_provider_events row, canonical_
-- transactions row, a 2-posting journal_batches/journal_postings pair (the
-- account's own cash leg + an uncategorized offset), a normalized_source_
-- records row carrying the PFC primary, and its transaction_source_links
-- row. Postings/links are inserted via INSERT...SELECT keyed off the
-- transaction ids already inserted, so no PL/pgSQL/variables are needed.
-- ===========================================================================

-- ---- (a) candidate + counterpart: the unambiguous pair. --------------------
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-a:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'transfer-a:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-01',
   'txn:plaid:pgtap:coresweep:item:sweep-a'),
  ('e7000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-01',
   'txn:plaid:pgtap:coresweep:item:transfer-a');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000a1',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-01', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000a2',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-01', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-00000000a101'::uuid, 50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', -50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
union all
select b.id, '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a2'
union all
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a2';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-a', 50000, 'USD', '2026-06-01', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-a:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'transfer-a', -50000, 'USD', '2026-06-01', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'transfer-a:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000a1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-a'
union all
select 'e7000000-0000-4000-8000-0000000000a2', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'transfer-a';

-- ---- (b) unmatched sweep-pattern row: no counterpart at all. ---------------
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-b:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'PURCHASE INTO CORE ACCOUNT (SPAXX)', '2026-06-02',
   'txn:plaid:pgtap:coresweep:item:sweep-b');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000b1',
   'PURCHASE INTO CORE ACCOUNT (SPAXX)', '2026-06-02', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -77700, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000b1'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', 77700, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000b1';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-b', -77700, 'USD', '2026-06-02', 'PURCHASE INTO CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-b:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000b1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-b';

-- ---- (c) ambiguous: two candidates chasing one counterpart. ----------------
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-c1:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-c2:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'transfer-c:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-03',
   'txn:plaid:pgtap:coresweep:item:sweep-c1'),
  ('e7000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-03',
   'txn:plaid:pgtap:coresweep:item:sweep-c2'),
  ('e7000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-03',
   'txn:plaid:pgtap:coresweep:item:transfer-c');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000c1',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-03', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000c2',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-03', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000c3',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-03', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', 30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c1'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', -30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c1'
union all
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', 30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c2'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', -30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c2'
union all
select b.id, '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c3'
union all
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -30000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000c3';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-c1', 30000, 'USD', '2026-06-03', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-c1:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-c2', 30000, 'USD', '2026-06-03', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-c2:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'transfer-c', -30000, 'USD', '2026-06-03', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'transfer-c:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000c1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-c1'
union all
select 'e7000000-0000-4000-8000-0000000000c2', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-c2'
union all
select 'e7000000-0000-4000-8000-0000000000c3', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'transfer-c';

-- ---- (d) confirmed transfer_links exclusion. -------------------------------
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-d:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'transfer-d:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-04',
   'txn:plaid:pgtap:coresweep:item:sweep-d'),
  ('e7000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-04',
   'txn:plaid:pgtap:coresweep:item:transfer-d');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000d1',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-04', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000d2',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-04', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', 40000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000d1'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', -40000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000d1'
union all
select b.id, '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 40000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000d2'
union all
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -40000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000d2';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-d', 40000, 'USD', '2026-06-04', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-d:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'transfer-d', -40000, 'USD', '2026-06-04', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'transfer-d:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000d1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-d'
union all
select 'e7000000-0000-4000-8000-0000000000d2', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'transfer-d';

-- The candidate already participates in a CONFIRMED link. Its OTHER leg is a
-- dedicated decoy transaction (NOT b1/any other scenario's fixture) --
-- reusing b1 here would ALSO mark b1 excluded (the exclusion check keys on
-- EITHER side of a transfer_links row), corrupting the candidatesConsidered/
-- excludedByPolicy counts asserted below.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000d9', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'manual', 'Unrelated decoy transaction (transfer_links partner only)', '2026-06-04',
   'txn:pgtap:coresweep:decoy:d9');

insert into public.transfer_links (household_id, txn_out, txn_in, status, decided_by, decided_at)
values (
  '00000000-0000-4000-8000-00000000a001',
  'e7000000-0000-4000-8000-0000000000d1', 'e7000000-0000-4000-8000-0000000000d9',
  'confirmed', '00000000-0000-4000-8000-000000000001', now()
);

-- ---- (e) locked period exclusion. ------------------------------------------
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'sweep-e:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'transfer-e:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-05',
   'txn:plaid:pgtap:coresweep:item:sweep-e'),
  ('e7000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-05',
   'txn:plaid:pgtap:coresweep:item:transfer-e');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000e1',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-05', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000e2',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-05', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', 60000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000e1'
union all
select b.id, '00000000-0000-4000-8000-00000000a318', '00000000-0000-4000-8000-00000000a101', -60000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000e1'
union all
select b.id, '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 60000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000e2'
union all
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -60000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000e2';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'sweep-e', 60000, 'USD', '2026-06-05', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'sweep-e:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'transfer-e', -60000, 'USD', '2026-06-05', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'transfer-e:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000e1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'sweep-e'
union all
select 'e7000000-0000-4000-8000-0000000000e2', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'transfer-e';

-- Lock AFTER posting (the period-lock trigger fires on new postings, not
-- retroactively on the ones already inserted above).
insert into public.period_locks (household_id, entity_id, start_date, end_date, locked_by)
values (
  '00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a101',
  '2026-06-05', '2026-06-05', '00000000-0000-4000-8000-000000000001'
);

-- ===========================================================================
-- Run the reconcile RPC once over all of (a)-(e). Captured into a temp table
-- so every field of THIS SAME call's jsonb result can be asserted (a bare
-- `select is((...)->>'x', ...)` would re-invoke the function -- idempotent,
-- but not side-effect-free on this first call -- once per assertion).
-- ===========================================================================
create temp table reconcile_result_1 as
select public.keel_reconcile_regular_core_sweeps(
  '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001'
) as result;

-- Base-pattern candidates regardless of policy exclusion: a1, b1, c1, c2, d1,
-- e1 = 6. Of those, d1/e1 are policy-excluded (confirmed link / locked
-- period) = 2. Of the remaining 4, c1/c2 are an ambiguous many-to-one match
-- (skipped, suppress neither) = 2 ambiguous; a1 pairs uniquely and IS
-- suppressed = 1; b1 has no counterpart at all (never enters the pairing
-- loop, so it is neither ambiguous nor excluded -- just "considered").
select is(
  (select (result->>'candidatesConsidered')::int from reconcile_result_1),
  6, 'candidatesConsidered counts every base-pattern match regardless of pairing/exclusion');
select is(
  (select (result->>'excludedByPolicy')::int from reconcile_result_1),
  2, 'excludedByPolicy counts exactly the confirmed-link (d) and locked-period (e) candidates');
select is(
  (select (result->>'ambiguousSkipped')::int from reconcile_result_1),
  2, 'ambiguousSkipped counts both ambiguous candidates (c1, c2), suppressing neither');
select is(
  (select (result->>'suppressed')::int from reconcile_result_1),
  1, 'exactly one unambiguous pair (a) is suppressed');

select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
      and released_at is null),
  1, '(a) unambiguous pair recorded exactly one active suppression');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  'voided', '(a) candidate is voided');
select is(
  (select voided_at is not null from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  true, '(a) candidate has voided_at stamped');
select is(
  (select coalesce(sum(p.amount_minor), 0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
    where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
      and p.ledger_account_id = 'e7000000-0000-4000-8000-000000000011'),
  0::bigint, '(a) candidate nets to zero on the cash ledger (reversal balances it)');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a2'),
  'posted', '(a) counterpart is UNTOUCHED (still posted, never voided)');
select is(
  (select voided_at from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a2'),
  null, '(a) counterpart voided_at stays null');

select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000b1'),
  'posted', '(b) an unmatched core-sweep-pattern row (no counterpart) is NEVER suppressed');

select is(
  (select count(*)::int from public.canonical_transactions
    where id in ('e7000000-0000-4000-8000-0000000000c1', 'e7000000-0000-4000-8000-0000000000c2')
      and status = 'voided'),
  0, '(c) an ambiguous many-to-one match suppresses NEITHER candidate');
select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where candidate_transaction_id in
      ('e7000000-0000-4000-8000-0000000000c1', 'e7000000-0000-4000-8000-0000000000c2')),
  0, '(c) no suppression row was written for the ambiguous pair');

select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000d1'),
  'posted', '(d) a candidate with a CONFIRMED transfer_links row is excluded, never voided');

select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000e1'),
  'posted', '(e) a candidate in a locked period is excluded, never voided');

-- ===========================================================================
-- (f) Idempotency: re-running reconcile never double-voids / double-inserts.
-- ===========================================================================
select is(
  (public.keel_reconcile_regular_core_sweeps(
     '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001'
   )->>'suppressed')::int,
  0, '(f) idempotent re-run: zero NEW suppressions on the second call');
select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'),
  1, '(f) still exactly ONE suppression row after two reconcile calls (no duplicate)');
select is(
  (select count(*)::int from public.journal_batches
    where canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
      and reverses_batch_id is not null),
  1, '(f) still exactly ONE reversal batch after two reconcile calls (no double-void)');

-- ===========================================================================
-- (g) Restore (undo): un-voids the candidate, re-posts the original postings,
-- and the pair is NOT immediately re-suppressed by a subsequent reconcile.
-- ===========================================================================
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_cmd_restore_regular_core_sweep(
    gen_random_uuid(), 'pgtap:restore-a', '{}'::jsonb,
    '00000000-0000-4000-8000-00000000a001'::uuid,
    jsonb_build_object('suppression_id', (
      select id from public.regular_core_sweep_suppressions
       where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
    ))
  )
$$, 'restore command runs without error for the owner-role actor');
reset role;

select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  'posted', '(g) restored candidate is un-voided (back to posted)');
select is(
  (select voided_at from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  null, '(g) restored candidate voided_at is cleared');
select is(
  (select coalesce(sum(p.amount_minor), 0)::bigint from public.journal_postings p
     join public.journal_batches b on b.id = p.batch_id
    where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
      and b.reverses_batch_id is null
      and not exists (select 1 from public.journal_revisions r where r.original_batch_id = b.id)
      and p.ledger_account_id = 'e7000000-0000-4000-8000-000000000011'),
  50000::bigint, '(g) the live (restored) batch reflects the original +50000 cash-leg amount');
select is(
  (select released_at is not null from public.regular_core_sweep_suppressions
    where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'),
  true, '(g) the suppression row is marked released');

-- Re-run reconcile: the restored pair must NOT be immediately re-suppressed
-- (rejected-fingerprint guard).
select is(
  (public.keel_reconcile_regular_core_sweeps(
     '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001'
   )->>'suppressed')::int,
  0, '(g) the restored pair is NOT immediately re-suppressed by the next reconcile pass');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  'posted', '(g) candidate remains posted after the follow-up reconcile call');

-- ===========================================================================
-- (h) Tenant isolation: an identical candidate/counterpart pair in a
-- DIFFERENT household (Beta, b001/b101) is never touched by reconciling
-- Alpha's connection, even though Beta's own connection is separately
-- allowlisted.
-- ===========================================================================
insert into public.connections (id, household_id, provider, external_ref, status, institution_id) values
  ('e8000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000b001',
   'plaid', 'pgtap:coresweep:beta:item', 'active', null);
insert into public.ledger_accounts (id, household_id, entity_id, name, kind, currency, is_category) values
  ('e8000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'Beta Coresweep Cash Ledger', 'asset', 'USD', false);
insert into public.accounts
  (id, household_id, entity_id, connection_id, ledger_account_id, name, subtype, currency, external_ref)
values
  ('e8000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'e8000000-0000-4000-8000-000000000001',
   'e8000000-0000-4000-8000-000000000011', 'Beta Coresweep Cash Mgmt', 'cash management', 'USD',
   'pgtap:coresweep:beta:acct');
insert into public.regular_core_sweep_allowlist (household_id, connection_id, note) values
  ('00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000001', 'pgtap beta fixture');

insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000001', 'plaid',
   'beta-sweep-a:raw', 'pgtap:coresweep:beta:acct', '{}'::jsonb, now()),
  ('00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000001', 'plaid',
   'beta-transfer-a:raw', 'pgtap:coresweep:beta:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e8000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'e8000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-01',
   'txn:plaid:pgtap:coresweep:beta:item:beta-sweep-a'),
  ('e8000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000b001',
   '00000000-0000-4000-8000-00000000b101', 'e8000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-01',
   'txn:plaid:pgtap:coresweep:beta:item:beta-transfer-a');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-0000000000a1',
   'REDEMPTION FROM CORE ACCOUNT (SPAXX)', '2026-06-01', gen_random_uuid()),
  ('00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-0000000000a2',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-01', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e8000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000b101', 50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e8000000-0000-4000-8000-0000000000a1'
union all
select b.id, '00000000-0000-4000-8000-00000000b318', '00000000-0000-4000-8000-00000000b101', -50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e8000000-0000-4000-8000-0000000000a1'
union all
select b.id, '00000000-0000-4000-8000-00000000b317', '00000000-0000-4000-8000-00000000b101', 50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e8000000-0000-4000-8000-0000000000a2'
union all
select b.id, 'e8000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000b101', -50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e8000000-0000-4000-8000-0000000000a2';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000021',
       'beta-sweep-a', 50000, 'USD', '2026-06-01', 'REDEMPTION FROM CORE ACCOUNT (SPAXX)', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'beta-sweep-a:raw'
union all
select r.id, '00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000021',
       'beta-transfer-a', -50000, 'USD', '2026-06-01', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'beta-transfer-a:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e8000000-0000-4000-8000-0000000000a1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'beta-sweep-a'
union all
select 'e8000000-0000-4000-8000-0000000000a2', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'beta-transfer-a';

-- Reconcile ALPHA's connection again -- Beta's identical-shaped pair must be
-- completely untouched (different household_id scope throughout every CTE).
select public.keel_reconcile_regular_core_sweeps(
  '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e8000000-0000-4000-8000-0000000000a1'),
  'posted',
  '(h) a matching pair in a DIFFERENT household is never touched by another household''s reconcile call');
select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where household_id = '00000000-0000-4000-8000-00000000b001'),
  0, '(h) no suppression row exists yet for Beta (proves Alpha''s call never crossed tenants)');

-- Reconciling BETA's OWN connection, however, does correctly suppress it --
-- proving this is tenant SCOPING, not a blanket bug that never fires for Beta.
select is(
  (public.keel_reconcile_regular_core_sweeps(
     '00000000-0000-4000-8000-00000000b001', 'e8000000-0000-4000-8000-000000000001'
   )->>'suppressed')::int,
  1, '(h) reconciling Beta''s OWN connection suppresses Beta''s own pair');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e8000000-0000-4000-8000-0000000000a1'),
  'voided', '(h) Beta''s candidate is voided once Beta''s own connection is reconciled');

-- ===========================================================================
-- (i) Apply-key bug regression (independent Codex code review of this PR):
-- the reconcile loop's idempotency apply_key must vary with the (candidate,
-- counterpart) PAIR, not just the candidate id. Candidate a1 was already
-- restored in (g) (un-voided, back to 'posted') and its ORIGINAL counterpart
-- a2 remains live/untouched. Here a2 is excluded via a legitimate CONFIRMED
-- transfer_links row (same idiom as (d)'s decoy exclusion -- simulating the
-- real scenario where a2 got matched/superseded elsewhere), and a BRAND NEW
-- counterpart (f1) is introduced on the SAME account/day with the exact
-- opposite amount of a1's live batch. This is precisely the scenario the old
-- candidate-only apply_key (`'core-sweep-suppress:' || candidate_txn`) could
-- not handle: the new (a1, f1) pairing's evidence_hash differs from the
-- (a1, a2) pairing already recorded in command_executions under the OLD key,
-- so before the fix, keel_idempotency_check would raise
-- KEEL_IDEMPOTENCY_CONFLICT -- an uncaught exception that aborts the ENTIRE
-- reconcile call. Fresh dedicated ids (the 'f' band -- valid hex, unlike a
-- literal 'i') are used for the new fixtures to keep this scenario isolated
-- from every earlier assertion in this file.
-- ---------------------------------------------------------------------------

-- Exclude a2 from the counterpart pool via a CONFIRMED transfer_links row
-- against a dedicated decoy (mirrors (d)'s d9 pattern) -- otherwise a1 would
-- ambiguously match BOTH a2 and the new f1 counterpart below (same day, same
-- account, same magnitude) and never reach the suppression path at all.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000f9', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'manual', 'Unrelated decoy transaction (excludes a2 from the counterpart pool)',
   '2026-06-01', 'txn:pgtap:coresweep:decoy:f9');

insert into public.transfer_links (household_id, txn_out, txn_in, status, decided_by, decided_at)
values (
  '00000000-0000-4000-8000-00000000a001',
  'e7000000-0000-4000-8000-0000000000a2', 'e7000000-0000-4000-8000-0000000000f9',
  'confirmed', '00000000-0000-4000-8000-000000000001', now()
);

-- New counterpart f1: same account, same day as a1, exact opposite amount of
-- a1's (restored) live +50000 cash leg.
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001', 'plaid',
   'transfer-f:raw', 'pgtap:coresweep:acct', '{}'::jsonb, now());

insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('e7000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'e7000000-0000-4000-8000-000000000021',
   'posted', 'sync', 'TRANSFERRED TO VS Z37-626027-1', '2026-06-01',
   'txn:plaid:pgtap:coresweep:item:transfer-f');

insert into public.journal_batches (household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-0000000000f1',
   'TRANSFERRED TO VS Z37-626027-1', '2026-06-01', gen_random_uuid());

insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
select b.id, 'e7000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a101', -50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000f1'
union all
select b.id, '00000000-0000-4000-8000-00000000a317', '00000000-0000-4000-8000-00000000a101', 50000, 'USD'
  from public.journal_batches b where b.canonical_transaction_id = 'e7000000-0000-4000-8000-0000000000f1';

insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor, currency,
   effective_date, description, pending, pfc_primary)
select r.id, '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000021',
       'transfer-f', -50000, 'USD', '2026-06-01', 'TRANSFERRED TO VS Z37-626027-1', false, 'TRANSFER_OUT'
  from public.raw_provider_events r where r.provider_event_id = 'transfer-f:raw';

insert into public.transaction_source_links (canonical_transaction_id, normalized_source_record_id)
select 'e7000000-0000-4000-8000-0000000000f1', n.id
  from public.normalized_source_records n where n.provider_transaction_id = 'transfer-f';

-- The reconcile call must SUCCEED (no uncaught KEEL_IDEMPOTENCY_CONFLICT) --
-- this is the exact call that raised before the apply-key fix.
select lives_ok($$
  select public.keel_reconcile_regular_core_sweeps(
    '00000000-0000-4000-8000-00000000a001', 'e7000000-0000-4000-8000-000000000001')
$$, '(i) reconcile succeeds when a restored candidate re-pairs with a DIFFERENT counterpart '
    || '(apply-key bug fix: the key must vary with the pair, not just the candidate)');

select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a1'),
  'voided', '(i) candidate a1 is voided again, this time paired with the NEW counterpart f1');
select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'
      and counterpart_transaction_id = 'e7000000-0000-4000-8000-0000000000f1'
      and released_at is null),
  1, '(i) a NEW active suppression row records the (a1, f1) pairing');
select is(
  (select count(*)::int from public.regular_core_sweep_suppressions
    where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'),
  2, '(i) candidate a1 now has TWO suppression rows total: the original released one (a1,a2) '
     || 'and the new active one (a1,f1)');
select is(
  (select count(distinct evidence_hash)::int from public.regular_core_sweep_suppressions
    where candidate_transaction_id = 'e7000000-0000-4000-8000-0000000000a1'),
  2, '(i) the two suppression rows carry DIFFERENT evidence hashes (proves the new pairing '
     || 'was not treated as a replay of the old one)');
select is(
  (select status::text from public.canonical_transactions
    where id = 'e7000000-0000-4000-8000-0000000000a2'),
  'posted', '(i) the ORIGINAL counterpart a2 remains untouched throughout (excluded via its own '
    || 'confirmed transfer_links row, never voided by this pass)');

select * from finish();
rollback;
