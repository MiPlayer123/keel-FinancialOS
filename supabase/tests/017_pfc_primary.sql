-- Denormalized PFC primary (20260717170000, prod perf finding: the request-
-- time raw-event scan hit the statement timeout at 37s). This suite drives
-- the REAL ingestion path — lease → open attempt → archive page →
-- keel_worker_create_normalized — and asserts the proc stamps pfc_primary
-- from ONLY the page that supplied the event. Detection reading the column
-- is covered by 016 (its fixtures stamp the same value ingestion writes);
-- the one-time backfill shares this exact extraction shape and ran at
-- migration time (unobservable here — it executes before the seed).
begin;select no_plan();

select has_column('public', 'normalized_source_records', 'pfc_primary',
  'denormalized pfc_primary column exists');

-- The column is a derived convenience copy: raw evidence remains exported,
-- the copy is omitted (same Law-6 ruling as raw_provider_events.body), so
-- keel_export needs no new privilege and the 008 inventory carries it as an
-- omitted column.

-- ---------------------------------------------------------------------------
-- Real ingestion path. Lease the seeded plaid connection for a fake worker
-- owner, open an attempt, archive a Plaid-shaped page, then normalize
-- records through keel_worker_create_normalized exactly as the worker does.
-- ---------------------------------------------------------------------------
update public.connections
   set sync_lease_owner = 'd7000000-0000-4000-8000-000000000001',
       sync_leased_until = now() + interval '10 minutes'
 where id = '00000000-0000-4000-8000-00000000a202';

create temporary table _pfc_ctx on commit drop as
  select public.keel_worker_open_attempt(
           '00000000-0000-4000-8000-00000000a202',
           'd7000000-0000-4000-8000-000000000001',
           '') as attempt_id;

create temporary table _pfc_page on commit drop as
  select public.keel_worker_archive_page(
           (select attempt_id from _pfc_ctx),
           'd7000000-0000-4000-8000-000000000001',
           1,
           '{"added":[{"transaction_id":"pgtap-pfc-1","personal_finance_category":{"primary":"FOOD_AND_DRINK"}},{"transaction_id":"pgtap-pfc-2"}],"modified":[],"removed":[],"next_cursor":"pgtap-pfc-c1","has_more":false}'
         ) as raw_id;

-- 1) An 'added' event WITH a PFC: the primary is stamped onto the record.
select is(
  (select pfc_primary from public.normalized_source_records
    where id = public.keel_worker_create_normalized(
      (select attempt_id from _pfc_ctx),
      'd7000000-0000-4000-8000-000000000001',
      (select raw_id from _pfc_page),
      '00000000-0000-4000-8000-00000000a401',
      'pgtap-pfc-1', 'added', '-1200', 'USD', '2026-07-11', 'PFC CAFE', false)),
  'FOOD_AND_DRINK',
  'ingestion stamps the added PFC primary onto the normalized record');

-- 2) An 'added' event WITHOUT a PFC object: empty string — preserving the
-- original extraction's coalesce-to-'' (maps to Other / Other Income).
select is(
  (select pfc_primary from public.normalized_source_records
    where id = public.keel_worker_create_normalized(
      (select attempt_id from _pfc_ctx),
      'd7000000-0000-4000-8000-000000000001',
      (select raw_id from _pfc_page),
      '00000000-0000-4000-8000-00000000a401',
      'pgtap-pfc-2', 'added', '-500', 'USD', '2026-07-11', 'NO PFC SHOP', false)),
  '',
  'an added entry without a PFC stamps the empty string (Other mapping preserved)');

-- 3) A record whose ptid is NOT in this page's added array: NULL (no PFC
-- evidence for this record — e.g. modified-only pages, simulator pages).
select ok(
  (select pfc_primary from public.normalized_source_records
    where id = public.keel_worker_create_normalized(
      (select attempt_id from _pfc_ctx),
      'd7000000-0000-4000-8000-000000000001',
      (select raw_id from _pfc_page),
      '00000000-0000-4000-8000-00000000a401',
      'pgtap-pfc-3', 'added', '-900', 'USD', '2026-07-11', 'UNLISTED', false)) is null,
  'a ptid absent from the page''s added array stamps NULL');

-- 4) Removed events never attempt extraction.
select ok(
  (select pfc_primary from public.normalized_source_records
    where id = public.keel_worker_create_normalized(
      (select attempt_id from _pfc_ctx),
      'd7000000-0000-4000-8000-000000000001',
      (select raw_id from _pfc_page),
      null,
      'pgtap-pfc-1', 'removed', null, null, null, null, false)) is null,
  'a removed record carries no PFC');

-- ---------------------------------------------------------------------------
-- The rewritten consumers no longer touch raw_provider_events for PFC: the
-- proc source must not reference the raw table's body anymore (regression
-- pin for the 37s scan).
-- ---------------------------------------------------------------------------
select ok(
  pg_get_functiondef('public.keel_detect_category_suggestions(uuid)'::regprocedure)
    not like '%raw_provider_events%',
  'detection no longer scans raw_provider_events');
select ok(
  pg_get_functiondef('public.keel_autocategorize_household(uuid)'::regprocedure)
    not like '%raw_provider_events%',
  'autocategorize no longer scans raw_provider_events');
select ok(
  pg_get_functiondef('public.keel_detect_category_suggestions(uuid)'::regprocedure)
    like '%pfc_primary%',
  'detection reads the denormalized pfc_primary');

select * from finish();rollback;
