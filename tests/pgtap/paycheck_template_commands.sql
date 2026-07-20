-- pgTAP for paycheck split templates SLICE C — the two authoring commands
-- (docs/harness/plans/paycheck-split-templates-v2.md §2 migration 181000[renumbered],
--  §D2/§D3, §7 stage C). Runner: scripts/run-paycheck-template-commands-pgtap.sh
-- builds the minimal REAL base schema (envelope helpers + audit/command tables +
-- the Slice-B table body) and injects THIS slice's migration at the marker.
--
-- Proves: save authors a new version + lines; ΣP≥10000 rejected at SAVE;
-- destination-must-be-manual-asset rejected; category-must-be-same-entity
-- rejected; exactly-one-remainder (=1, not just ≤1); set_series_settings is
-- OWNER-required (partner rejected, owner OK); auto_with_log-requires-template;
-- audit before/after grant row; idempotent replay; tenant isolation.

begin;
select plan(24);

-- __SLICE_B_BODY__ (runner replaces with 20260721180000_paycheck_split_templates.sql)
-- __SLICE_C_BODY__ (runner replaces with 20260722200000_paycheck_template_commands.sql)

-- ---- Fixtures -------------------------------------------------------------
-- Two households (a = the tenant under test with an owner AND a partner; b = the
-- isolation foil). Two entities in a to prove same-entity scoping.
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),   -- owner of a
  ('00000000-0000-4000-8000-000000000002'),   -- partner of a
  ('00000000-0000-4000-8000-000000000009');   -- owner of b

insert into public.households(id) values
  ('00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b001');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000002','partner'),
  ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-000000000009','owner');

insert into public.entities(household_id,id,name) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e7101','Personal'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e7102','Business');

-- Categories (is_category=true). Fed tax is Personal; a Business-entity tax used
-- to prove cross-entity rejection.
insert into public.ledger_accounts(household_id,id,entity_id,name,kind,is_category,archived_at) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ca001','00000000-0000-4000-8000-0000000e7101','Federal Tax','expense',true,null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ca002','00000000-0000-4000-8000-0000000e7102','Biz Tax','expense',true,null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ca003','00000000-0000-4000-8000-0000000e7101','Salary Income','income',true,null),
  -- Ledger accounts backing the manual asset destination + a connected one + a liability.
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000da001','00000000-0000-4000-8000-0000000e7101','401k asset','asset',false,null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000da002','00000000-0000-4000-8000-0000000e7101','Connected asset','asset',false,null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000da003','00000000-0000-4000-8000-0000000e7101','Credit card','liability',false,null);

-- Accounts. ac001 = manual asset (connection_id null) → valid destination.
-- ac002 = connected asset (connection_id set) → rejected (not manual).
-- ac003 = manual liability → rejected (not asset).
insert into public.accounts(household_id,id,entity_id,ledger_account_id,connection_id,name,archived_at) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ac001','00000000-0000-4000-8000-0000000e7101','00000000-0000-4000-8000-0000000da001',null,'401k',null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ac002','00000000-0000-4000-8000-0000000e7101','00000000-0000-4000-8000-0000000da002','00000000-0000-4000-8000-0000000cc001','Connected 401k',null),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ac003','00000000-0000-4000-8000-0000000e7101','00000000-0000-4000-8000-0000000da003',null,'Card',null);

insert into public.employers(household_id,id,name) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0001','Acme Fictional Co'),
  ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-0000000e00b1','Beta Fictional Co');
insert into public.recurring_series(household_id,id) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1'),
  ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-0000000501b1');

-- helper: authenticate as a given user by setting the JWT sub claim.
create or replace function pg_temp.as_user(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_uid, true);
$$;

-- ==== keel_assert_member_owner exists ======================================
select has_function('public','keel_assert_member_owner',array['uuid'],'keel_assert_member_owner created');
select has_function('public','keel_cmd_paycheck_save_template',array['uuid','text','jsonb','uuid','jsonb'],'save_template command created');
select has_function('public','keel_cmd_paycheck_set_series_settings',array['uuid','text','jsonb','uuid','jsonb'],'set_series_settings command created');

-- ==== SAVE (partner) authors a new version + lines =========================
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');  -- partner may save

