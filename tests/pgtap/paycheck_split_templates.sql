-- pgTAP for paycheck split templates SLICE B
-- (docs/harness/plans/paycheck-split-templates-v2.md §D3, §2 migration 180000).
-- Runner: scripts/run-paycheck-split-templates-pgtap.sh initdb's a throwaway
-- cluster, builds the minimal REAL base schema my migration FKs to, injects the
-- REAL migration body at the __MIGRATION_BODY__ marker, then runs this file.
--
-- Proves: schema present; immutability of template lines; exactly-one-remainder;
-- autonomy='auto_with_log' requires an active template (CHECK); amount_kind↔role
-- coherence; composite tenant FKs reject cross-household; NO implicit financial/
-- policy defaults; the three new tables are in the export snapshot (Law 6).

begin;
select plan(31);

-- __MIGRATION_BODY__ (runner replaces this line with the real migration file)

-- ---- Fixtures -------------------------------------------------------------
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001');

insert into public.households(id) values
  ('00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b001');
insert into public.household_memberships(household_id,user_id,role) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-000000000001','owner');

insert into public.ledger_accounts(household_id,id,name) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ca001','Federal Tax'),
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ca002','Salary Income');
insert into public.accounts(household_id,id,name) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000ac001','401k'),
  ('00000000-0000-4000-8000-00000000b001','00000000-0000-4000-8000-0000000ac0b1','Other HH acct');
insert into public.employers(household_id,id,name) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000e0001','Acme Fictional Co');
insert into public.recurring_series(household_id,id) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1');
insert into public.paycheck_templates(household_id,id,employer_id,template_version)
values ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1',
        '00000000-0000-4000-8000-0000000e0001',1);
insert into public.canonical_transactions(household_id,id,effective_date,description)
values ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000c01a1',
        '2026-07-12','Acme Fictional Co deposit');

-- ---- Schema presence ------------------------------------------------------
select has_table('public','paycheck_template_lines','template lines table exists');
select has_table('public','paycheck_series_settings','series settings table exists');
select has_table('public','paycheck_split_suggestions','split suggestions table exists');
select has_function('public','keel_list_paycheck_templates',array['uuid'],'templates read model exists');
select has_function('public','keel_list_paycheck_split_suggestions',array['uuid'],'suggestions read model exists');

-- ---- No implicit financial/policy defaults (Law 4) ------------------------
-- booking_enabled and autonomy have NO column default (a writer must supply).
select is(
  (select count(*)::int from information_schema.columns
    where table_schema='public' and table_name='paycheck_series_settings'
      and column_name in ('booking_enabled','autonomy') and column_default is not null),
  0, 'series_settings booking_enabled/autonomy carry no SQL default (Law 4)');
select is(
  (select count(*)::int from information_schema.columns
    where table_schema='public' and table_name='paycheck_template_lines'
      and column_name in ('amount_minor','bps','kind','role','amount_kind') and column_default is not null),
  0, 'template_lines financial/policy columns carry no SQL default (Law 4)');

-- ---- Template lines: valid inserts ----------------------------------------
select lives_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,bps,category_ledger_account_id,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','fed','federal_withholding','tax','percent_of_gross_bps',1500,'00000000-0000-4000-8000-0000000ca001',1)$$,
  'tax percent line with category inserts');
-- fixed_minor pretax_transfer MUST carry amount_minor (shape) + a destination.
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,destination_account_id,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','k401','retirement_401k','pretax_transfer','fixed_minor',null,'00000000-0000-4000-8000-0000000ac001',2)$$,
  '23514', null, 'fixed_minor line with null amount_minor is rejected (amount shape)');
select lives_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,destination_account_id,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','k401b','hsa','pretax_transfer','fixed_minor',5000,'00000000-0000-4000-8000-0000000ac001',3)$$,
  'fixed_minor pretax_transfer with amount + destination inserts');
select lives_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','take_home','direct_deposit','net_deposit','remainder',4)$$,
  'single remainder net_deposit line inserts');

-- ---- Exactly-one-remainder (partial unique index) -------------------------
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','take_home2','direct_deposit','net_deposit','remainder',5)$$,
  '23505', null, 'second remainder line on same template is rejected');

-- ---- amount_kind / role / kind coherence CHECKs ---------------------------
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,bps,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','badpct','federal_withholding','tax','fixed_minor',1500,9)$$,
  '23514', null, 'percent bps on a fixed_minor line is rejected (amount shape)');
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','badrole','direct_deposit','tax','fixed_minor',100,9)$$,
  '23514', null, 'direct_deposit kind under tax role is rejected (role↔kind)');
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','notransfer','retirement_401k','pretax_transfer','fixed_minor',100,9)$$,
  '23514', null, 'pretax_transfer without destination_account_id is rejected');
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,bps,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','badbps','federal_withholding','tax','percent_of_gross_bps',10000,9)$$,
  '23514', null, 'bps=10000 rejected (0<bps<10000 per-line)');
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,category_ledger_account_id,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','earncat','gross_salary','earning','fixed_minor',100,'00000000-0000-4000-8000-0000000ca002',9)$$,
  '23514', null, 'earning line carrying a category ledger account is rejected');

