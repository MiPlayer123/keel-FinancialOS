-- refine(recurring) 20260719030000 + 20260719031000: the recurring-detection
-- READER excludes transfers (both directions) and unclassified inflows by their
-- EFFECTIVE category, keeping payroll and real subscriptions; and a detection run
-- REAPS the stale 'suggested' series it no longer produces (marking them
-- 'withdrawn'), without touching confirmed/rejected. Deterministic (Law 1).
begin;
select no_plan();

-- The enum gained a terminal 'withdrawn' status + transition.
select ok('withdrawn' = any(enum_range(null::public.recurring_series_status)::text[]),
  'recurring_series_status gained withdrawn');
select ok('withdrawn' = any(enum_range(null::public.recurring_transition)::text[]),
  'recurring_transition gained withdrawn');
select has_function('public', 'keel_recurring_reap_stale_suggestions',
  array['uuid','uuid','uuid[]','boolean'], 'reap proc exists');
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_recurring_reap_stale_suggestions(uuid,uuid,uuid[],boolean)'::regprocedure),
  'keel_api', 'reap proc is keel_api-owned definer (can flip series status)');
select ok(has_function_privilege('service_role',
  'public.keel_recurring_reap_stale_suggestions(uuid,uuid,uuid[],boolean)', 'EXECUTE'),
  'service role (worker admin client) can call the reap');
select ok(not has_function_privilege('authenticated',
  'public.keel_recurring_reap_stale_suggestions(uuid,uuid,uuid[],boolean)', 'EXECUTE'),
  'authenticated cannot call the reap directly');

-- ---------------------------------------------------------------------------
-- Category fixtures for the alpha entity (a101): the seed has Uncategorized
-- Income (a318) only; add income-kind Income, Other Income, Transfers In and
-- expense-kind Transfers so the effective-category predicate has real targets.
-- ---------------------------------------------------------------------------
insert into public.ledger_accounts
  (id, household_id, entity_id, name, kind, currency, is_category, pfc_key, is_system)
values
  ('d3000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Income', 'income', 'USD', true, 'income', true),
  ('d3000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Other Income', 'income', 'USD', true, 'other_income', true),
  ('d3000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers In', 'income', 'USD', true, 'transfers_in', true),
  ('d3000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Transfers', 'expense', 'USD', true, 'transfers', true),
  ('d3000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', 'Subscriptions', 'expense', 'USD', true, 'entertainment', true);

-- ---------------------------------------------------------------------------
-- Five transactions on the alpha checking account (a401 / ledger a301):
--   T1 payroll INFLOW,           offset category income            → KEPT
--   T2 real outflow subscription, offset category entertainment     → KEPT
--   T3 person-name Venmo INFLOW,  offset category other_income      → DROPPED
--   T4 transfer-in INFLOW,        overlay category transfers_in     → DROPPED
--   T5 transfer-out OUTFLOW,      offset category transfers         → DROPPED
-- Each is a single-real-account posting (checking leg + one category leg).
-- ---------------------------------------------------------------------------
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
values
  ('d3000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','sync','ACME PAYROLL PPD','2026-06-01','pgtap:reap:t1'),
  ('d3000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','sync','SomeStreamer Music','2026-06-02','pgtap:reap:t2'),
  ('d3000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','sync','Jordan P Rivera','2026-06-03','pgtap:reap:t3'),
  ('d3000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','sync','ELECTRONIC PAYMENT RECEIVED','2026-06-04','pgtap:reap:t4'),
  ('d3000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a401',
   'posted','sync','Zelle payment to Jordan','2026-06-05','pgtap:reap:t5');

insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d3000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000101','p','2026-06-01','d3000000-0000-4000-8000-000000000301'),
  ('d3000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000102','p','2026-06-02','d3000000-0000-4000-8000-000000000302'),
  ('d3000000-0000-4000-8000-000000000203','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000103','p','2026-06-03','d3000000-0000-4000-8000-000000000303'),
  ('d3000000-0000-4000-8000-000000000204','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000104','p','2026-06-04','d3000000-0000-4000-8000-000000000304'),
  ('d3000000-0000-4000-8000-000000000205','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000105','p','2026-06-05','d3000000-0000-4000-8000-000000000305');

