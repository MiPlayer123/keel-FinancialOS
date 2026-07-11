-- pgTAP: Stage 1C C2a tenant-integrity retrofit, tombstones, and grants.
begin;
select plan(10);

select ok(
  exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.accounts'::regclass
       and c.confrelid = 'public.connections'::regclass
       and c.contype = 'f'
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(c.conkey) with ordinality as k(attnum, ord)
           join pg_attribute a
             on a.attrelid = c.conrelid
            and a.attnum = k.attnum
       ) = array['household_id', 'connection_id']
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(c.confkey) with ordinality as k(attnum, ord)
           join pg_attribute a
             on a.attrelid = c.confrelid
            and a.attnum = k.attnum
       ) = array['household_id', 'id']
  ),
  'accounts has a composite tenant FK to connections'
);

select ok(
  exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.connections'::regclass
       and c.contype = 'u'
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(c.conkey) with ordinality as k(attnum, ord)
           join pg_attribute a
             on a.attrelid = c.conrelid
            and a.attnum = k.attnum
       ) = array['household_id', 'id']
  ),
  'connections has a composite household_id/id unique constraint'
);

select ok(
  exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'connections'
       and indexdef like 'CREATE UNIQUE INDEX %'
       and indexdef like '%ON public.connections USING btree (provider, external_ref)%'
       and indexdef like '%WHERE (provider = ''plaid''::bank_provider)'
  ),
  'connections has a Plaid-only unique provider/external_ref index'
);

-- A dedicated alpha connection supports both the cross-tenant probe and the
-- worker-procedure compatibility check below.
insert into public.connections
  (id, household_id, provider, external_ref, status)
values
  ('93000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a001',
   'simulator', 'pgtap-c2a-connection', 'active');

select throws_ok($$
  insert into public.canonical_transactions
    (id, household_id, entity_id, account_id, status, source,
     description, effective_date, economic_event_key)
  values
    ('93000000-0000-4000-8000-000000000002',
     '00000000-0000-4000-8000-00000000a001',
     '00000000-0000-4000-8000-00000000a101',
     '00000000-0000-4000-8000-00000000b401',
     'posted', 'manual', 'cross-tenant account probe', '2026-07-11',
     'pgtap:c2a:cross-account:0001')
$$, '23503', null,
  'canonical transaction rejects an account from another household');

select ok(
  not exists (
    select 1
      from information_schema.role_table_grants
     where grantee = 'authenticated'
       and table_schema = 'public'
       and table_name = 'connection_credentials'
  ),
  'authenticated has zero privileges on connection_credentials'
);

insert into public.raw_provider_events
  (id, household_id, connection_id, provider, provider_event_id,
   account_external_ref, body, received_at)
values
  ('93000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-00000000a001',
   '93000000-0000-4000-8000-000000000001',
   'simulator', 'pgtap:c2a:tombstone-source', 'pgtap-c2a-account',
   '{}'::jsonb, now());

select lives_ok($$
  insert into public.normalized_source_records
    (id, raw_event_id, household_id, account_id, provider_transaction_id,
     amount_minor, currency, effective_date, description, pending, kind)
  values
    ('93000000-0000-4000-8000-000000000004',
     '93000000-0000-4000-8000-000000000003',
     '00000000-0000-4000-8000-00000000a001',
     null, 'tx123', null, null, null, null, false, 'removed')
$$, 'removed tombstone accepts only its provider transaction identity');

select throws_ok($$
  insert into public.normalized_source_records
    (id, raw_event_id, household_id, account_id, provider_transaction_id,
     amount_minor, currency, effective_date, description, pending, kind)
  values
    ('93000000-0000-4000-8000-000000000005',
     '93000000-0000-4000-8000-000000000003',
     '00000000-0000-4000-8000-00000000a001',
     null, null, null, null, null, null, false, 'removed')
$$, '23502', null,
  'removed tombstone rejects a null provider transaction identity');

select lives_ok($$
  insert into public.normalized_source_records
    (id, raw_event_id, household_id, account_id, provider_transaction_id,
     amount_minor, currency, effective_date, description, pending, kind)
  values
    ('93000000-0000-4000-8000-000000000006',
     '93000000-0000-4000-8000-000000000003',
     '00000000-0000-4000-8000-00000000a001',
     '00000000-0000-4000-8000-00000000a401',
     'tx-added-valid', 1250, 'USD', '2026-07-11', 'valid added row',
     false, 'added')
$$, 'added record accepts complete economic fields');

select throws_ok($$
  insert into public.normalized_source_records
    (id, raw_event_id, household_id, account_id, provider_transaction_id,
     amount_minor, currency, effective_date, description, pending, kind)
  values
    ('93000000-0000-4000-8000-000000000007',
     '93000000-0000-4000-8000-000000000003',
     '00000000-0000-4000-8000-00000000a001',
     '00000000-0000-4000-8000-00000000a401',
     'tx-added-no-description', 1250, 'USD', '2026-07-11', null,
     false, 'added')
$$, '23514', null,
  'added record rejects a null description');

select lives_ok($$
  select public.keel_worker_record_raw_event(
    'simulator', 'pgtap-c2a-connection', 'pgtap:c2a:worker-compat',
    'pgtap-c2a-account', '{}'::jsonb, now())
$$, 'keel_worker_record_raw_event still executes after the retrofit');

select * from finish();
rollback;