select lives_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd01','paychecks.save_template:cmd01',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object(
    'series_id','00000000-0000-4000-8000-0000000501a1',
    'employer_id','00000000-0000-4000-8000-0000000e0001',
    'booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps',1500,'category_ledger_account_id','00000000-0000-4000-8000-0000000ca001','position',1),
      jsonb_build_object('line_key','k401','kind','retirement_401k','role','pretax_transfer','amount_kind','fixed_minor','amount_minor','5000','destination_account_id','00000000-0000-4000-8000-0000000ac001','position',2),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',3)
    )))$$, 'partner saves a valid template (v1)');

select is((select template_version from public.paycheck_templates
  where household_id='00000000-0000-4000-8000-00000000a001' and employer_id='00000000-0000-4000-8000-0000000e0001'),
  1, 'first save is version 1');
select is((select count(*)::int from public.paycheck_template_lines l
  join public.paycheck_templates t on t.household_id=l.household_id and t.id=l.template_id
  where t.household_id='00000000-0000-4000-8000-00000000a001' and t.employer_id='00000000-0000-4000-8000-0000000e0001'),
  4, 'four lines written');
select is((select active_template_id is not null from public.paycheck_series_settings
  where household_id='00000000-0000-4000-8000-00000000a001' and series_id='00000000-0000-4000-8000-0000000501a1'),
  true, 'series pointer set to the new template');
select is((select autonomy::text from public.paycheck_series_settings
  where household_id='00000000-0000-4000-8000-00000000a001' and series_id='00000000-0000-4000-8000-0000000501a1'),
  'off', 'save does NOT grant autonomy (stays off)');

-- second save → version 2 (immutable-versioned; a change is a new version)
select lives_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd02','paychecks.save_template:cmd02',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', false,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',1))))$$,
  'second save authors a new version');
select is((select max(template_version) from public.paycheck_templates
  where household_id='00000000-0000-4000-8000-00000000a001' and employer_id='00000000-0000-4000-8000-0000000e0001'),
  2, 'second save is version 2 (immutable-versioned)');

-- ==== Validation rejections at SAVE ========================================
-- ΣP ≥ 10000 (two percent lines 6000+4000) rejected at save.
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd03','paychecks.save_template:cmd03',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps',6000,'category_ledger_account_id','00000000-0000-4000-8000-0000000ca001','position',1),
      jsonb_build_object('line_key','sta','kind','state_withholding','role','tax','amount_kind','percent_of_gross_bps','bps',4000,'category_ledger_account_id','00000000-0000-4000-8000-0000000ca001','position',2),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',3))))$$,
  'P0009', null, 'aggregate ΣP ≥ 10000 rejected at save (§D3)');

-- destination must be a MANUAL asset — a connected asset account is rejected.
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd04','paychecks.save_template:cmd04',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','k401','kind','retirement_401k','role','pretax_transfer','amount_kind','fixed_minor','amount_minor','5000','destination_account_id','00000000-0000-4000-8000-0000000ac002','position',1),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',2))))$$,
  'P0009', null, 'connected (non-manual) destination account rejected (§D2)');

-- destination must be an ASSET — a manual liability account is rejected.
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd05','paychecks.save_template:cmd05',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','k401','kind','hsa','role','pretax_transfer','amount_kind','fixed_minor','amount_minor','5000','destination_account_id','00000000-0000-4000-8000-0000000ac003','position',1),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',2))))$$,
  'P0009', null, 'manual liability destination rejected — must be asset (§D2)');

-- category must be same-entity — mixing a Business-entity tax with a
-- Personal-entity destination is rejected.
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd06','paychecks.save_template:cmd06',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','percent_of_gross_bps','bps',1500,'category_ledger_account_id','00000000-0000-4000-8000-0000000ca002','position',1),
      jsonb_build_object('line_key','k401','kind','retirement_401k','role','pretax_transfer','amount_kind','fixed_minor','amount_minor','5000','destination_account_id','00000000-0000-4000-8000-0000000ac001','position',2),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',3))))$$,
  'P0009', null, 'cross-entity category+destination rejected (same-entity, §D2)');

