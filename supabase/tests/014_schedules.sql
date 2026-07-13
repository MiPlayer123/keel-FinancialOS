-- pgTAP: scheduled transactions (Quicken bill/income reminders) — schema,
-- ownership/ACL hardening (batch-8 review), anchor-day month-end recovery,
-- atomic Enter, idempotent economics, and validation error codes.
begin;
select plan(54);

-- ---------------------------------------------------------------------------
-- Schema (7)
-- ---------------------------------------------------------------------------
select has_table('public', 'scheduled_transactions', 'scheduled transactions exist');
select has_column('public', 'scheduled_transactions', 'anchor_day',
  'anchor day recorded for month-end recovery');
select has_function('public', 'keel_schedule_save',
  array['uuid','uuid','uuid','text','bigint','uuid','text','date','integer'],
  'save (create/update) command exists');
select has_function('public', 'keel_schedule_set_status',
  array['uuid','uuid','text'], 'set_status command exists');
select has_function('public', 'keel_schedule_advance',
  array['uuid','uuid','date','text'], 'advance command exists');
select has_function('public', 'keel_schedule_enter',
  array['uuid','uuid','date'], 'enter command exists');
select has_function('public', 'keel_list_schedules',
  array['uuid'], 'list read exists');

-- ---------------------------------------------------------------------------
-- Ownership (5): re-owned to keel_api (batch-8 hardening — was the
-- migration-runner superuser, a needlessly large blast radius for a
-- SECURITY DEFINER body).
-- ---------------------------------------------------------------------------
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)'::regprocedure),
  'keel_api', 'save owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_schedule_set_status(uuid,uuid,text)'::regprocedure),
  'keel_api', 'set_status owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_schedule_advance(uuid,uuid,date,text)'::regprocedure),
  'keel_api', 'advance owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_schedule_enter(uuid,uuid,date)'::regprocedure),
  'keel_api', 'enter owned by keel_api');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_list_schedules(uuid)'::regprocedure),
  'keel_api', 'list owned by keel_api');

-- ---------------------------------------------------------------------------
-- ACL (10): no PUBLIC/anon EXECUTE on any of the five; authenticated can
-- call all five. Ownership change alone does not grant/revoke ACLs — these
-- prove the ACL rows are still exactly what the house pattern expects.
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('anon',
  'public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)', 'EXECUTE'),
  'anon cannot call save');
select ok(has_function_privilege('authenticated',
  'public.keel_schedule_save(uuid,uuid,uuid,text,bigint,uuid,text,date,integer)', 'EXECUTE'),
  'authenticated can call save');
select ok(not has_function_privilege('anon',
  'public.keel_schedule_set_status(uuid,uuid,text)', 'EXECUTE'),
  'anon cannot call set_status');
select ok(has_function_privilege('authenticated',
  'public.keel_schedule_set_status(uuid,uuid,text)', 'EXECUTE'),
  'authenticated can call set_status');
select ok(not has_function_privilege('anon',
  'public.keel_schedule_advance(uuid,uuid,date,text)', 'EXECUTE'),
  'anon cannot call advance');
select ok(has_function_privilege('authenticated',
  'public.keel_schedule_advance(uuid,uuid,date,text)', 'EXECUTE'),
  'authenticated can call advance');
select ok(not has_function_privilege('anon',
  'public.keel_schedule_enter(uuid,uuid,date)', 'EXECUTE'),
  'anon cannot call enter');
select ok(has_function_privilege('authenticated',
  'public.keel_schedule_enter(uuid,uuid,date)', 'EXECUTE'),
  'authenticated can call enter');
select ok(not has_function_privilege('anon',
  'public.keel_list_schedules(uuid)', 'EXECUTE'),
  'anon cannot call list');
select ok(has_function_privilege('authenticated',
  'public.keel_list_schedules(uuid)', 'EXECUTE'),
  'authenticated can call list');

-- ---------------------------------------------------------------------------
-- Table grants (5): anon/authenticated get no DML on scheduled_transactions
-- directly — every mutation must go through the command procs above.
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege('anon', 'public.scheduled_transactions', 'INSERT'),
  'anon cannot insert scheduled_transactions');
select ok(not has_table_privilege('anon', 'public.scheduled_transactions', 'UPDATE'),
  'anon cannot update scheduled_transactions');
select ok(not has_table_privilege('authenticated', 'public.scheduled_transactions', 'INSERT'),
  'authenticated cannot insert scheduled_transactions directly');
select ok(not has_table_privilege('authenticated', 'public.scheduled_transactions', 'UPDATE'),
  'authenticated cannot update scheduled_transactions directly');
select ok(not has_table_privilege('authenticated', 'public.scheduled_transactions', 'DELETE'),
  'authenticated cannot delete scheduled_transactions directly');

-- ---------------------------------------------------------------------------
-- Auth/membership/validation gates (4)
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000000',
    '00000000-0000-4000-8000-00000000a401','Unauth Bill',-1000,
    '00000000-0000-4000-8000-00000000a313','monthly','2026-05-01',null)
$$, 'P0004', null, 'unauthenticated save is rejected');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001',null,
    '00000000-0000-4000-8000-00000000a401','Non-member Bill',-1000,
    '00000000-0000-4000-8000-00000000a313','monthly','2026-05-01',null)
$$, 'P0006', null, 'non-member save is rejected');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001',null,
    '00000000-0000-4000-8000-00000000a401','Bad Frequency',-1000,
    '00000000-0000-4000-8000-00000000a313','fortnightly','2026-05-01',null)