-- Postings: checking leg (a301) + one category leg each. Signs by convention:
-- inflow → +cash / -income; outflow → -cash / +expense.
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  -- T1 payroll inflow +2000 → income offset
  ('d3000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101', 200000,'USD'),
  ('d3000000-0000-4000-8000-000000000201','d3000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-00000000a101',-200000,'USD'),
  -- T2 subscription outflow -1000 → entertainment offset
  ('d3000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',-100000,'USD'),
  ('d3000000-0000-4000-8000-000000000202','d3000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-00000000a101', 100000,'USD'),
  -- T3 person-name Venmo inflow +500 → other_income offset
  ('d3000000-0000-4000-8000-000000000203','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',  50000,'USD'),
  ('d3000000-0000-4000-8000-000000000203','d3000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a101', -50000,'USD'),
  -- T4 transfer-in inflow +750 → offset is Other Income, but OVERLAY (below) is Transfers In
  ('d3000000-0000-4000-8000-000000000204','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',  75000,'USD'),
  ('d3000000-0000-4000-8000-000000000204','d3000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-00000000a101', -75000,'USD'),
  -- T5 transfer-out outflow -300 → transfers offset
  ('d3000000-0000-4000-8000-000000000205','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101', -30000,'USD'),
  ('d3000000-0000-4000-8000-000000000205','d3000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-00000000a101',  30000,'USD');

-- T4: an OVERLAY sets the effective category to Transfers In (the offset posting
-- is Other Income; overlay must win — this proves overlay-first resolution).
insert into public.transaction_categories
  (canonical_transaction_id, household_id, category_ledger_account_id, source)
values
  ('d3000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-00000000a001',
   'd3000000-0000-4000-8000-000000000012','user');

set local role service_role;
-- KEEP: payroll (income) and subscription (entertainment) reach the detector.
select is(
  (select count(*)::int from jsonb_array_elements(
     public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) r
   where r->>'txnId' in ('d3000000-0000-4000-8000-000000000101','d3000000-0000-4000-8000-000000000102')),
  2, 'payroll (income) and real subscription (entertainment) are KEPT for detection');
-- DROP: person-name Venmo (other_income), transfer-in overlay (transfers_in),
-- transfer-out (transfers) are all excluded.
select is(
  (select count(*)::int from jsonb_array_elements(
     public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) r
   where r->>'txnId' in ('d3000000-0000-4000-8000-000000000103',
                         'd3000000-0000-4000-8000-000000000104',
                         'd3000000-0000-4000-8000-000000000105')),
  0, 'other_income Venmo + transfers_in overlay + transfers outflow are all EXCLUDED');
-- Specifically: the overlay (transfers_in) wins over the other_income offset.
select ok(
  not exists (select 1 from jsonb_array_elements(
     public.keel_recurring_read_txns('00000000-0000-4000-8000-00000000a001')) r
   where r->>'txnId'='d3000000-0000-4000-8000-000000000104'),
  'overlay transfers_in wins over the other_income offset — T4 excluded');
reset role;

-- ---------------------------------------------------------------------------
-- REAP. Build a detector run with THREE suggested series (via three real
-- monthly-rent-shaped fixtures), then run a NEW run that emits only ONE of them
-- and reap the other two. Also seed a confirmed and a rejected series that must
-- survive the reap untouched.
-- Reuse the payroll KEEP txns as evidence is overkill; instead craft three
-- 3-occurrence outflow series on account a401 the way test 009 does.
-- ---------------------------------------------------------------------------
-- Nine posted outflow txns (three series × three months) on a301, offset Rent
-- (a313, expense). Each single-real-account.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description, effective_date, economic_event_key)
select ('d3000000-0000-4000-8000-0000004' || lpad(s::text,5,'0'))::uuid,
       '00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-00000000a101',
       '00000000-0000-4000-8000-00000000a401','posted','manual',
       'Reap series ' || (s/3) , dt, 'pgtap:reap:series:' || s
