-- Stage 1D recurring: immutable derivations, suggest/approve, scope and ACLs.
begin;
select no_plan();

select has_table('public', 'recurring_detector_runs', 'immutable detector runs exist');
select has_table('public', 'recurring_candidate_versions', 'immutable candidate versions exist');
select has_table('public', 'recurring_series', 'logical recurring series exist');
select has_table('public', 'recurring_occurrences', 'canonical recurring occurrences exist');
select has_table('public', 'recurring_status_events', 'append-only status timeline exists');
select has_column('public', 'recurring_detector_runs', 'candidate_snapshot_hash',
  'detector run binds the exact ordered candidate snapshot');

select ok((select column_default is null from information_schema.columns
  where table_schema='public' and table_name='recurring_series' and column_name='status'),
  'series status has no implicit default');
select ok((select column_default is null from information_schema.columns
  where table_schema='public' and table_name='recurring_status_events' and column_name='transition'),
  'status transition has no implicit default');
select ok((select column_default is null from information_schema.columns
  where table_schema='public' and table_name='recurring_occurrences' and column_name='status'),
  'occurrence status has no implicit default');

select has_function('public', 'keel_recurring_read_txns', array['uuid'], 'worker read proc exists');
select has_function('public', 'keel_recurring_upsert_candidates',
  array['uuid','text','timestamp with time zone','text','text','text','jsonb'],
  'worker suggestion proc exists');
select has_function('public', 'keel_recurring_confirm', array['uuid','text','jsonb','uuid','jsonb'], 'confirm command exists');
select has_function('public', 'keel_recurring_pause', array['uuid','text','jsonb','uuid','jsonb'], 'pause command exists');
select has_function('public', 'keel_recurring_resume', array['uuid','text','jsonb','uuid','jsonb'], 'resume command exists');
select has_function('public', 'keel_recurring_cancel', array['uuid','text','jsonb','uuid','jsonb'], 'cancel command exists');
select has_function('public', 'keel_recurring_reject', array['uuid','text','jsonb','uuid','jsonb'], 'reject command exists');
select has_function('public', 'keel_list_recurring', array['uuid'], 'account-scoped recurring read exists');

select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_recurring_read_txns(uuid)'::regprocedure),
  'keel_worker', 'read proc is owned by keel_worker');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb)'::regprocedure),
  'keel_api', 'confirm proc is owned by keel_api');

select ok(not has_function_privilege('authenticated', 'public.keel_recurring_read_txns(uuid)', 'EXECUTE'),
  'authenticated cannot call worker ledger read');
select ok(has_function_privilege('service_role', 'public.keel_recurring_read_txns(uuid)', 'EXECUTE'),
  'service role can call worker ledger read');
select ok(has_function_privilege('authenticated', 'public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb)', 'EXECUTE'),
  'authenticated can call confirm command');
select ok(not has_function_privilege('anon', 'public.keel_recurring_confirm(uuid,text,jsonb,uuid,jsonb)', 'EXECUTE'),
  'anon cannot call confirm command');

-- Ledger read fixture: three posted evidence transactions and one pending row.
insert into public.canonical_transactions
  (id,household_id,entity_id,account_id,status,source,description,effective_date,economic_event_key)