$$, 'P0009', null, 'invalid frequency is a typed validation error, not P0002');

select throws_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001',null,
    '00000000-0000-4000-8000-00000000a401','Sign Mismatch',-1000,
    '00000000-0000-4000-8000-00000000a315','monthly','2026-05-01',null)
$$, 'P0009', null, 'bill amount against an income category is a typed validation error, not P0002');

-- ---------------------------------------------------------------------------
-- Anchor-day stepping: 31 -> Feb 28 (clamp) -> Mar 31 (recovery) (5)
-- Still running as the authenticated owner (user 1, household a001).
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001',null,
    '00000000-0000-4000-8000-00000000a401','pgTAP Anchor Rent',-150000,
    '00000000-0000-4000-8000-00000000a313','monthly','2026-01-31',5)
$$, 'create monthly schedule anchored on the 31st');

select is(
  (select anchor_day::int from public.scheduled_transactions
    where household_id = '00000000-0000-4000-8000-00000000a001' and description = 'pgTAP Anchor Rent'),
  31, 'anchor_day captured from the declared due date');

-- Echo back the SAME (already-set) due date on update — must NOT collapse
-- the anchor (this is the exact bug fixed by 20260713160000_schedule_enter.sql).
select lives_ok($$
  select public.keel_schedule_save(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '00000000-0000-4000-8000-00000000a401','pgTAP Anchor Rent',-150000,
    '00000000-0000-4000-8000-00000000a313','monthly','2026-01-31',5)
$$, 'save echoing the unchanged due date');

select is(
  (select anchor_day::int from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  31, 'echoing a clamped/unchanged date preserves anchor_day');

select lives_ok($$
  select public.keel_schedule_advance('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-01-31', 'skipped')
$$, 'advance from Jan 31 clamps into February');

select is(
  (select next_due_date from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  '2026-02-28'::date, 'Jan 31 steps to Feb 28 (28-day February, no leap year)');
select is(
  (select anchor_day::int from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  31, 'anchor_day survives the clamp — not collapsed to 28');

select lives_ok($$
  select public.keel_schedule_advance('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-02-28', 'skipped')
$$, 'advance from Feb 28 recovers the anchor');

select is(
  (select next_due_date from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  '2026-03-31'::date, 'Feb 28 recovers to Mar 31 once the target month is long enough again');

-- Stale fence: advancing from a due date that no longer matches is an
-- idempotent no-op, not an error.
select is(
  (public.keel_schedule_advance('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-01-31', 'skipped')->>'advanced')::boolean,
  false, 'advance with a stale from_due is an idempotent no-op');
select is(
  (select next_due_date from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  '2026-03-31'::date, 'stale advance leaves next_due_date untouched');

-- ---------------------------------------------------------------------------
-- Enter: exactly one canonical transaction with the expected economic key,
-- atomic with the advance; stale fence posts nothing; re-entering the same
-- occurrence never duplicates. (8)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'manual:sched:'
      || (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent')
      || ':2026-03-31'),
  0, 'no transaction posted yet for the upcoming occurrence');

select is(
  (public.keel_schedule_enter('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-02-28')->>'entered')::boolean,
  false, 'enter with a stale from_due does not post');

select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'manual:sched:'
      || (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent')
      || ':2026-03-31'),
  0, 'stale enter posted nothing');

select is(
  (public.keel_schedule_enter('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-03-31')->>'entered')::boolean,
  true, 'enter with the correct from_due posts and advances');

select is(
  (select next_due_date from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  '2026-04-30'::date, 'enter advances the schedule atomically with the post');

select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'manual:sched:'
      || (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent')
      || ':2026-03-31'),
  1, 'enter posts exactly one canonical transaction under the expected economic key');

select is(
  (public.keel_schedule_enter('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    '2026-03-31')->>'entered')::boolean,
  false, 're-entering the already-advanced occurrence is a no-op (fence moved)');

select is(
  (select count(*)::int from public.canonical_transactions
    where economic_event_key = 'manual:sched:'
      || (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent')
      || ':2026-03-31'),
  1, 'exactly one transaction was ever posted for this occurrence');

-- ---------------------------------------------------------------------------
-- Enter without a category raises the typed validation error P0009. (1)
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.keel_schedule_enter('00000000-0000-4000-8000-00000000a001',
    (select public.keel_schedule_save(
      '00000000-0000-4000-8000-00000000a001',null,
      '00000000-0000-4000-8000-00000000a401','pgTAP No Category Bill',-2500,
      null,'monthly','2026-05-15',null)),
    '2026-05-15')
$$, 'P0009', null, 'entering a schedule with no category is a typed validation error');

-- ---------------------------------------------------------------------------
-- set_status + list. (3)
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.keel_schedule_set_status('00000000-0000-4000-8000-00000000a001',
    (select id from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
    'paused')
$$, 'pause the schedule');

select is(
  (select status::text from public.scheduled_transactions where description = 'pgTAP Anchor Rent'),
  'paused', 'set_status transitions to paused');

select ok(
  (select bool_or(row->>'description' = 'pgTAP Anchor Rent')
    from jsonb_array_elements(public.keel_list_schedules('00000000-0000-4000-8000-00000000a001')) row),
  'list_schedules surfaces the schedule for a household member');

reset role;

select * from finish();
rollback;
