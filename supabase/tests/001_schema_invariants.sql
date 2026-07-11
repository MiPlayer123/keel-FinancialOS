-- pgTAP: schema-level financial invariants (TASK-000 tests 1, 2, 4).
begin;
select plan(13);

-- Test 2 (restated per PLAN §3.5.9): no money column is float/numeric —
-- catalog assertion across the whole public schema.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public'
      and column_name like '%minor%'
      and data_type not in ('bigint')),
  0,
  'every *_minor money column is BIGINT'
);
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public'
      and data_type in ('real', 'double precision')),
  0,
  'no float column exists anywhere in public schema'
);

-- Test 1: deferred balance trigger rejects an unbalanced batch at commit.
-- (Constraint triggers fire at COMMIT; inside pgTAP we force with SET CONSTRAINTS.)
create temp table _ids as
select
  (select id from public.households limit 1) as hh,
  (select id from public.entities where household_id = (select id from public.households limit 1) limit 1) as ent,
  (select id from public.ledger_accounts
    where household_id = (select id from public.households limit 1)
      and name = 'Simulator Checking') as checking,
  (select id from public.ledger_accounts
    where household_id = (select id from public.households limit 1)
      and name = 'Groceries') as groceries;

select lives_ok($$
  insert into public.journal_batches (id, household_id, description, effective_date, command_id)
  values ('99999999-0000-4000-8000-000000000001',
          (select hh from _ids), 'balanced test batch', '2026-07-01', gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values ('99999999-0000-4000-8000-000000000001', (select groceries from _ids), (select ent from _ids), 8742, 'USD'),
         ('99999999-0000-4000-8000-000000000001', (select checking from _ids), (select ent from _ids), -8742, 'USD');
  set constraints all immediate;
$$, 'balanced batch commits');

select throws_ok($$
  insert into public.journal_batches (id, household_id, description, effective_date, command_id)
  values ('99999999-0000-4000-8000-000000000002',
          (select hh from _ids), 'unbalanced test batch', '2026-07-01', gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values ('99999999-0000-4000-8000-000000000002', (select groceries from _ids), (select ent from _ids), 8742, 'USD'),
         ('99999999-0000-4000-8000-000000000002', (select checking from _ids), (select ent from _ids), -8000, 'USD');
  set constraints all immediate;
$$, 'P0002', null, 'unbalanced batch is rejected (Law 3)');

select throws_ok($$
  insert into public.journal_batches (id, household_id, description, effective_date, command_id)
  values ('99999999-0000-4000-8000-000000000003',
          (select hh from _ids), 'single posting batch', '2026-07-01', gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values ('99999999-0000-4000-8000-000000000003', (select groceries from _ids), (select ent from _ids), 0, 'USD');
  set constraints all immediate;
$$, '23514', null, 'zero-amount posting violates CHECK');

-- Test 4: append-only enforcement — raw events, postings, audit, registry.
insert into public.raw_provider_events
  (household_id, connection_id, provider, provider_event_id,
   account_external_ref, body, received_at)
select c.household_id, c.id, c.provider, 'pgtap:immutable:0001',
       'pgtap-account', '{}'::jsonb, now()
  from public.connections c
 where c.household_id = (select hh from _ids)
 limit 1;

select throws_ok($$
  update public.raw_provider_events set body = '{}'::jsonb
   where provider_event_id = 'pgtap:immutable:0001'
$$, 'P0001', null, 'raw events cannot be updated');

-- Ensure the immutability triggers exist on every append-only table.
select is(
  (select count(*)::int from information_schema.triggers
    where trigger_name like '%_immutable'
      and event_object_table in
        ('raw_provider_events','normalized_source_records','import_rows',
         'journal_batches','journal_postings','journal_revisions',
         'audit_log','domain_events','command_executions','webhook_rejections')),
  20, -- one trigger row per event (UPDATE + DELETE) per table
  'append-only triggers cover all immutable tables'
);

-- Period locks: inserting a posting dated inside an active lock fails.
insert into public.period_locks (id, household_id, entity_id, start_date, end_date, locked_by)
values ('99999999-0000-4000-8000-00000000000a', (select hh from _ids), null,
        '2026-01-01', '2026-01-31',
        (select user_id from public.household_memberships where household_id = (select hh from _ids) limit 1));

select throws_ok($$
  insert into public.journal_batches (id, household_id, description, effective_date, command_id)
  values ('99999999-0000-4000-8000-000000000004',
          (select hh from _ids), 'locked period batch', '2026-01-15', gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values ('99999999-0000-4000-8000-000000000004', (select groceries from _ids), (select ent from _ids), 100, 'USD'),
         ('99999999-0000-4000-8000-000000000004', (select checking from _ids), (select ent from _ids), -100, 'USD');
$$, 'P0003', null, 'posting into a locked period is rejected');

-- Reopened locks admit postings again.
update public.period_locks set reopened_at = now(), reopen_reason = 'pgTAP reopen test'
 where id = '99999999-0000-4000-8000-00000000000a';

select lives_ok($$
  insert into public.journal_batches (id, household_id, description, effective_date, command_id)
  values ('99999999-0000-4000-8000-000000000005',
          (select hh from _ids), 'reopened period batch', '2026-01-15', gen_random_uuid());
  insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency)
  values ('99999999-0000-4000-8000-000000000005', (select groceries from _ids), (select ent from _ids), 100, 'USD'),
         ('99999999-0000-4000-8000-000000000005', (select checking from _ids), (select ent from _ids), -100, 'USD');
  set constraints all immediate;
$$, 'reopened period accepts postings (Law 2 reopen semantics)');

-- Class D autonomy can never be granted (Law 10).
select throws_ok($$
  insert into public.approval_policies (id, household_id, risk_class, autonomy, created_at)
  values (gen_random_uuid(), (select hh from _ids), 'D', 'suggest', now())
$$, '23514', null, 'class-D autonomy above off is rejected');

-- Idempotency registry is household-scoped (Codex audit F7).
select is(
  (select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum))
     from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
    where c.relname = 'command_executions' and i.indisprimary),
  'household_id,economic_event_key',
  'command_executions PK is (household_id, economic_event_key)'
);

-- Seed sanity: two households, cross-membership user present.
select is((select count(*)::int from public.households), 2, 'seed created two households');
select is(
  (select count(distinct household_id)::int from public.household_memberships
    where user_id = '00000000-0000-4000-8000-000000000001'),
  2,
  'alex belongs to both households (cross-tenant test user)'
);

select * from finish();
rollback;
