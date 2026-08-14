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
  ('accounts', array['id','household_id','entity_id','connection_id','ledger_account_id','name','subtype','currency','external_ref','mask','created_at','archived_at','holdings_cash_equivalent_count','holdings_provider_count','holdings_synced_at'], '{}'),
  ('account_owners', array['account_id','user_id','created_at'], '{}'),
  ('ledger_accounts', array['id','household_id','entity_id','name','kind','currency','is_category','created_at','archived_at','pfc_key','is_system','parent_ledger_account_id','tax_line'], '{}'),
  ('connections', array['id','household_id','provider','external_ref','status','created_at','institution_id','consent_expires_at','last_successful_sync_at','sync_lease_owner','sync_leased_until','sync_desired_generation','sync_committed_generation','next_sync_eligible_at','display_name','sync_continuation_pending','sync_continuation_marked_at','holdings_last_error_code','holdings_last_error_message','holdings_last_error_at','holdings_last_success_at','archived_at'], '{}'),
  ('resource_permissions', array['id','household_id','user_id','resource_kind','resource_id','permission','created_at'], '{}'),
  ('approval_policies', array['id','household_id','risk_class','autonomy','created_at'], '{}'),
  ('canonical_transactions', array['id','household_id','entity_id','account_id','status','source','description','effective_date','economic_event_key','created_at','voided_at'], '{}'),
  ('journal_batches', array['id','household_id','canonical_transaction_id','description','effective_date','reverses_batch_id','command_id','posted_at'], '{}'),
  ('journal_postings', array['id','batch_id','ledger_account_id','entity_id','amount_minor','currency'], '{}'),
  ('journal_revisions', array['id','original_batch_id','reversal_batch_id','replacement_batch_id','reason','created_at'], '{}'),
  ('period_locks', array['id','household_id','entity_id','start_date','end_date','locked_by','locked_at','reopened_at','reopen_reason'], '{}'),
  ('transaction_source_links', array['canonical_transaction_id','normalized_source_record_id','created_at','household_id'], '{}'),
  ('transfer_links', array['id','household_id','txn_out','txn_in','status','booked_txn','decided_by','decided_at','created_at'], '{}'),
  ('raw_provider_events', array['id','household_id','connection_id','provider','provider_event_id','account_external_ref','received_at','recorded_at','body_text','body_sha256'], array['body']),
  ('normalized_source_records', array['id','raw_event_id','household_id','account_id','provider_transaction_id','amount_minor','currency','effective_date','description','pending','pending_transaction_ref','created_at','kind'], array['pfc_primary']),
  ('import_batches', array['id','household_id','account_id','source_kind','filename','row_count','created_at','committed_at','rolled_back_at'], '{}'),
  ('import_rows', array['id','import_batch_id','row_number','raw','created_at'], '{}'),
  ('ingestion_skips', array['id','household_id','connection_id','raw_event_id','provider_transaction_id','currency','reason','created_at'], '{}'),
  ('account_lineage', array['id','household_id','account_id','event_type','previous_state','new_state','occurred_at'], '{}'),
  ('balance_snapshots', array['id','household_id','account_id','as_of','available_minor','current_minor','limit_minor','currency','source','snapshot_metadata','created_at'], '{}'),
  ('connection_health_events', array['id','household_id','connection_id','event_type','severity','details','occurred_at'], '{}'),
  ('audit_log', array['id','household_id','actor','action','object_type','object_id','command_id','before','after','at'], '{}'),
  ('domain_events', array['id','event_type','household_id','command_id','economic_event_key','actor','occurred_at','payload'], '{}'),
  ('command_executions', array['household_id','economic_event_key','command','payload_sha256','result','executed_at'], array['command_id']);
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('recurring_detector_runs', array['id','household_id','run_key','as_of','detector_version','confidence_version','normalizer_version','candidate_snapshot_hash','created_at'], '{}'),
  ('recurring_series', array['id','household_id','series_key','account_id','ledger_account_id','counterparty_key','currency','sign','status','current_candidate_version_id','confirmed_by','confirmed_at','created_at','updated_at'], '{}'),
  ('recurring_candidate_versions', array['id','household_id','series_id','detector_run_id','candidate_hash','input_fingerprint','detector_version','confidence_version','normalizer_version','as_of','score_bps','evidence','candidate','created_at'], '{}'),
  ('recurring_occurrences', array['household_id','id','series_id','candidate_version_id','occurrence_key','expected_date','expected_amount_minor','currency','amount_kind','status','matched_txn_id','score_bps','evidence','input_fingerprint','detector_version','confidence_version','as_of','created_at'], '{}'),
  ('recurring_status_events', array['household_id','id','series_id','candidate_version_id','transition','effective_date','actor','command_id','created_at'], '{}'),
  ('recurring_series_schedule_links', array['household_id','id','series_id','schedule_id','linked_by','command_id','created_at','detached_at','detached_reason'], '{}'),
  ('account_statement_cadence', array['household_id','account_id','close_day','updated_by','created_at','updated_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('tags', array['id','household_id','name','created_at'], '{}'),
  ('transaction_tags', array['canonical_transaction_id','tag_id','household_id','created_at'], '{}'),
  ('scheduled_transactions', array['id','household_id','account_id','description','amount_minor','currency','category_ledger_account_id','frequency','next_due_date','auto_enter_days','status','created_at','anchor_day','anchor_day_2'], '{}'),
  ('savings_goals', array['id','household_id','name','target_minor','target_date','account_id','currency','status','created_at','kind','start_balance_minor','tracking'], '{}'),
  ('goal_contributions', array['id','goal_id','household_id','amount_minor','contributed_on','created_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('transaction_categories', array['canonical_transaction_id','household_id','category_ledger_account_id','source','rule_id','created_at','updated_at'], '{}'),
  ('transaction_overrides', array['canonical_transaction_id','household_id','display_description','note','created_at','updated_at'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('category_rules', array['id','household_id','entity_id','matcher','pattern','category_ledger_account_id','rename_to','priority','active','created_at','updated_at','amount_min_minor','amount_max_minor'], '{}'),
  ('rule_renames', array['canonical_transaction_id','household_id','rule_id','display_name','created_at','updated_at'], '{}'),
  ('category_suggestions', array['id','household_id','canonical_transaction_id','suggested_category_ledger_account_id','source','reason_code','evidence','status','created_at','decided_at','decided_by'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('budgets', array['household_id','category_ledger_account_id','month','amount_minor','currency','created_at','updated_at','rollover'], '{}');
insert into expected_export_tables(table_name, allowed_columns, omitted_columns) values
  ('employers',array['id','household_id','name','created_at'],'{}'),
  ('payroll_provider_imports',array['id','household_id','provider','source_ref','content_hash','imported_at'],'{}'),
  ('paychecks',array['id','household_id','employer_id','pay_date','gross_minor','net_minor','currency','status','formula_version','created_by','created_at','updated_at','superseded_by_paycheck_id','applied_from_suggestion_id','template_id','template_version'],'{}'),
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
('statements',array['id','household_id','account_id','period_start','period_end','opening_minor','ending_minor','currency','source_hash','created_by','created_at','anchor_gap_explanation','anchor_reason','balance_check'],'{}'),
('statement_lines',array['household_id','id','statement_id','line_key','line_date','amount_minor','description','created_at'],'{}'),
('reconciliation_sessions',array['household_id','id','statement_id','account_id','ledger_ending_minor','difference_minor','status','formula_version','period_lock_id','closed_by','closed_at','reopened_at','created_at'],'{}'),
('reconciliation_items',array['household_id','id','session_id','statement_line_id','resolution','transaction_id','explanation','created_at'],'{}'),
('reconciliation_adjustments',array['household_id','id','session_id','kind','amount_minor','explanation','created_at'],'{}'),
('close_checklists',array['household_id','id','session_id','checklist_version','checks','created_at'],'{}'),
('reconciliation_status_events',array['household_id','id','session_id','transition','reason','actor','command_id','created_at'],'{}');
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('holdings',array['id','household_id','account_id','as_of','symbol','name','qty','price_minor','value_minor','cost_basis_minor','currency','source','security_type','created_at','updated_at'],'{}'),
 ('holdings_snapshots',array['id','household_id','account_id','snapshot_date','symbol','name','qty','price_minor','value_minor','cost_basis_minor','currency','source','created_at'],'{}'),
 ('investment_sync_state',array['connection_id','household_id','last_pulled_through','window_from','window_to','continuation_offset','last_synced_at','created_at','updated_at'],'{}');
-- WS-J / F-030: receipts document family now exported (Law 6). documents/
-- document_versions/document_attachments close the X-004 attach-only gap;
-- document_extractions/document_transaction_matches are new this slice. The
-- extracted merchant text + raw_evidence are exportable user data (business
-- expense records), not secrets — object bytes live in Storage, never a column.
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('documents',array['id','household_id','entity_id','kind','original_filename','created_by','created_at','deleted_at'],'{}'),
 ('document_versions',array['id','document_id','storage_bucket','storage_path','content_sha256','mime_type','byte_size','created_at'],'{}'),
 ('document_attachments',array['id','household_id','document_id','canonical_transaction_id','paycheck_id','reimbursement_claim_id','statement_id','attached_by','attached_at','detached_by','detached_at'],'{}'),
 ('document_extractions',array['id','household_id','document_version_id','status','extractor','extractor_version','merchant','amount_minor','currency','txn_date','confidence','raw_evidence','error_code','created_at'],'{}'),
 ('document_transaction_matches',array['id','household_id','document_version_id','canonical_transaction_id','status','score','reason_codes','suggested_by','attachment_id','decided_by','decided_at','created_at'],'{}');
-- SLICE 6 (statement-ingestion-v2.md §5/§8/§12): statement_outbox export layer
-- lands here (its table + sweeper shipped Slice 5 with export deferred). The
-- confirm-upload writer + INCLUDE entry + keel_export grant/RLS + this expected
-- row all ship together, so it moves out of excluded_export_tables below.
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('statement_outbox',array['id','household_id','document_version_id','account_id','status','enqueue_count','last_enqueued_at','delivered_at','created_at'],'{}');
-- SLICE 8 (statement-ingestion-v2.md §5 [A7]): card-payment ↔ statement links
-- export layer (INCLUDE entry + keel_export grant/RLS + keel_export_household
-- rewrap all ship together in 20260720260000_statement_payment_links.sql).
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('statement_payment_links',array['household_id','id','statement_id','canonical_transaction_id','transfer_link_id','status','score','matcher_version','reason_codes','decided_by','decided_at','created_at'],'{}');
-- SLICE 9 (statement-ingestion-v2.md §5 [A8]): applied investment-statement
-- holdings export layer (INCLUDE entry + keel_export grant/RLS +
-- keel_export_household rewrap all ship in 20260720270000_statement_holdings_apply.sql).
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('statement_holding_applications',array['household_id','id','statement_id','extraction_id','account_id','applied_by','approval_token_id','period_end','revoked_at','revoked_by','created_at'],'{}');
-- SLICE B (paycheck-split-templates-v2.md §3 [AMENDED 6]): paycheck split
-- templates export layer (INCLUDE entry + keel_export grant/RLS +
-- keel_export_household rewrap all ship in 20260721180000_paycheck_split_templates.sql).
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('paycheck_template_lines',array['household_id','id','template_id','line_key','kind','role','amount_kind','amount_minor','bps','category_ledger_account_id','destination_account_id','position','created_at'],'{}'),
 ('paycheck_series_settings',array['household_id','series_id','employer_id','active_template_id','booking_enabled','income_category_ledger_account_id','autonomy','updated_at'],'{}'),
 ('paycheck_split_suggestions',array['household_id','id','series_id','template_id','template_version','deposit_txn_id','computed_components','computed_gross_minor','computed_net_minor','source','ai_response','status','applied_paycheck_id','created_at','decided_at','decided_by'],'{}');

create temporary table excluded_export_tables(table_name text primary key) on commit drop;
insert into excluded_export_tables(table_name) values
  ('connection_credentials'), ('plaid_webhook_keys'), ('webhook_rejections'),
  ('webhook_rejection_counters'), ('provider_call_budget'), ('usage_events'),
  ('plaid_test_responses'), ('plaid_webhook_key_test_responses'), ('sync_test_pages'),
  ('sync_attempts'), ('sync_checkpoints'), ('link_attempts'), ('removal_attempts');
insert into excluded_export_tables(table_name) values ('recurring_detection_claims');
-- Export layer pending (Law 6 gap, honestly excluded rather than silently
-- unclassified — tracked in NOTES.md, pgTAP-debt cleanup 2026-07-18):
--   household_notes / household_tasks: notes/tasks shipped 2026-07-18
--     (20260718000000) without export wiring.
-- keel_export has no SELECT grant on either, so assertion 4 ("zero SELECT on
-- every non-included table") already proves they are not exported today; flip
-- each to expected_export_tables when its layer ships.
-- (documents / document_versions / document_attachments moved to INCLUDE by
-- WS-J's receipts export layer, 20260718171000_receipts_export.sql.)
-- (statement_outbox moved to INCLUDE by Slice 6's export layer,
--   20260720220000_statement_ingest_begin.sql — confirm-upload writer + INCLUDE
--   entry + keel_export grant/RLS + keel_export_household rewrap together.)
-- WS-tokens / budgeting-v2 / expected-reimbursements / statement-extraction /
-- paycheck-template-apply: these tables shipped with keel_export grants + export
-- emit but their expected-registry rows were never added (CI wasn't running).
-- All are first-class user data (Law 6). Columns mirror the live schema.
insert into expected_export_tables(table_name,allowed_columns,omitted_columns) values
 ('approval_tokens',array['token_id','household_id','actor_user_id','command','payload_sha256','normalized_payload','scope','account_id','proposal_kind','proposal_ref','proposal_version','policy_version','status','issued_at','expires_at','redeemed_at','redeemed_command_id','created_at'],'{}'),
 ('budget_expected_income',array['id','household_id','effective_month','end_month','amount_minor','currency','created_at'],'{}'),
 ('budget_targets',array['id','household_id','category_ledger_account_id','effective_month','end_month','target_kind','total_basis','amount_minor','percent_bp','rollover','currency','created_at'],'{}'),
 ('detected_paycheck_dismissals',array['household_id','id','series_id','employer_key','occurrence_date','dismissed_by','command_id','created_at'],'{}'),
 ('document_hashes',array['household_id','content_sha256','first_document_id','first_version_id','byte_size','created_at'],'{}'),
 ('expected_reimbursements',array['household_id','id','counterparty_id','source_transaction_id','expected_minor','currency','expected_date','description','status','created_by','created_at','updated_at'],'{}'),
 ('expected_reimbursement_receipts',array['household_id','id','expected_id','transaction_id','allocated_minor','status','note','created_by','created_at','updated_at'],'{}'),
 ('expected_reimbursement_status_events',array['household_id','id','expected_id','transition','reason','actor','command_id','created_at'],'{}'),
 ('paycheck_template_applications',array['household_id','id','series_id','deposit_txn_id','template_id','template_version','paycheck_id','approval_token_id','applied_from_suggestion_id','prior_offset_ledger_account_id','prior_amount_minor','applied_by','revoked_at','revoked_by','created_at'],'{}'),
 ('statement_drafts',array['id','household_id','document_version_id','account_id','source_hash','status','extraction_id','statement_id','decided_by','decided_at','created_at'],'{}'),
 ('statement_extractions',array['id','household_id','document_version_id','account_id','kind_hint','period_start','period_end','opening_minor','ending_minor','currency','extractor','extractor_version','model_version','prompt_version','confidence','raw_evidence','status','error_code','created_at'],'{}'),
 ('statement_extraction_lines',array['id','household_id','extraction_id','line_no','line_date','amount_minor','description_raw','currency','src_page','src_bbox','src_row','src_col','src_byte_offset','ofx_path','field_confidence','null_reason','created_at'],'{}'),
 ('statement_extraction_holdings',array['id','household_id','extraction_id','symbol','cusip','isin','name','qty','price_minor','value_minor','cost_basis_minor','currency','src_page','src_bbox','ofx_path','field_confidence','null_reason','created_at'],'{}');

insert into excluded_export_tables(table_name) values
  ('household_notes'), ('household_tasks');
-- household_ai_profile holds AI personalization prefs (not exported today; no
-- keel_export grant). regular_core_sweep_allowlist / _suppressions are internal
-- detector control tables (granted to keel_api/keel_worker only, not keel_export).
insert into excluded_export_tables(table_name) values
  ('household_ai_profile'), ('regular_core_sweep_allowlist'), ('regular_core_sweep_suppressions');
-- plaid_recurring_allowlist / plaid_recurring_streams (20260814100000) are the
-- same shape as the core-sweep pair above: a connection-id control table plus a
-- refetchable mirror of the PROVIDER's own detector output, granted to
-- keel_worker only. The user data they describe (the transactions themselves,
-- and from Phase 2 the recurring series) is already exported. Revisit if Phase
-- 2 makes a stream the user-visible provenance for a series.
insert into excluded_export_tables(table_name) values
  ('plaid_recurring_allowlist'), ('plaid_recurring_streams');

select has_role('keel_export', 'dedicated export role exists');
select ok(
  (select not rolcanlogin and not rolsuper and not rolbypassrls
     from pg_roles where rolname = 'keel_export'),
  'keel_export is NOLOGIN, non-superuser, and cannot bypass RLS'
);
select is(
  (select count(*)::int from expected_export_tables
    where has_table_privilege('keel_export', format('public.%I', table_name), 'SELECT')),
  97,
  'keel_export can SELECT all 97 included tables'
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
  97,
  'snapshot contains all 97 included table arrays'
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