-- exactly-one-remainder: zero remainder net_deposit lines rejected.
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd07','paychecks.save_template:cmd07',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled', true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','fed','kind','federal_withholding','role','tax','amount_kind','fixed_minor','amount_minor','100','category_ledger_account_id','00000000-0000-4000-8000-0000000ca001','position',1))))$$,
  'P0009', null, 'zero remainder net_deposit lines rejected (exactly-one)');

-- ==== set_series_settings: OWNER required ==================================
-- partner attempt → rejected (P0005 not authorized).
select pg_temp.as_user('00000000-0000-4000-8000-000000000002');  -- partner
select throws_ok($$select public.keel_cmd_paycheck_set_series_settings(
  '00000000-0000-4000-8000-0000000cdd10','paychecks.set_series_settings:cmd10',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000002"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','active_template_id',null,'booking_enabled',true,'autonomy','suggest'))$$,
  'P0005', null, 'partner CANNOT set series settings (OWNER-only autonomy grant)');

-- owner attempt → OK.
select pg_temp.as_user('00000000-0000-4000-8000-000000000001');  -- owner
select lives_ok($$select public.keel_cmd_paycheck_set_series_settings(
  '00000000-0000-4000-8000-0000000cdd11','paychecks.set_series_settings:cmd11',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','active_template_id',null,'booking_enabled',true,'autonomy','suggest'))$$,
  'owner CAN set series settings to suggest');
select is((select autonomy::text from public.paycheck_series_settings
  where household_id='00000000-0000-4000-8000-00000000a001' and series_id='00000000-0000-4000-8000-0000000501a1'),
  'suggest', 'autonomy granted to suggest by owner');

-- auto_with_log requires an active template (null template → rejected).
select throws_ok($$select public.keel_cmd_paycheck_set_series_settings(
  '00000000-0000-4000-8000-0000000cdd12','paychecks.set_series_settings:cmd12',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','active_template_id',null,'booking_enabled',true,'autonomy','auto_with_log'))$$,
  'P0009', null, 'auto_with_log without active_template_id rejected');

-- grant record: an audit before/after row exists for the owner's set.
select is((select count(*)::int from public.audit_log
  where household_id='00000000-0000-4000-8000-00000000a001'
    and action='paychecks.set_series_settings.grant'
    and command_id='00000000-0000-4000-8000-0000000cdd11'
    and after->>'autonomy'='suggest'), 1, 'grant audit row records before/after (§D7)');

-- ==== idempotent replay ====================================================
-- Re-run cmd11 with the SAME payload → idempotentReplay true, no new state.
select is(
  ((select public.keel_cmd_paycheck_set_series_settings(
    '00000000-0000-4000-8000-0000000cdd11','paychecks.set_series_settings:cmd11',
    '{"kind":"user","userId":"00000000-0000-4000-8000-000000000001"}'::jsonb,
    '00000000-0000-4000-8000-00000000a001',
    jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','active_template_id',null,'booking_enabled',true,'autonomy','suggest')))->>'idempotentReplay'),
  'true', 'idempotent replay of the same economic event key');

-- ==== tenant isolation =====================================================
-- b's owner cannot save into a's household (scope violation).
select pg_temp.as_user('00000000-0000-4000-8000-000000000009');
select throws_ok($$select public.keel_cmd_paycheck_save_template(
  '00000000-0000-4000-8000-0000000cdd20','paychecks.save_template:cmd20',
  '{"kind":"user","userId":"00000000-0000-4000-8000-000000000009"}'::jsonb,
  '00000000-0000-4000-8000-00000000a001',
  jsonb_build_object('series_id','00000000-0000-4000-8000-0000000501a1','employer_id','00000000-0000-4000-8000-0000000e0001','booking_enabled',true,
    'lines', jsonb_build_array(
      jsonb_build_object('line_key','gross','kind','gross_salary','role','earning','amount_kind','remainder','position',0),
      jsonb_build_object('line_key','take_home','kind','direct_deposit','role','net_deposit','amount_kind','remainder','position',1))))$$,
  'P0006', null, 'a non-member cannot author a template in another household (tenant isolation)');

select * from finish();
rollback;
