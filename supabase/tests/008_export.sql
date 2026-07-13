-- Stage 1D export: least-privilege ACL, owner-only scope, explicit DTOs.
begin;
select plan(25);

create temporary table expected_export_tables (
  table_name text primary key,
  allowed_columns text[] not null,
  omitted_columns text[] not null default '{}'
) on commit drop;

insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('households', array['id','name','created_at'], '{}'),
  ('entities', array['id','household_id','name','kind','created_at','archived_at'], '{}'),
  ('household_memberships', array['household_id','user_id','role','created_at'], '{}'),
  ('entity_memberships', array['entity_id','user_id','created_at'], '{}'),
  ('accounts', array['id','household_id','entity_id','connection_id','ledger_account_id','name','subtype','currency','external_ref','created_at','archived_at'], '{}'),
  ('account_owners', array['account_id','user_id','created_at'], '{}'),
  ('ledger_accounts', array['id','household_id','entity_id','name','kind','currency','is_category','created_at','archived_at','pfc_key','is_system','parent_ledger_account_id','tax_line'], '{}'),
  ('connections', array['id','household_id','provider','external_ref','status','created_at','institution_id','consent_expires_at','last_successful_sync_at','sync_lease_owner','sync_leased_until','sync_desired_generation','sync_committed_generation','next_sync_eligible_at','display_name'], '{}'),
  ('resource_permissions', array['id','household_id','user_id','resource_kind','resource_id','permission','created_at'], '{}'),
  ('approval_policies', array['id','household_id','risk_class','autonomy','created_at'], '{}'),
  ('canonical_transactions', array['id','household_id','entity_id','account_id','status','source','description','effective_date','economic_event_key','created_at','voided_at'], '{}'),
  ('journal_batches', array['id','household_id','canonical_transaction_id','description','effective_date','reverses_batch_id','command_id','posted_at'], '{}'),
  ('journal_postings', array['id','batch_id','ledger_account_id','entity_id','amount_minor','currency'], '{}'),
  ('journal_revisions', array['id','original_batch_id','reversal_batch_id','replacement_batch_id','reason','created_at'], '{}'),
  ('period_locks', array['id','household_id','entity_id','start_date','end_date','locked_by','locked_at','reopened_at','reopen_reason'], '{}'),
  ('transaction_source_links', array['canonical_transaction_id','normalized_source_record_id','created_at','household_id'], '{}'),
  ('transfer_links', array['id','household_id','txn_out','txn_in','status','decided_by','decided_at','created_at'], '{}'),
  ('raw_provider_events', array['id','household_id','connection_id','provider','provider_event_id','account_external_ref','received_at','recorded_at','body_text','body_sha256'], array['body']),
  ('normalized_source_records', array['id','raw_event_id','household_id','account_id','provider_transaction_id','amount_minor','currency','effective_date','description','pending','pending_transaction_ref','created_at','kind'], '{}'),
  ('import_batches', array['id','household_id','account_id','source_kind','filename','row_count','created_at','committed_at','rolled_back_at'], '{}'),
  ('import_rows', array['id','import_batch_id','row_number','raw','created_at'], '{}'),
  ('ingestion_skips', array['id','household_id','connection_id','raw_event_id','provider_transaction_id','currency','reason','created_at'], '{}'),
  ('account_lineage', array['id','household_id','account_id','event_type','previous_state','new_state','occurred_at'], '{}'),
  ('balance_snapshots', array['id','household_id','account_id','as_of','available_minor','current_minor','currency','source','snapshot_metadata','created_at'], '{}'),
  ('connection_health_events', array['id','household_id','connection_id','event_type','severity','details','occurred_at'], '{}'),
  ('audit_log', array['id','household_id','actor','action','object_type','object_id','command_id','before','after','at'], '{}'),
  ('domain_events', array['id','event_type','household_id','command_id','economic_event_key','actor','occurred_at','payload'], '{}'),
  ('command_executions', array['household_id','economic_event_key','command','payload_sha256','result','executed_at'], array['command_id']);
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('recurring_detector_runs', array['id','household_id','run_key','as_of','detector_version','confidence_version','normalizer_version','candidate_snapshot_hash','created_at'], '{}'),
  ('recurring_series', array['id','household_id','series_key','account_id','ledger_account_id','counterparty_key','currency','sign','status','current_candidate_version_id','confirmed_by','confirmed_at','created_at','updated_at'], '{}'),
  ('recurring_candidate_versions', array['id','household_id','series_id','detector_run_id','candidate_hash','input_fingerprint','detector_version','confidence_version','normalizer_version','as_of','score_bps','evidence','candidate','created_at'], '{}'),
  ('recurring_occurrences', array['household_id','id','series_id','candidate_version_id','occurrence_key','expected_date','expected_amount_minor','currency','amount_kind','status','matched_txn_id','score_bps','evidence','input_fingerprint','detector_version','confidence_version','as_of','created_at'], '{}'),
  ('recurring_status_events', array['household_id','id','series_id','candidate_version_id','transition','effective_date','actor','command_id','created_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('tags', array['id','household_id','name','created_at'], '{}'),
  ('transaction_tags', array['canonical_transaction_id','tag_id','household_id','created_at'], '{}'),
  ('scheduled_transactions', array['id','household_id','account_id','description','amount_minor','currency','category_ledger_account_id','frequency','next_due_date','auto_enter_days','status','created_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('transaction_categories', array['canonical_transaction_id','household_id','category_ledger_account_id','source','rule_id','created_at','updated_at'], '{}'),
  ('transaction_overrides', array['canonical_transaction_id','household_id','display_description','note','created_at','updated_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('category_rules', array['id','household_id','entity_id','matcher','pattern','category_ledger_account_id','rename_to','priority','active','created_at','updated_at'], '{}'),
  ('rule_renames', array['canonical_transaction_id','household_id','rule_id','display_name','created_at','updated_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('budgets', array['household_id','category_ledger_account_id','month','amount_minor','currency','created_at','updated_at','rollover'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('employers',array['id','household_id','name','created_at'],'{}'),
  ('payroll_provider_imports',array['id','household_id','provider','source_ref','content_hash','imported_at'],'{}'),
  ('paychecks',array['id','household_id','employer_id','pay_date','gross_minor','net_minor','currency','status','formula_version','created_by','created_at','updated_at'],'{}'),
  ('paycheck_components',array['household_id','id','paycheck_id','component_key','kind','amount_minor','created_at'],'{}'),
  ('paycheck_templates',array['household_id','id','employer_id','template_version','component_blueprint','formula_version','created_at'],'{}'),
  ('paycheck_sources',array['household_id','id','paycheck_id','source_kind','source_ref','content_hash','payroll_provider_import_id','created_at'],'{}'),
  ('paycheck_transaction_matches',array['household_id','id','paycheck_id','component_id','transaction_id','allocated_minor','created_at'],'{}'),
  ('paycheck_status_events',array['household_id','id','paycheck_id','transition','reason','actor','command_id','created_at'],'{}');
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('counterparties',array['id','household_id','name','kind','created_at'],'{}'),
 ('expense_shares',array['household_id','id','original_transaction_id','counterparty_id','amount_minor','currency','description','created_at'],'{}'),
 ('reimbursement_claims',array['household_id','id','expense_share_id','counterparty_id','original_transaction_id','amount_minor','currency','status','created_by','created_at','updated_at'],'{}'),
 ('settlements',array['household_id','id','counterparty_id','transaction_id','total_minor','currency','status','note','created_by','created_at','updated_at'],'{}'),
 ('settlement_matches',array['household_id','id','settlement_id','claim_id','allocated_minor','created_at'],'{}'),
 ('refund_expectations',array['household_id','id','original_transaction_id','expected_minor','currency','evidence','created_at'],'{}'),
 ('refund_matches',array['household_id','id','expectation_id','transaction_id','allocated_minor','created_at'],'{}'),
 ('settlement_status_events',array['household_id','id','settlement_id','transition','reason','actor','command_id','created_at'],'{}'),
 ('reimbursement_claim_status_events',array['household_id','id','claim_id','transition','reason','actor','command_id','created_at'],'{}');
insert into expected_export_tables(table_name,allowed_columns,omitted_columns)values
('statements',array['id','household_id','account_id','period_start','period_end','opening_minor','ending_minor','currency','source_hash','created_by','created_at'],'{}'),
('statement_lines',array['household_id','id','statement_id','line_key','line_date','amount_minor','description','created_at'],'{}'),
('reconciliation_sessions',array['household_id','id','statement_id','account_id','ledger_ending_minor','difference_minor','status','formula_version','period_lock_id','closed_by','closed_at','reopened_at','created_at'],'{}'),
('reconciliation_items',array['household_id','id','session_id','statement_line_id','resolution','transaction_id','explanation','created_at'],'{}'),
('reconciliation_adjustments',array['household_id','id','session_id','kind','amount_minor','explanation','created_at'],'{}'),
('close_checklists',array['household_id','id','session_id','checklist_version','checks','created_at'],'{}'),
('reconciliation_status_events',array['household_id','id','session_id','transition','reason','actor','command_id','created_at'],'{}');

create temporary table excluded_export_tables(table_name text primary key) on commit drop;
insert into excluded_export_tables(table_name) values
  ('connection_credentials'), ('plaid_webhook_keys'), ('webhook_rejections'),
  ('webhook_rejection_counters'), ('provider_call_budget'), ('usage_events'),
  ('plaid_test_responses'), ('plaid_webhook_key_test_responses'), ('sync_test_pages'),
  ('sync_attempts'), ('sync_checkpoints'), ('link_attempts'), ('removal_attempts');
insert into excluded_export_tables(table_name) values ('recurring_detection_claims');

select has_role('keel_export', 'dedicated export role exists');
select ok(
  (select not rolcanlogin and not rolsuper and not rolbypassrls
     from pg_roles where rolname = 'keel_export'),
  'keel_export is NOLOGIN, non-superuser, and cannot bypass RLS'
);
select is(
  (select count(*)::int from expected_export_tables
    where has_table_privilege('keel_export', format('public.%I', table_name), 'SELECT')),
  65,
  'keel_export can SELECT all 65 included tables'
);
select is(
  (select count(*)::int
     from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not exists (
        select 1 from expected_export_tables e where e.table_name = c.relname
      )
      and has_table_privilege('keel_export', c.oid, 'SELECT')),
  0,
  'keel_export has zero SELECT privilege on every actual non-included public table'
);
select is(
  (with actual as (
      select c.relname as table_name
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
    ), classified as (
      select table_name, count(*)::int as decisions
        from (
          select table_name from expected_export_tables
          union all
          select table_name from excluded_export_tables
        ) decisions
       group by table_name
    )
    select count(*)::int
      from actual
      full join classified using (table_name)
     where actual.table_name is null
        or classified.table_name is null
        or classified.decisions <> 1),
  0,
  'live public base-table catalog is classified exactly once as INCLUDE or EXCLUDE'
);

select has_function('public', 'keel_export_household', array['uuid','timestamp with time zone'],
  'export snapshot function exists with caller-fixable asOf');
select ok(
  (select prosecdef from pg_proc
    where oid = 'public.keel_export_household(uuid,timestamptz)'::regprocedure),
  'export function is SECURITY DEFINER'
);
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
    where p.oid = 'public.keel_export_household(uuid,timestamptz)'::regprocedure),
  'keel_export',
  'export function is owned by keel_export'
);
select ok(not has_function_privilege('public', 'public.keel_export_household(uuid,timestamptz)', 'EXECUTE'),
  'PUBLIC cannot execute export');
select ok(not has_function_privilege('anon', 'public.keel_export_household(uuid,timestamptz)', 'EXECUTE'),
  'anon cannot execute export');
select ok(not has_function_privilege('authenticated', 'public.keel_export_household(uuid,timestamptz)', 'EXECUTE'),
  'authenticated cannot execute export');
select ok(has_function_privilege('service_role', 'public.keel_export_household(uuid,timestamptz)', 'EXECUTE'),
  'service_role can execute export after Edge authorization');

select is(
  (select count(*)::int
     from information_schema.columns c
     join expected_export_tables e on e.table_name = c.table_name
    where c.table_schema = 'public'
      and not (c.column_name = any(e.allowed_columns) or c.column_name = any(e.omitted_columns))),
  0,
  'every included-table column is explicitly allowed or explicitly omitted'
);
select is(
  (select count(*)::int
     from expected_export_tables e
     cross join lateral unnest(e.allowed_columns) allowed(column_name)
     left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = e.table_name
      and c.column_name = allowed.column_name
    where c.column_name is null),
  0,
  'every allowlisted export column exists'
);

-- Balanced alpha and beta fixtures prove indirect child scoping and bigint text.
insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, reverses_batch_id, command_id, posted_at)
values
  ('98000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000a001', null,
   'alpha export fixture', '2026-07-12', null, '98000000-0000-4000-8000-0000000000c1', now()),
  ('98000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000b001', null,
   'beta export fixture', '2026-07-12', null, '98000000-0000-4000-8000-0000000000c2', now());
insert into public.journal_postings(id,batch_id,ledger_account_id,entity_id,amount_minor,currency) values
  ('98000000-0000-4000-8000-0000000000a2','98000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-00000000a301','00000000-0000-4000-8000-00000000a101',9000000000000000000,'USD'),
  ('98000000-0000-4000-8000-0000000000a3','98000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-00000000a311','00000000-0000-4000-8000-00000000a101',-9000000000000000000,'USD'),
  ('98000000-0000-4000-8000-0000000000b2','98000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-00000000b301','00000000-0000-4000-8000-00000000b101',77,'USD'),
  ('98000000-0000-4000-8000-0000000000b3','98000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-00000000b311','00000000-0000-4000-8000-00000000b101',-77,'USD');
insert into public.command_executions
  (household_id,economic_event_key,command_id,command,payload_sha256,result,executed_at)
values
  ('00000000-0000-4000-8000-00000000a001','pgtap:export:command:1','98000000-0000-4000-8000-0000000000c3',
   'journal.post_batch',repeat('a',64),'{"ok":true}',now());

grant create on schema public to keel_export;
create function public.keel_test_export_credential_probe() returns bigint
language sql security definer set search_path = pg_catalog, public
as $$select count(*) from public.connection_credentials$$;
alter function public.keel_test_export_credential_probe() owner to keel_export;
revoke create on schema public from keel_export;
select throws_ok($$select public.keel_test_export_credential_probe()$$, '42501', null,
  'excluded credential SELECT fails at permission time as keel_export');
drop function public.keel_test_export_credential_probe();

select ok(
  pg_get_functiondef('public.keel_export_household(uuid,timestamptz)'::regprocedure)
    not like '%request.jwt%',
  'service-only export function does not rely on user JWT claims'
);

set local role service_role;
select lives_ok($$
  select public.keel_export_household('00000000-0000-4000-8000-00000000a001')
$$, 'service role can build an Edge-authorized household export');
select throws_ok($$
  select public.keel_export_household('00000000-0000-4000-8000-00000000ffff')
$$, 'P0006', null, 'service export defensively rejects a nonexistent household');

reset role;

select is(
  (select count(*)::int from jsonb_object_keys(
    public.keel_export_household('00000000-0000-4000-8000-00000000a001')->'tables')),
  65,
  'snapshot contains all 65 included table arrays'
);
select is(
  (select count(*)::int from excluded_export_tables e
    where public.keel_export_household('00000000-0000-4000-8000-00000000a001')->'tables' ? e.table_name),
  0,
  'snapshot contains no excluded table key'
);
select ok(
  public.keel_export_household('00000000-0000-4000-8000-00000000a001')::text
    not like '%98000000-0000-4000-8000-0000000000b2%',
  'beta indirect journal posting is absent from alpha export'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(
      public.keel_export_household('00000000-0000-4000-8000-00000000a001') #> '{tables,journal_postings}') row
    where jsonb_typeof(row->'amount_minor') <> 'string'
  ),
  'every exported posting BIGINT is a JSON string'
);
select is(
  public.keel_export_household(
    '00000000-0000-4000-8000-00000000a001', '2026-07-12T12:34:56Z'::timestamptz)->>'asOf',
  '2026-07-12T12:34:56.000000Z',
  'caller can fix one RFC3339 asOf stamp'
);
select is(
  (select count(*)::int from jsonb_array_elements(
    public.keel_export_household('00000000-0000-4000-8000-00000000a001') #> '{tables,command_executions}') row
   where row->>'economic_event_key' = 'pgtap:export:command:1'),
  1,
  'v2 command_executions projection is included'
);
select is(
  public.keel_export_household('00000000-0000-4000-8000-00000000a001')->'trialBalance',
  (select jsonb_agg(jsonb_build_object(
      'ledgerAccountId', ledger_account_id,
      'currency', currency,
      'balanceMinor', balance_minor
    ) order by ledger_account_id, currency)
   from (
     select p.ledger_account_id::text as ledger_account_id, p.currency::text as currency,
            sum(p.amount_minor)::text as balance_minor
       from public.journal_postings p
       join public.journal_batches b on b.id = p.batch_id
      where b.household_id = '00000000-0000-4000-8000-00000000a001'
      group by p.ledger_account_id, p.currency
   ) expected),
  'same-snapshot exported trial balance matches live posting aggregate'
);

select * from finish();
rollback;