from (values
  (0,'2026-03-10'::date),(1,'2026-04-10'),(2,'2026-05-10'),
  (3,'2026-03-11'),(4,'2026-04-11'),(5,'2026-05-11'),
  (6,'2026-03-12'),(7,'2026-04-12'),(8,'2026-05-12')
) v(s,dt);
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
select ('d3000000-0000-4000-8000-0000005' || lpad(s::text,5,'0'))::uuid,
       '00000000-0000-4000-8000-00000000a001',
       ('d3000000-0000-4000-8000-0000004' || lpad(s::text,5,'0'))::uuid,
       'p', dt, ('d3000000-0000-4000-8000-0000006' || lpad(s::text,5,'0'))::uuid
from (values
  (0,'2026-03-10'::date),(1,'2026-04-10'),(2,'2026-05-10'),
  (3,'2026-03-11'),(4,'2026-04-11'),(5,'2026-05-11'),
  (6,'2026-03-12'),(7,'2026-04-12'),(8,'2026-05-12')
) v(s,dt);
insert into public.journal_postings (id, batch_id, ledger_account_id, entity_id, amount_minor, currency)
select ('d3000000-0000-4000-8000-0000007' || lpad(s::text,5,'0'))::uuid,
       ('d3000000-0000-4000-8000-0000005' || lpad(s::text,5,'0'))::uuid,
       '00000000-0000-4000-8000-00000000a301'::uuid,'00000000-0000-4000-8000-00000000a101'::uuid,-90000,'USD'
from generate_series(0,8) s
union all
select ('d3000000-0000-4000-8000-0000008' || lpad(s::text,5,'0'))::uuid,
       ('d3000000-0000-4000-8000-0000005' || lpad(s::text,5,'0'))::uuid,
       '00000000-0000-4000-8000-00000000a313','00000000-0000-4000-8000-00000000a101', 90000,'USD'
from generate_series(0,8) s;

-- Helper to build one candidate jsonb for series #k (evidence = its 3 txns).
-- We upsert all three in run:A (all become 'suggested'), then run:B emits only
-- series #0, and reap withdraws #1 and #2.
set local role service_role;
select lives_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:reap:runA',
    '2026-07-19T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    (select jsonb_agg(cand) from (
      select jsonb_build_object(
        'seriesKey','reap-series-'||k,'counterpartyKey','reap series '||k,
        'accountId','00000000-0000-4000-8000-00000000a401',
        'ledgerAccountId','00000000-0000-4000-8000-00000000a301',
        'currency','USD','sign','outflow','cadence','monthly',
        'cadenceAnchor',jsonb_build_object('kind','day_of_month','day',10+k,'intervalMonths',1,'phase',0),
        'amountKind','fixed','representativeAmountMinor','-90000',
        'amountSummary',jsonb_build_object('minMinor','-90000','maxMinor','-90000','lowerMedianMinor','-90000','squaredResidualSum','0','count',3),
        'lastSeen','2026-05-1'||k,'occurrenceCount',3,
        'coverage',jsonb_build_object('matchedSlots',3,'totalSlots',3),
        'residualDays',0,'scoreBps',9700,
        'evidence',jsonb_build_array(
          jsonb_build_object('txnId',('d3000000-0000-4000-8000-0000004'||lpad((k*3+0)::text,5,'0'))::uuid,'batchId',('d3000000-0000-4000-8000-0000005'||lpad((k*3+0)::text,5,'0'))::uuid,'postingId',('d3000000-0000-4000-8000-0000007'||lpad((k*3+0)::text,5,'0'))::uuid),
          jsonb_build_object('txnId',('d3000000-0000-4000-8000-0000004'||lpad((k*3+1)::text,5,'0'))::uuid,'batchId',('d3000000-0000-4000-8000-0000005'||lpad((k*3+1)::text,5,'0'))::uuid,'postingId',('d3000000-0000-4000-8000-0000007'||lpad((k*3+1)::text,5,'0'))::uuid),
          jsonb_build_object('txnId',('d3000000-0000-4000-8000-0000004'||lpad((k*3+2)::text,5,'0'))::uuid,'batchId',('d3000000-0000-4000-8000-0000005'||lpad((k*3+2)::text,5,'0'))::uuid,'postingId',('d3000000-0000-4000-8000-0000007'||lpad((k*3+2)::text,5,'0'))::uuid)),
        'inputFingerprint',lpad(''||k,16,'a'),'detectorVersion','recurring-grid-v1',
        'confidenceVersion','recurring-score-bps-v1','normalizerVersion','counterparty-v1',
        'asOf','2026-07-19','requiresApproval',true) as cand
      from generate_series(0,2) k
    ) c)
  )