-- ---- Composite tenant FK: cross-household destination rejected -------------
select throws_ok($$insert into public.paycheck_template_lines
  (household_id,template_id,line_key,kind,role,amount_kind,amount_minor,destination_account_id,position) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000701a1','xhh','hsa','pretax_transfer','fixed_minor',100,'00000000-0000-4000-8000-0000000ac0b1',9)$$,
  '23503', null, 'destination account from another household is rejected (tenant FK)');

-- ---- Immutability of template lines ---------------------------------------
select throws_ok($$update public.paycheck_template_lines set position=99
  where household_id='00000000-0000-4000-8000-00000000a001' and line_key='fed'$$,
  'P0001', null, 'template lines are immutable (UPDATE forbidden)');
select throws_ok($$delete from public.paycheck_template_lines
  where household_id='00000000-0000-4000-8000-00000000a001' and line_key='fed'$$,
  'P0001', null, 'template lines are immutable (DELETE forbidden)');

-- ---- series_settings: autonomy='auto_with_log' requires active_template_id -
select throws_ok($$insert into public.paycheck_series_settings
  (household_id,series_id,employer_id,booking_enabled,autonomy) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000e0001',false,'auto_with_log')$$,
  '23514', null, 'auto_with_log without an active template is rejected (CHECK)');
select lives_ok($$insert into public.paycheck_series_settings
  (household_id,series_id,employer_id,active_template_id,booking_enabled,autonomy) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000e0001','00000000-0000-4000-8000-0000000701a1',true,'auto_with_log')$$,
  'auto_with_log WITH an active template inserts');
select lives_ok($$update public.paycheck_series_settings set autonomy='suggest'
  where household_id='00000000-0000-4000-8000-00000000a001' and series_id='00000000-0000-4000-8000-0000000501a1'$$,
  'series_settings is mutable (the pointer)');

-- ---- split_suggestions: full AI record + decision coherence ---------------
select lives_ok($$insert into public.paycheck_split_suggestions
  (household_id,series_id,template_id,template_version,deposit_txn_id,computed_components,
   computed_gross_minor,computed_net_minor,source,ai_response) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000701a1',1,
   '00000000-0000-4000-8000-0000000c01a1','[]'::jsonb,115157,100000,'detector',
   '{"verdict":"yes","tldr":"Split Acme paycheck","confidence":0.91,"asOf":"2026-07-12T00:00:00Z","scope":{"entities":[],"accounts":[],"period":"2026-07-01/2026-07-31"},"reasonCodes":["template_match"],"evidenceRefs":[],"proposedActions":[],"requiresApproval":true,"modelVersion":"m1","promptVersion":"p1","policyVersion":"v1"}'::jsonb)$$,
  'suggestion with full AiResponseRecordSchema (Law 11) inserts');
select throws_ok($$insert into public.paycheck_split_suggestions
  (household_id,series_id,template_id,template_version,deposit_txn_id,computed_components,
   computed_gross_minor,computed_net_minor,source,ai_response,status,applied_paycheck_id) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000701a1',2,
   '00000000-0000-4000-8000-0000000c01a1','[]'::jsonb,1,1,'agent','{}'::jsonb,'accepted',null)$$,
  '23514', null, 'accepted suggestion with null applied_paycheck_id rejected (decision coherence)');
select throws_ok($$insert into public.paycheck_split_suggestions
  (household_id,series_id,template_id,template_version,deposit_txn_id,computed_components,
   computed_gross_minor,computed_net_minor,source,ai_response) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000701a1',1,
   '00000000-0000-4000-8000-0000000c01a1','[]'::jsonb,1,1,'detector','{}'::jsonb)$$,
  '23505', null, 'duplicate (deposit,template,version) suggestion rejected (idempotent re-detection)');
select throws_ok($$insert into public.paycheck_split_suggestions
  (household_id,series_id,template_id,template_version,deposit_txn_id,computed_components,
   computed_gross_minor,computed_net_minor,source,ai_response) values
  ('00000000-0000-4000-8000-00000000a001','00000000-0000-4000-8000-0000000501a1','00000000-0000-4000-8000-0000000701a1',3,
   '00000000-0000-4000-8000-0000000c01a1','[]'::jsonb,1,1,'model','{}'::jsonb)$$,
  '23514', null, 'source outside (detector,agent) rejected');

-- ---- paychecks additive reproducibility columns (Law 9) -------------------
select has_column('public','paychecks','template_id','paychecks.template_id added (Law 9)');
select has_column('public','paychecks','template_version','paychecks.template_version added (Law 9)');

-- ---- Export snapshot includes all three new tables (Law 6) ----------------
select is(
  (select count(*)::int from (values
     ('paycheck_template_lines'),('paycheck_series_settings'),('paycheck_split_suggestions')) t(n)
   where public.keel_export_household('00000000-0000-4000-8000-00000000a001')->'tables' ? t.n),
  3, 'export snapshot contains all three new table keys (Law 6)');
select is(
  (select jsonb_array_length(
     public.keel_export_household('00000000-0000-4000-8000-00000000a001')#>'{tables,paycheck_series_settings}')),
  1, 'export snapshot carries the one series_settings row');

select * from finish();
rollback;