values
  ('9a000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','manual','Recurring pgTAP rent','2026-03-31','pgtap:recurring:posted:1'),
  ('9a000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'pending','manual','Pending must stay out','2026-04-01','pgtap:recurring:pending:1'),
  ('9a000000-0000-4000-8000-000000000041','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','manual','Recurring pgTAP rent','2026-04-30','pgtap:recurring:posted:2'),
  ('9a000000-0000-4000-8000-000000000042','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','manual','Recurring pgTAP rent','2026-06-30','pgtap:recurring:posted:3');
insert into public.journal_batches
  (id,household_id,canonical_transaction_id,description,effective_date,command_id)
values
  ('9a000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a001',
   '9a000000-0000-4000-8000-000000000001','posted','2026-03-31','9a000000-0000-4000-8000-000000000021'),
  ('9a000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-00000000a001',
   '9a000000-0000-4000-8000-000000000002','pending','2026-04-01','9a000000-0000-4000-8000-000000000022'),
  ('9a000000-0000-4000-8000-000000000051','00000000-0000-4000-8000-00000000a001',
   '9a000000-0000-4000-8000-000000000041','posted','2026-04-30','9a000000-0000-4000-8000-000000000023'),
  ('9a000000-0000-4000-8000-000000000052','00000000-0000-4000-8000-00000000a001',
   '9a000000-0000-4000-8000-000000000042','posted','2026-06-30','9a000000-0000-4000-8000-000000000024');
insert into public.journal_postings
  (id,batch_id,ledger_account_id,entity_id,amount_minor,currency)
values
  ('9a000000-0000-4000-8000-000000000031','9a000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-250000,'USD'),
  ('9a000000-0000-4000-8000-000000000032','9a000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-00000000a313','00000000-0000-4000-8000-00000000a101',250000,'USD'),
  ('9a000000-0000-4000-8000-000000000033','9a000000-0000-4000-8000-000000000012',
   '00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-1,'USD'),
  ('9a000000-0000-4000-8000-000000000034','9a000000-0000-4000-8000-000000000012',
   '00000000-0000-4000-8000-00000000a313','00000000-0000-4000-8000-00000000a101',1,'USD'),
  ('9a000000-0000-4000-8000-000000000061','9a000000-0000-4000-8000-000000000051',
   '00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-250000,'USD'),
  ('9a000000-0000-4000-8000-000000000063','9a000000-0000-4000-8000-000000000051',
   '00000000-0000-4000-8000-00000000a313','00000000-0000-4000-8000-00000000a101',250000,'USD'),
  ('9a000000-0000-4000-8000-000000000062','9a000000-0000-4000-8000-000000000052',
   '00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-250000,'USD'),
  ('9a000000-0000-4000-8000-000000000064','9a000000-0000-4000-8000-000000000052',
   '00000000-0000-4000-8000-00000000a313','00000000-0000-4000-8000-00000000a101',250000,'USD');

set local role service_role;
select is((select jsonb_build_array(
  count(*) filter (where row->>'txnId'='9a000000-0000-4000-8000-000000000001'),
  count(*) filter (where row->>'txnId'='9a000000-0000-4000-8000-000000000002'))
  from jsonb_array_elements(public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) row),
  '[1,0]'::jsonb, 'worker read includes posted/reviewed and excludes pending fixture');
select is((select row->>'amountMinor' from jsonb_array_elements(
  public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) row
  where row->>'txnId'='9a000000-0000-4000-8000-000000000001'),
  '-250000', 'worker read returns exact amount as JSON string');
select is((select row->>'postingId' from jsonb_array_elements(
  public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) row
  where row->>'txnId'='9a000000-0000-4000-8000-000000000001'),
  '9a000000-0000-4000-8000-000000000031', 'worker read carries live posting evidence id');
reset role;

-- Immutable candidate version inserted by the service-only suggest proc.
set local role service_role;
select lives_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:run:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array(jsonb_build_object(
      'seriesKey','pgtap-recurring-rent','counterpartyKey','monthly rent',
      'accountId','00000000-0000-4000-8000-00000000a401',
      'ledgerAccountId','00000000-0000-4000-8000-00000000a301',
      'currency','USD','sign','outflow','cadence','monthly',
      'cadenceAnchor',jsonb_build_object('kind','day_of_month','day',31,'intervalMonths',1,'phase',0),
      'amountKind','fixed','representativeAmountMinor','-250000',
      'amountSummary',jsonb_build_object('minMinor','-250000','maxMinor','-250000','lowerMedianMinor','-250000','squaredResidualSum','0','count',3),
      'lastSeen','2026-06-30','occurrenceCount',3,
      'coverage',jsonb_build_object('matchedSlots',3,'totalSlots',3),
      'residualDays',0,'scoreBps',9750,
      'evidence',jsonb_build_array(
        jsonb_build_object('txnId','9a000000-0000-4000-8000-000000000001','batchId','9a000000-0000-4000-8000-000000000011','postingId','9a000000-0000-4000-8000-000000000031'),
        jsonb_build_object('txnId','9a000000-0000-4000-8000-000000000041','batchId','9a000000-0000-4000-8000-000000000051','postingId','9a000000-0000-4000-8000-000000000061'),
        jsonb_build_object('txnId','9a000000-0000-4000-8000-000000000042','batchId','9a000000-0000-4000-8000-000000000052','postingId','9a000000-0000-4000-8000-000000000062')),
      'inputFingerprint','aaaaaaaaaaaaaaaa','detectorVersion','recurring-grid-v1',
      'confidenceVersion','recurring-score-bps-v1','normalizerVersion','counterparty-v1',
      'asOf','2026-07-12','requiresApproval',true)))
$$, 'worker inserts suggestion candidate');
reset role;

select is((select status::text from public.recurring_series where series_key='pgtap-recurring-rent'),
  'suggested', 'detection explicitly inserts suggested status');
select is((select count(*)::int from public.recurring_occurrences), 0,
  'suggestion persists no forecast occurrences');
select is((select jsonb_array_length(evidence) from public.recurring_candidate_versions limit 1),
  3, 'candidate stores immutable evidence ids');
select is((select count(*)::int from public.audit_log where action='recurring.suggested'
  and object_id=(select id from public.recurring_series where series_key='pgtap-recurring-rent')),
  1, 'new candidate suggestion is audited once');

set local role service_role;
select lives_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:run:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate from public.recurring_candidate_versions limit 1)))
$$, 'same detector run/candidate replays idempotently');
reset role;
select is((select count(*)::int from public.recurring_candidate_versions), 1,
  'detector replay does not duplicate candidate version');