$$, 'run A upserts three suggested series');
reset role;

select is((select count(*)::int from public.recurring_series where series_key like 'reap-series-%' and status='suggested'),
  3, 'all three reap series start suggested');

-- Confirm series #0 (so it is protected) — via authorized owner command.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  select public.keel_recurring_confirm(
    'd3000000-0000-4000-8000-00000009000f','pgtap:reap:confirm0','{}',
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('series_id',(select id from public.recurring_series where series_key='reap-series-0'),
      'effective_date','2026-07-19','horizon_days',60))
$$, 'confirm reap-series-0 so the reap must leave it alone');
-- Reject series #1 (so it is protected too) — via authorized owner command.
select lives_ok($$
  select public.keel_recurring_reject(
    'd3000000-0000-4000-8000-00000009001f','pgtap:reap:reject1','{}',
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('series_id',(select id from public.recurring_series where series_key='reap-series-1'),
      'effective_date','2026-07-19'))
$$, 'reject reap-series-1 so the reap must leave it alone');
reset role;

-- Now series-2 is the only one still 'suggested'. Run the reap for a genuine
-- detection that re-emitted series #0 and #1 but NOT #2 → series-2 must be
-- withdrawn; the confirmed (#0) and rejected (#1) must survive. (The reap
-- guard, 20260719082000, refuses to reap on an EMPTY emitted set — an empty
-- detection is not proof every prior suggestion is stale — so the emitted set
-- must be the non-empty survivor list, exactly as a real detection produces.)
set local role service_role;
select is(
  public.keel_recurring_reap_stale_suggestions(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.recurring_detector_runs where run_key='pgtap:reap:runA'),
    array[(select id from public.recurring_series where series_key='reap-series-0'),
          (select id from public.recurring_series where series_key='reap-series-1')]::uuid[], true),
  1, 'reap withdraws exactly the one still-suggested, not-emitted series');
reset role;

select is((select status::text from public.recurring_series where series_key='reap-series-2'),
  'withdrawn', 'the stale suggested series is now withdrawn');
select is((select status::text from public.recurring_series where series_key='reap-series-0'),
  'confirmed', 'confirmed series is untouched by the reap');
select is((select status::text from public.recurring_series where series_key='reap-series-1'),
  'rejected', 'rejected series is untouched by the reap');
select is((select count(*)::int from public.recurring_status_events se
  join public.recurring_series s on s.id=se.series_id
  where s.series_key='reap-series-2' and se.transition='withdrawn'),
  1, 'reap appends exactly one withdrawn status event');
select is((select count(*)::int from public.audit_log
  where action='recurring.withdrawn'
    and object_id=(select id from public.recurring_series where series_key='reap-series-2')),
  1, 'reap audits the withdrawal once');

