-- Plaid-primary recurring detection (20260814100000 + 20260814140000):
-- mirrored provider streams become KEEL recurring series WITHOUT ever growing a
-- twin next to a series the household already has. The duplicate guard is the
-- whole point of this pass — a provider re-detecting something the user already
-- confirmed (or already dismissed) must link, never create.
begin;
select no_plan();

select has_table('public', 'plaid_recurring_streams', 'stream mirror exists');
select has_table('public', 'plaid_recurring_allowlist', 'billed-add-on allowlist exists');
select has_function('public', 'keel_recurring_ingest_plaid_series', array['uuid'],
  'mapping pass exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_recurring_ingest_plaid_series(uuid)'::regprocedure),
  'keel_worker', 'mapping pass is a keel_worker-owned definer');
select ok(not has_function_privilege('authenticated',
  'public.keel_recurring_ingest_plaid_series(uuid)', 'EXECUTE'),
  'authenticated cannot run the mapping pass directly');
select ok(not has_table_privilege('keel_export', 'public.plaid_recurring_streams', 'SELECT'),
  'export role has no reach into the provider mirror');

-- The label cleaner strips per-occurrence noise the shared normalizer keeps:
-- a stream description is the memo of its LATEST transaction.
select is(public.keel_provider_stream_label('', 'Payment to Chase card ending in 4550 08/06'),
  'payment to chase card', 'card mask + date + dangling preposition stripped');
select is(public.keel_provider_stream_label('', 'DEEPTUNE PAYROLL PPD ID: 911757100'),
  'deeptune payroll', 'ACH batch descriptor stripped');
select is(public.keel_provider_stream_label('Spotify', 'SPOTIFY P2D3F4 08/09'),
  'spotify', 'a provider merchant name wins over the raw memo');
select is(public.keel_normalize_counterparty('Spotify  #1234'), 'spotify',
  'the shared normalizer is untouched by the provider cleaner');