select is((select count(*)::int from public.audit_log where action='recurring.suggested'
  and object_id=(select id from public.recurring_series where series_key='pgtap-recurring-rent')),
  1, 'detector replay does not duplicate suggestion audit');

set local role service_role;
select throws_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:run:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate || jsonb_build_object('scoreBps',9749)
      from public.recurring_candidate_versions limit 1)))
$$, 'P0007', null, 'same run key rejects a changed ordered candidate snapshot');
reset role;

set local role service_role;
select throws_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:hash-conflict:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate || jsonb_build_object('scoreBps',9749)
      from public.recurring_candidate_versions limit 1)))
$$, 'P0007', null, 'same fingerprint rejects a different full candidate hash');
reset role;

set local role service_role;
select throws_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:forged-evidence:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate || jsonb_build_object(
      'seriesKey','forged-evidence',
      'inputFingerprint','eeeeeeeeeeeeeeee',
      'evidence',jsonb_build_array(
        jsonb_build_object('txnId','9a000000-0000-4000-8000-000000000001','batchId','9a000000-0000-4000-8000-000000000011','postingId','9a000000-0000-4000-8000-000000000031'),
        jsonb_build_object('txnId','9a000000-0000-4000-8000-000000000041','batchId','9a000000-0000-4000-8000-000000000051','postingId','9a000000-0000-4000-8000-000000000061'),
        jsonb_build_object('txnId','ffffffff-ffff-4fff-8fff-ffffffffffff','batchId','ffffffff-ffff-4fff-8fff-ffffffffffff','postingId','ffffffff-ffff-4fff-8fff-ffffffffffff')))
      from public.recurring_candidate_versions limit 1)))
$$, 'P0006', null, 'candidate evidence must resolve through tenant-owned live ledger rows');
reset role;

set local role service_role;
select throws_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000b001','pgtap:recurring:smuggle:1',
    '2026-07-12T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate || jsonb_build_object('seriesKey','smuggled')
      from public.recurring_candidate_versions limit 1)))