-- Idempotent: re-running the same reap withdraws nothing more and adds no events.
set local role service_role;
select is(
  public.keel_recurring_reap_stale_suggestions(
    '00000000-0000-4000-8000-00000000a001',
    (select id from public.recurring_detector_runs where run_key='pgtap:reap:runA'),
    array[(select id from public.recurring_series where series_key='reap-series-0'),
          (select id from public.recurring_series where series_key='reap-series-1')]::uuid[], true),
  0, 'reap is idempotent — a second pass withdraws nothing');
reset role;
select is((select count(*)::int from public.recurring_status_events se
  join public.recurring_series s on s.id=se.series_id
  where s.series_key='reap-series-2' and se.transition='withdrawn'),
  1, 'idempotent reap does not duplicate the withdrawn status event');

-- 20260813150000: keel_list_recurring RETURNS the withdrawn series (status
-- 'withdrawn') so the client can offer Restore — the earlier hide-it filter
-- (20260719031000) made reaped series silently unrecoverable from the UI.
-- Consumers are status-driven, so a withdrawn row only surfaces in the
-- dedicated Stopped lane.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select r->>'status' from jsonb_array_elements(
     public.keel_list_recurring('00000000-0000-4000-8000-00000000a001')->'rows') r
   where r->>'seriesKey'='reap-series-2'),
  'withdrawn',
  'withdrawn series is listed to the client with status withdrawn (restorable)');
select ok(
  exists (select 1 from jsonb_array_elements(
     public.keel_list_recurring('00000000-0000-4000-8000-00000000a001')->'rows') r
   where r->>'seriesKey'='reap-series-0'),
  'confirmed series is still listed');
reset role;

-- A later run that RE-DETECTS the withdrawn series flips it back to suggested
-- (re-suggestion path). Emit series-2 again in run B.
set local role service_role;
select lives_ok($$
  select public.keel_recurring_upsert_candidates(
    '00000000-0000-4000-8000-00000000a001','pgtap:reap:runB',
    '2026-07-20T12:00:00Z','recurring-grid-v1','recurring-score-bps-v1','counterparty-v1',
    jsonb_build_array(jsonb_build_object(
      'seriesKey','reap-series-2','counterpartyKey','reap series 2',
      'accountId','00000000-0000-4000-8000-00000000a401',
      'ledgerAccountId','00000000-0000-4000-8000-00000000a301',
      'currency','USD','sign','outflow','cadence','monthly',
      'cadenceAnchor',jsonb_build_object('kind','day_of_month','day',12,'intervalMonths',1,'phase',0),
      'amountKind','fixed','representativeAmountMinor','-90000',
      'amountSummary',jsonb_build_object('minMinor','-90000','maxMinor','-90000','lowerMedianMinor','-90000','squaredResidualSum','0','count',3),
      'lastSeen','2026-05-12','occurrenceCount',3,
      'coverage',jsonb_build_object('matchedSlots',3,'totalSlots',3),
      'residualDays',0,'scoreBps',9700,
      'evidence',jsonb_build_array(
        jsonb_build_object('txnId','d3000000-0000-4000-8000-000000400006','batchId','d3000000-0000-4000-8000-000000500006','postingId','d3000000-0000-4000-8000-000000700006'),
        jsonb_build_object('txnId','d3000000-0000-4000-8000-000000400007','batchId','d3000000-0000-4000-8000-000000500007','postingId','d3000000-0000-4000-8000-000000700007'),
        jsonb_build_object('txnId','d3000000-0000-4000-8000-000000400008','batchId','d3000000-0000-4000-8000-000000500008','postingId','d3000000-0000-4000-8000-000000700008')),
      'inputFingerprint','bbbbbbbbbbbbbbbb','detectorVersion','recurring-grid-v1',
      'confidenceVersion','recurring-score-bps-v1','normalizerVersion','counterparty-v1',
      'asOf','2026-07-20','requiresApproval',true)))
$$, 'run B re-detects the withdrawn series');
reset role;
select is((select status::text from public.recurring_series where series_key='reap-series-2'),
  'suggested', 'a withdrawn series is re-suggested when a later run detects it again');

select * from finish();
rollback;