-- ---------------------------------------------------------------------------
-- Fixtures on the seeded alpha household: one connection, four streams, and the
-- source records their transaction ids resolve to (dates/amounts come from OUR
-- records, never from Plaid's summary fields).
-- ---------------------------------------------------------------------------
insert into public.connections (id, household_id, provider, external_ref, status)
values ('d4000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
        'plaid', 'pgtap-item-recurring', 'active');

insert into public.raw_provider_events
  (id, household_id, connection_id, provider, provider_event_id, account_external_ref, body, received_at)
values ('d4000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001',
        'd4000000-0000-4000-8000-000000000001', 'plaid', 'pgtap-recurring-evt', 'acct-ext',
        '{}'::jsonb, '2026-06-20T00:00:00Z');

-- Three monthly occurrences for each of the two "real" streams.
insert into public.normalized_source_records
  (id, raw_event_id, household_id, account_id, provider_transaction_id, amount_minor,
   currency, effective_date, description, pending, kind)
select ('d4000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'd4000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001',
       '00000000-0000-4000-8000-00000000a401', 'ptx-sub-' || n, -1299,
       'USD', make_date(2026, 3 + n, 12), 'QUILLSTACK NOTES', false, 'added'
  from generate_series(1, 3) n;
insert into public.normalized_source_records
  (id, raw_event_id, household_id, account_id, provider_transaction_id, amount_minor,
   currency, effective_date, description, pending, kind)
select ('d4000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       'd4000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001',
       '00000000-0000-4000-8000-00000000a401', 'ptx-known-' || n, -4500,
       'USD', make_date(2026, 3 + n, 20), 'ORBITLOOM FIBER', false, 'added'
  from generate_series(1, 3) n;

insert into public.plaid_recurring_streams
  (household_id, connection_id, account_id, external_account_ref, stream_id, direction,
   status, frequency, is_active, description, merchant_name, category_primary,
   first_date, last_date, predicted_next_date, average_amount_minor, last_amount_minor,
   currency, raw)
values
  -- (1) genuinely new to KEEL -> becomes a suggestion
  ('00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a401', 'acct-ext', 'stream-new', 'outflow',
   'MATURE', 'MONTHLY', true, 'QUILLSTACK NOTES 05/12', null, 'GENERAL_SERVICES',
   '2026-04-12', '2026-06-12', '2026-07-12', -1299, -1299, 'USD',
   jsonb_build_object('transaction_ids', jsonb_build_array('ptx-sub-1','ptx-sub-2','ptx-sub-3'))),
  -- (2) KEEL already has this one confirmed -> must link, never twin
  ('00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a401', 'acct-ext', 'stream-known', 'outflow',
   'MATURE', 'MONTHLY', true, 'ORBITLOOM FIBER 05/20', null, 'RENT_AND_UTILITIES',
   '2026-04-20', '2026-06-20', '2026-07-20', -4500, -4500, 'USD',
   jsonb_build_object('transaction_ids', jsonb_build_array('ptx-known-1','ptx-known-2','ptx-known-3'))),
  -- (3) a P2P rail -> suppressed for provider detections exactly as for ours
  ('00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a401', 'acct-ext', 'stream-p2p', 'outflow',
   'MATURE', 'MONTHLY', true, 'VENMO PAYMENT', 'Venmo', 'TRANSFER_OUT',
   '2026-04-01', '2026-06-01', '2026-07-01', -2000, -2000, 'USD',
   jsonb_build_object('transaction_ids', jsonb_build_array('ptx-sub-1','ptx-sub-2','ptx-sub-3'))),
  -- (4) no cadence Plaid can name -> never guessed into a schedule
  ('00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a401', 'acct-ext', 'stream-unknown', 'outflow',
   'EARLY_DETECTION', 'UNKNOWN', true, 'CEDARWORKS SUPPLY', null, 'GENERAL_MERCHANDISE',
   '2026-04-03', '2026-06-03', null, -800, -800, 'USD',
   jsonb_build_object('transaction_ids', jsonb_build_array('ptx-sub-1','ptx-sub-2','ptx-sub-3')));

-- The series KEEL already knows about, in the terminal state that matters most:
-- the user confirmed it.
insert into public.recurring_series
  (household_id, series_key, account_id, ledger_account_id, counterparty_key,
   currency, sign, status, confirmed_at)
values
  ('00000000-0000-4000-8000-00000000a001', 'pgtap-existing-confirmed',
   '00000000-0000-4000-8000-00000000a401', '00000000-0000-4000-8000-00000000a301',
   'orbitloom fiber', 'USD', 'outflow', 'confirmed', now());

select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the mapping pass runs');

select is(
  (select count(*)::int from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where s.household_id = '00000000-0000-4000-8000-00000000a001'
      and cv.detector_version = 'plaid-streams-v1'),
  1, 'exactly one provider series is created (the one KEEL had no evidence for)');

select is(
  (select s.counterparty_key from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1'),
  'quillstack notes', 'the provider series carries the cleaned label');

select is(
  (select s.status::text from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1'),
  'suggested', 'a provider series still requires approval (Law 10 class B)');

select is(
  (select link_kind from public.plaid_recurring_streams where stream_id = 'stream-known'),
  'matched', 'a stream KEEL already covers links to the existing series');
select is(
  (select matched_series_id from public.plaid_recurring_streams where stream_id = 'stream-known'),
  (select id from public.recurring_series where series_key = 'pgtap-existing-confirmed'),
  'and links to precisely that series');
select is(
  (select status::text from public.recurring_series where series_key = 'pgtap-existing-confirmed'),
  'confirmed', 'the confirmed series is untouched by the provider pass');

select is(
  (select skip_reason from public.plaid_recurring_streams where stream_id = 'stream-p2p'),
  'suppressed', 'a P2P rail is suppressed for provider detections too');
select is(
  (select skip_reason from public.plaid_recurring_streams where stream_id = 'stream-unknown'),
  'unknown_cadence', 'an unnameable cadence is never guessed');
select ok(
  (select matched_series_id is null from public.plaid_recurring_streams
    where stream_id in ('stream-p2p', 'stream-unknown') limit 1),
  'skipped streams create no series at all');

-- Idempotence: the pass is scheduled daily, so a second run over unchanged
-- streams must add nothing.
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the mapping pass runs again');
select is(
  (select count(*)::int from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1'),
  1, 're-running creates no duplicate series');
select is(
  (select count(*)::int from public.recurring_candidate_versions
    where detector_version = 'plaid-streams-v1'),
  1, 're-running writes no duplicate candidate version');

-- A dismissal must stick: dismissing the provider series and re-running must
-- not resurrect it as a fresh suggestion.
update public.recurring_series set status = 'rejected'
 where series_key <> 'pgtap-existing-confirmed'
   and id in (select s.id from public.recurring_series s
                join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
               where cv.detector_version = 'plaid-streams-v1');
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the mapping pass runs after a dismissal');
select is(
  (select count(*)::int from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1' and s.status = 'suggested'),
  0, 'a dismissed provider series is not re-suggested');

-- ---------------------------------------------------------------------------
-- Codex review regressions (#172/#173 follow-up, 20260814150000). Each of
-- these was a real defect found in review and confirmed against live data.
-- ---------------------------------------------------------------------------

-- The nightly GRID detection reap must not touch provider series: they are
-- never in its emitted-id list, so before this scoping every Plaid suggestion
-- was withdrawn within a day of appearing — and the Plaid pass would not bring
-- it back, because an unchanged stream fingerprint is a no-op.
update public.recurring_series set status = 'suggested'
 where id in (select s.id from public.recurring_series s
                join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
               where cv.detector_version = 'plaid-streams-v1');
select is(
  public.keel_recurring_reap_stale_suggestions(
    '00000000-0000-4000-8000-00000000a001',
    (select detector_run_id from public.recurring_candidate_versions
      where detector_version = 'plaid-streams-v1' limit 1),
    array[gen_random_uuid()]::uuid[], true),
  0, 'the grid reaper withdraws no provider series');
select is(
  (select count(*)::int from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1' and s.status = 'suggested'),
  1, 'the provider suggestion survives a grid detection run');

-- Two streams from ONE merchant are two series: the grid detector puts cadence,
-- anchor and amount in its identity precisely because a counterparty can bill
-- more than one plan, and collapsing them drops a projection.
insert into public.plaid_recurring_streams
  (household_id, connection_id, account_id, external_account_ref, stream_id, direction,
   status, frequency, is_active, description, merchant_name, category_primary,
   first_date, last_date, predicted_next_date, average_amount_minor, last_amount_minor,
   currency, raw)
values
  ('00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-00000000a401', 'acct-ext', 'stream-second-plan', 'outflow',
   'MATURE', 'ANNUALLY', true, 'QUILLSTACK NOTES 05/12', null, 'GENERAL_SERVICES',
   '2026-04-12', '2026-06-12', '2027-04-12', -9900, -9900, 'USD',
   jsonb_build_object('transaction_ids', jsonb_build_array('ptx-sub-1','ptx-sub-2','ptx-sub-3')));
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the pass runs with a second stream from the same merchant');
select is(
  (select count(*)::int from public.recurring_series s
     join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
    where cv.detector_version = 'plaid-streams-v1'),
  2, 'a second stream from the same merchant gets its own series');

-- A stream the caller FETCHED but could not map must keep its stored state; only
-- a stream Plaid genuinely stopped reporting is deactivated.
select lives_ok(
  $$select public.keel_ingest_plaid_recurring_streams(
      '00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
      '[]'::jsonb,
      array['stream-new','stream-known','stream-p2p','stream-unknown','stream-second-plan'])$$,
  'an empty payload with the fetched ids reconciles nothing');
select is(
  (select count(*)::int from public.plaid_recurring_streams
    where household_id = '00000000-0000-4000-8000-00000000a001' and is_active),
  5, 'streams that merely failed mapping stay active');
select lives_ok(
  $$select public.keel_ingest_plaid_recurring_streams(
      '00000000-0000-4000-8000-00000000a001', 'd4000000-0000-4000-8000-000000000001',
      '[]'::jsonb, array[]::text[])$$,
  'an empty payload with no fetched ids reconciles');
select is(
  (select count(*)::int from public.plaid_recurring_streams
    where household_id = '00000000-0000-4000-8000-00000000a001' and is_active),
  0, 'streams Plaid genuinely stopped reporting are deactivated');

-- Second review round on the fixes themselves (same follow-up migration).
--
-- The reconciliation test above deliberately left every stream deactivated, and
-- the mapping pass only looks at active streams — so without this the cases
-- below would assert against an empty loop and pass for the wrong reason.
update public.plaid_recurring_streams
   set is_active = true, absent_since = null
 where household_id = '00000000-0000-4000-8000-00000000a001';

-- A stream an earlier pass collapsed onto ANOTHER stream's provider series must
-- be re-evaluated, not honoured forever, or its lost projection never returns.
insert into public.plaid_recurring_streams
  (household_id, connection_id, account_id, external_account_ref, stream_id, direction,
   status, frequency, is_active, description, merchant_name, category_primary,
   first_date, last_date, predicted_next_date, average_amount_minor, last_amount_minor,
   currency, raw, matched_series_id, link_kind, linked_at)
select household_id, connection_id, account_id, external_account_ref, 'stream-collapsed',
       direction, status, 'ANNUALLY', true, description, merchant_name, category_primary,
       first_date, last_date, predicted_next_date, average_amount_minor, last_amount_minor,
       currency, raw,
       (select s.id from public.recurring_series s
          join public.recurring_candidate_versions cv on cv.id = s.current_candidate_version_id
         where cv.detector_version = 'plaid-streams-v1' limit 1),
       'matched', now()
  from public.plaid_recurring_streams where stream_id = 'stream-new';
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the pass runs with a wrongly collapsed link');
select is(
  (select link_kind from public.plaid_recurring_streams where stream_id = 'stream-collapsed'),
  'created', 'a collapsed link is re-evaluated into its own series');

-- A provider series the user ACTED ON keeps its stream even when the grid
-- detector later mints its own series for the same merchant: moving the link
-- would strand the confirmed series with nothing refreshing it.
update public.recurring_series set status = 'confirmed', confirmed_at = now()
 where id = (select matched_series_id from public.plaid_recurring_streams
              where stream_id = 'stream-new');
insert into public.recurring_series
  (household_id, series_key, account_id, ledger_account_id, counterparty_key,
   currency, sign, status)
select household_id, 'pgtap-grid-twin', account_id, ledger_account_id, counterparty_key,
       currency, sign, 'suggested'
  from public.recurring_series
 where id = (select matched_series_id from public.plaid_recurring_streams
              where stream_id = 'stream-new');
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the pass runs with a grid twin beside a confirmed provider series');
select is(
  (select s.status::text from public.recurring_series s
    where s.id = (select matched_series_id from public.plaid_recurring_streams
                   where stream_id = 'stream-new')),
  'confirmed', 'the acted-on provider series keeps its status');
select isnt(
  (select matched_series_id from public.plaid_recurring_streams where stream_id = 'stream-new'),
  (select id from public.recurring_series where series_key = 'pgtap-grid-twin'),
  'and keeps its stream rather than handing it to the grid twin');

-- A `removed` tombstone must drop the transaction entirely. Filtering tombstones
-- before picking the latest version would resurrect the superseded row.
insert into public.normalized_source_records
  (raw_event_id, household_id, account_id, provider_transaction_id, amount_minor,
   currency, effective_date, description, pending, kind, created_at)
values
  ('d4000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a401', 'ptx-sub-3', -1299, 'USD', '2026-06-12',
   'QUILLSTACK NOTES', false, 'removed', now() + interval '1 day');
select lives_ok(
  $$select public.keel_recurring_ingest_plaid_series('00000000-0000-4000-8000-00000000a001')$$,
  'the pass runs after a tombstone lands');
select is(
  (select skip_reason from public.plaid_recurring_streams where stream_id = 'stream-second-plan'),
  'insufficient_history',
  'a tombstoned transaction stops counting toward the three-occurrence gate');

select * from finish();
rollback;