$$, 'P0006', null, 'worker suggestion rejects cross-tenant account smuggling');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.keel_list_recurring('00000000-0000-4000-8000-00000000a001')->'rows'),
  1, 'authorized account owner can list recurring candidate');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(jsonb_array_length(public.keel_list_recurring('00000000-0000-4000-8000-00000000b001')->'rows'),
  0, 'different household sees no recurring candidate');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($outer$
  do $body$
  begin
    perform public.keel_recurring_confirm(
      '9a000000-0000-4000-8000-000000000070','pgtap:recurring:confirm:forged','{}',
      '00000000-0000-4000-8000-00000000a001',
      jsonb_build_object(
        'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
        'candidate_version_hash',(select candidate_hash from public.recurring_candidate_versions limit 1),
        'effective_date','2026-07-12','horizon_days',120,
        'occurrences',jsonb_build_array(jsonb_build_object(
          'occurrence_key','bbbbbbbbbbbbbbbb','expected_date','2099-12-31',
          'expected_amount_minor','999999999','currency','EUR','amount_kind','variable',
          'status','expected','score_bps',1,
          'evidence',(select jsonb_agg(jsonb_build_object(
            'txn_id',e->>'txnId','batch_id',e->>'batchId','posting_id',e->>'postingId') order by n)
            from public.recurring_candidate_versions c,
            jsonb_array_elements(c.evidence) with ordinality as evidence(e,n)),
          'input_fingerprint','cccccccccccccccc','detector_version','recurring-grid-v1',
          'confidence_version','recurring-score-bps-v1','as_of','2099-12-31T00:00:00Z',
          'series_key','pgtap-recurring-rent',
          'candidate_version_hash',(select candidate_hash from public.recurring_candidate_versions limit 1))))
    );
    raise exception 'FORGED_OCCURRENCE_ACCEPTED' using errcode = 'P0099';
  end
  $body$
$outer$, 'P0009', null, 'direct confirm rejects caller-supplied occurrence economics');

select lives_ok($$
  select public.keel_recurring_confirm(
    '9a000000-0000-4000-8000-000000000071','pgtap:recurring:confirm:1','{}',
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object(
      'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
      'effective_date','2026-07-12',
      'horizon_days',120)
  )
$$, 'authenticated owner confirms and SQL derives the locked candidate projection');
reset role;

select is((select status::text from public.recurring_series where series_key='pgtap-recurring-rent'),
  'confirmed', 'confirm advances user-owned status');
select is((select count(*)::int from public.recurring_occurrences), 4,
  'confirm derives the bounded monthly cadence in SQL');
select is((select string_agg(to_char(expected_date,'YYYY-MM-DD'),',' order by expected_date)
  from public.recurring_occurrences),
  '2026-07-31,2026-08-31,2026-09-30,2026-10-31',
  'SQL cadence clamps month-end dates with Gregorian civil rules');
select is((select expected_amount_minor::text from public.recurring_occurrences limit 1),
  '-250000', 'occurrence money remains exact bigint');
select is((select count(*)::int from public.recurring_status_events where transition='confirmed'),
  1, 'confirm appends status event');
select ok((select before is not null from public.audit_log where command_id='9a000000-0000-4000-8000-000000000071'),
  'confirm audit carries before state');
select ok((select after is not null from public.audit_log where command_id='9a000000-0000-4000-8000-000000000071'),
  'confirm audit carries after state');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.keel_recurring_pause(
  '9a000000-0000-4000-8000-000000000072','pgtap:recurring:pause:1','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-08-01'))$$, 'pause appends an effective lifecycle boundary');
select lives_ok($$select public.keel_recurring_resume(
  '9a000000-0000-4000-8000-000000000073','pgtap:recurring:resume:1','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-09-01','horizon_days',150))$$,
  'resume appends status and extends the SQL-derived projection horizon');
select throws_ok($$select public.keel_recurring_pause(
  '9a000000-0000-4000-8000-000000000074','pgtap:recurring:pause:retrograde','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-08-15'))$$, 'P0009', null,
  'effective dates must increase so materialized status matches timeline order');
select lives_ok($$select public.keel_recurring_cancel(
  '9a000000-0000-4000-8000-000000000075','pgtap:recurring:cancel:1','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-11-01'))$$, 'cancel terminates the series');
select throws_ok($$select public.keel_recurring_resume(
  '9a000000-0000-4000-8000-000000000076','pgtap:recurring:resume:cancelled','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-12-01','horizon_days',90))$$, 'P0009', null,
  'resume cannot revive a cancelled series');
select throws_ok($$select public.keel_recurring_confirm(
  '9a000000-0000-4000-8000-000000000077','pgtap:recurring:confirm:bad-date','{}',
  '00000000-0000-4000-8000-00000000a001',jsonb_build_object(
    'series_id',(select id from public.recurring_series where series_key='pgtap-recurring-rent'),
    'effective_date','2026-99-99','horizon_days',90))$$, 'P0009', null,
  'residual database civil-date failures map to invalid_command');
select is((select status::text from public.recurring_series where series_key='pgtap-recurring-rent'),
  'cancelled', 'failed retrograde/resume commands do not contradict materialized status');
select is((select count(*)::int from public.recurring_occurrences), 6,
  'resume appends newly in-horizon immutable occurrence derivations');
select is((select jsonb_path_query_array(public.keel_list_recurring(
  '00000000-0000-4000-8000-00000000a001'), '$.rows[0].occurrences[*].status')),
  '["expected","paused","expected","expected","cancelled","cancelled"]'::jsonb,
  'list derives expected/paused/cancelled state from the effective timeline');
reset role;

set local role service_role;
select lives_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:recurring:run:2',
    '2026-07-13T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array((select candidate || jsonb_build_object(
      'inputFingerprint','dddddddddddddddd','asOf','2026-07-13',
      'internalCanary','must-not-pass-through')
      from public.recurring_candidate_versions order by created_at limit 1)))
$$, 'later detector run may append a candidate version');
reset role;
select is((select candidate.input_fingerprint from public.recurring_series series_row
  join public.recurring_candidate_versions candidate
    on candidate.household_id=series_row.household_id and candidate.id=series_row.current_candidate_version_id
  where series_row.series_key='pgtap-recurring-rent'),
  'aaaaaaaaaaaaaaaa', 'detector never resets confirmed series locked candidate');

update public.recurring_series series_row
   set current_candidate_version_id = candidate_row.id
  from public.recurring_candidate_versions candidate_row
 where candidate_row.household_id = series_row.household_id
   and candidate_row.series_id = series_row.id
   and candidate_row.input_fingerprint = 'dddddddddddddddd';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(jsonb_array_length(public.keel_list_recurring(
  '00000000-0000-4000-8000-00000000a001')->'rows'->0->'occurrences'), 0,
  'list never mixes occurrences from a prior candidate generation');
select ok(not (public.keel_list_recurring(
  '00000000-0000-4000-8000-00000000a001')->'rows'->0 ? 'internalCanary'),
  'list emits an explicit DTO instead of candidate JSON passthrough');
reset role;

select ok(position('on conflict (household_id, series_key) do nothing' in lower(
  pg_get_functiondef('public.keel_recurring_upsert_candidates(uuid,text,timestamptz,text,text,text,jsonb)'::regprocedure)
)) > 0, 'new-series creation uses insert-on-conflict before row locking');

select throws_ok($$update public.recurring_candidate_versions set score_bps=1$$,
  'P0001', null, 'candidate derivation is immutable');
select throws_ok($$delete from public.recurring_status_events$$,
  'P0001', null, 'status-event timeline is append-only');
select is((select count(*)::int from pg_constraint where conname in (
  'fk_recurring_series_account_tenant','fk_recurring_series_ledger_account_tenant',
  'fk_recurring_occurrence_series_tenant','fk_recurring_occurrence_candidate_tenant',
  'fk_recurring_occurrence_matched_txn_tenant')),
  5, 'series/ledger/occurrence/matched transaction use composite tenant FKs');

select * from finish();
rollback;
