export interface IncludedTableDefinition {
  readonly schema: 'public';
  readonly table: string;
  readonly columns: readonly string[];
  readonly sortKey: readonly string[];
  readonly timestampColumns: readonly string[];
  readonly bigintColumns: readonly string[];
  readonly omittedColumns?: Readonly<Record<string, string>>;
}

const include = <const T extends IncludedTableDefinition>(definition: T): T => definition;

/**
 * Audited export contract. This is deliberately data rather than scattered
 * query knowledge so schema additions fail completeness checks until ruled.
 */
export const INCLUDE = [
  include({ schema: 'public', table: 'households', columns: ['id', 'name', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'entities', columns: ['id', 'household_id', 'name', 'kind', 'created_at', 'archived_at'], sortKey: ['id'], timestampColumns: ['created_at', 'archived_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'household_memberships', columns: ['household_id', 'user_id', 'role', 'created_at'], sortKey: ['household_id', 'user_id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'entity_memberships', columns: ['entity_id', 'user_id', 'created_at'], sortKey: ['entity_id', 'user_id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'accounts', columns: ['id', 'household_id', 'entity_id', 'connection_id', 'ledger_account_id', 'name', 'subtype', 'currency', 'external_ref', 'created_at', 'archived_at'], sortKey: ['id'], timestampColumns: ['created_at', 'archived_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'account_owners', columns: ['account_id', 'user_id', 'created_at'], sortKey: ['account_id', 'user_id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'ledger_accounts', columns: ['id', 'household_id', 'entity_id', 'name', 'kind', 'currency', 'is_category', 'created_at', 'archived_at', 'pfc_key', 'is_system', 'parent_ledger_account_id', 'tax_line'], sortKey: ['id'], timestampColumns: ['created_at', 'archived_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'connections', columns: ['id', 'household_id', 'provider', 'external_ref', 'status', 'created_at', 'institution_id', 'consent_expires_at', 'last_successful_sync_at', 'sync_lease_owner', 'sync_leased_until', 'sync_desired_generation', 'sync_committed_generation', 'next_sync_eligible_at', 'display_name', 'sync_continuation_pending', 'sync_continuation_marked_at'], sortKey: ['id'], timestampColumns: ['created_at', 'consent_expires_at', 'last_successful_sync_at', 'sync_leased_until', 'next_sync_eligible_at', 'sync_continuation_marked_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'resource_permissions', columns: ['id', 'household_id', 'user_id', 'resource_kind', 'resource_id', 'permission', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'approval_policies', columns: ['id', 'household_id', 'risk_class', 'autonomy', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'canonical_transactions', columns: ['id', 'household_id', 'entity_id', 'account_id', 'status', 'source', 'description', 'effective_date', 'economic_event_key', 'created_at', 'voided_at'], sortKey: ['id'], timestampColumns: ['created_at', 'voided_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'journal_batches', columns: ['id', 'household_id', 'canonical_transaction_id', 'description', 'effective_date', 'reverses_batch_id', 'command_id', 'posted_at'], sortKey: ['id'], timestampColumns: ['posted_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'journal_postings', columns: ['id', 'batch_id', 'ledger_account_id', 'entity_id', 'amount_minor', 'currency'], sortKey: ['id'], timestampColumns: [], bigintColumns: ['amount_minor'] }),
  include({ schema: 'public', table: 'journal_revisions', columns: ['id', 'original_batch_id', 'reversal_batch_id', 'replacement_batch_id', 'reason', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'period_locks', columns: ['id', 'household_id', 'entity_id', 'start_date', 'end_date', 'locked_by', 'locked_at', 'reopened_at', 'reopen_reason'], sortKey: ['id'], timestampColumns: ['locked_at', 'reopened_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'transaction_source_links', columns: ['canonical_transaction_id', 'normalized_source_record_id', 'created_at', 'household_id'], sortKey: ['canonical_transaction_id', 'normalized_source_record_id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'transfer_links', columns: ['id', 'household_id', 'txn_out', 'txn_in', 'status', 'decided_by', 'decided_at', 'created_at'], sortKey: ['id'], timestampColumns: ['decided_at', 'created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'transaction_categories', columns: ['canonical_transaction_id', 'household_id', 'category_ledger_account_id', 'source', 'rule_id', 'created_at', 'updated_at'], sortKey: ['canonical_transaction_id'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'category_rules', columns: ['id', 'household_id', 'entity_id', 'matcher', 'pattern', 'category_ledger_account_id', 'rename_to', 'priority', 'active', 'created_at', 'updated_at', 'amount_min_minor', 'amount_max_minor'], sortKey: ['id'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: ['amount_min_minor', 'amount_max_minor'] }),
  include({ schema: 'public', table: 'rule_renames', columns: ['canonical_transaction_id', 'household_id', 'rule_id', 'display_name', 'created_at', 'updated_at'], sortKey: ['canonical_transaction_id'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'category_suggestions', columns: ['id', 'household_id', 'canonical_transaction_id', 'suggested_category_ledger_account_id', 'source', 'reason_code', 'evidence', 'status', 'created_at', 'decided_at', 'decided_by'], sortKey: ['id'], timestampColumns: ['created_at', 'decided_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'budgets', columns: ['household_id', 'category_ledger_account_id', 'month', 'amount_minor', 'currency', 'created_at', 'updated_at', 'rollover'], sortKey: ['household_id', 'category_ledger_account_id', 'month'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: ['amount_minor'] }),
  include({ schema: 'public', table: 'tags', columns: ['id', 'household_id', 'name', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'transaction_tags', columns: ['canonical_transaction_id', 'tag_id', 'household_id', 'created_at'], sortKey: ['canonical_transaction_id', 'tag_id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'scheduled_transactions', columns: ['id', 'household_id', 'account_id', 'description', 'amount_minor', 'currency', 'category_ledger_account_id', 'frequency', 'next_due_date', 'auto_enter_days', 'status', 'created_at', 'anchor_day'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: ['amount_minor'] }),
  include({ schema: 'public', table: 'savings_goals', columns: ['id', 'household_id', 'name', 'target_minor', 'target_date', 'account_id', 'currency', 'status', 'created_at', 'kind', 'start_balance_minor'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: ['target_minor', 'start_balance_minor'] }),
  include({ schema: 'public', table: 'goal_contributions', columns: ['id', 'goal_id', 'household_id', 'amount_minor', 'contributed_on', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: ['amount_minor'] }),
  include({ schema: 'public', table: 'transaction_overrides', columns: ['canonical_transaction_id', 'household_id', 'display_description', 'note', 'created_at', 'updated_at'], sortKey: ['canonical_transaction_id'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'raw_provider_events', columns: ['id', 'household_id', 'connection_id', 'provider', 'provider_event_id', 'account_external_ref', 'received_at', 'recorded_at', 'body_text', 'body_sha256'], sortKey: ['id'], timestampColumns: ['received_at', 'recorded_at'], bigintColumns: [], omittedColumns: { body: 'Parsed convenience copy omitted; body_text is the exact immutable source.' } }),
  include({ schema: 'public', table: 'normalized_source_records', columns: ['id', 'raw_event_id', 'household_id', 'account_id', 'provider_transaction_id', 'amount_minor', 'currency', 'effective_date', 'description', 'pending', 'pending_transaction_ref', 'created_at', 'kind'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: ['amount_minor'], omittedColumns: { pfc_primary: 'Denormalized PFC convenience copy omitted; the exported raw event body_text is the exact immutable source.' } }),
  include({ schema: 'public', table: 'import_batches', columns: ['id', 'household_id', 'account_id', 'source_kind', 'filename', 'row_count', 'created_at', 'committed_at', 'rolled_back_at'], sortKey: ['id'], timestampColumns: ['created_at', 'committed_at', 'rolled_back_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'import_rows', columns: ['id', 'import_batch_id', 'row_number', 'raw', 'created_at'], sortKey: ['import_batch_id', 'row_number', 'id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'ingestion_skips', columns: ['id', 'household_id', 'connection_id', 'raw_event_id', 'provider_transaction_id', 'currency', 'reason', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'account_lineage', columns: ['id', 'household_id', 'account_id', 'event_type', 'previous_state', 'new_state', 'occurred_at'], sortKey: ['id'], timestampColumns: ['occurred_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'balance_snapshots', columns: ['id', 'household_id', 'account_id', 'as_of', 'available_minor', 'current_minor', 'limit_minor', 'currency', 'source', 'snapshot_metadata', 'created_at'], sortKey: ['id'], timestampColumns: ['as_of', 'created_at'], bigintColumns: ['available_minor', 'current_minor', 'limit_minor'] }),
  include({ schema: 'public', table: 'connection_health_events', columns: ['id', 'household_id', 'connection_id', 'event_type', 'severity', 'details', 'occurred_at'], sortKey: ['id'], timestampColumns: ['occurred_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'audit_log', columns: ['id', 'household_id', 'actor', 'action', 'object_type', 'object_id', 'command_id', 'before', 'after', 'at'], sortKey: ['id'], timestampColumns: ['at'], bigintColumns: ['id'] }),
  include({ schema: 'public', table: 'domain_events', columns: ['id', 'event_type', 'household_id', 'command_id', 'economic_event_key', 'actor', 'occurred_at', 'payload'], sortKey: ['id'], timestampColumns: ['occurred_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'command_executions', columns: ['household_id', 'economic_event_key', 'command', 'payload_sha256', 'result', 'executed_at'], sortKey: ['household_id', 'economic_event_key'], timestampColumns: ['executed_at'], bigintColumns: [], omittedColumns: { command_id: 'Redundant execution transport identifier; economic_event_key is the portable idempotency identity.' } }),
  include({ schema: 'public', table: 'recurring_detector_runs', columns: ['id', 'household_id', 'run_key', 'as_of', 'detector_version', 'confidence_version', 'normalizer_version', 'candidate_snapshot_hash', 'created_at'], sortKey: ['id'], timestampColumns: ['as_of', 'created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'recurring_series', columns: ['id', 'household_id', 'series_key', 'account_id', 'ledger_account_id', 'counterparty_key', 'currency', 'sign', 'status', 'current_candidate_version_id', 'confirmed_by', 'confirmed_at', 'created_at', 'updated_at'], sortKey: ['id'], timestampColumns: ['confirmed_at', 'created_at', 'updated_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'recurring_candidate_versions', columns: ['id', 'household_id', 'series_id', 'detector_run_id', 'candidate_hash', 'input_fingerprint', 'detector_version', 'confidence_version', 'normalizer_version', 'as_of', 'score_bps', 'evidence', 'candidate', 'created_at'], sortKey: ['id'], timestampColumns: ['as_of', 'created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'recurring_occurrences', columns: ['household_id', 'id', 'series_id', 'candidate_version_id', 'occurrence_key', 'expected_date', 'expected_amount_minor', 'currency', 'amount_kind', 'status', 'matched_txn_id', 'score_bps', 'evidence', 'input_fingerprint', 'detector_version', 'confidence_version', 'as_of', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['as_of', 'created_at'], bigintColumns: ['expected_amount_minor'] }),
  include({ schema: 'public', table: 'recurring_status_events', columns: ['household_id', 'id', 'series_id', 'candidate_version_id', 'transition', 'effective_date', 'actor', 'command_id', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'employers', columns: ['id', 'household_id', 'name', 'created_at'], sortKey: ['id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'payroll_provider_imports', columns: ['id', 'household_id', 'provider', 'source_ref', 'content_hash', 'imported_at'], sortKey: ['id'], timestampColumns: ['imported_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'paychecks', columns: ['id', 'household_id', 'employer_id', 'pay_date', 'gross_minor', 'net_minor', 'currency', 'status', 'formula_version', 'created_by', 'created_at', 'updated_at', 'superseded_by_paycheck_id'], sortKey: ['id'], timestampColumns: ['created_at', 'updated_at'], bigintColumns: ['gross_minor', 'net_minor'] }),
  include({ schema: 'public', table: 'paycheck_components', columns: ['household_id', 'id', 'paycheck_id', 'component_key', 'kind', 'amount_minor', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: ['amount_minor'] }),
  include({ schema: 'public', table: 'paycheck_templates', columns: ['household_id', 'id', 'employer_id', 'template_version', 'component_blueprint', 'formula_version', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'paycheck_sources', columns: ['household_id', 'id', 'paycheck_id', 'source_kind', 'source_ref', 'content_hash', 'payroll_provider_import_id', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema: 'public', table: 'paycheck_transaction_matches', columns: ['household_id', 'id', 'paycheck_id', 'component_id', 'transaction_id', 'allocated_minor', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: ['allocated_minor'] }),
  include({ schema: 'public', table: 'paycheck_status_events', columns: ['household_id', 'id', 'paycheck_id', 'transition', 'reason', 'actor', 'command_id', 'created_at'], sortKey: ['household_id', 'id'], timestampColumns: ['created_at'], bigintColumns: [] }),
  include({ schema:'public',table:'counterparties',columns:['id','household_id','name','kind','created_at'],sortKey:['id'],timestampColumns:['created_at'],bigintColumns:[] }),
  include({ schema:'public',table:'expense_shares',columns:['household_id','id','original_transaction_id','counterparty_id','amount_minor','currency','description','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['amount_minor'] }),
  include({ schema:'public',table:'reimbursement_claims',columns:['household_id','id','expense_share_id','counterparty_id','original_transaction_id','amount_minor','currency','status','created_by','created_at','updated_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['amount_minor'] }),
  include({ schema:'public',table:'settlements',columns:['household_id','id','counterparty_id','transaction_id','total_minor','currency','status','note','created_by','created_at','updated_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['total_minor'] }),
  include({ schema:'public',table:'settlement_matches',columns:['household_id','id','settlement_id','claim_id','allocated_minor','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['allocated_minor'] }),
  include({ schema:'public',table:'refund_expectations',columns:['household_id','id','original_transaction_id','expected_minor','currency','evidence','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['expected_minor'] }),
  include({ schema:'public',table:'refund_matches',columns:['household_id','id','expectation_id','transaction_id','allocated_minor','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['allocated_minor'] }),
  include({ schema:'public',table:'settlement_status_events',columns:['household_id','id','settlement_id','transition','reason','actor','command_id','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:[] }),
  include({ schema:'public',table:'reimbursement_claim_status_events',columns:['household_id','id','claim_id','transition','reason','actor','command_id','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:[] }),
  include({schema:'public',table:'statements',columns:['id','household_id','account_id','period_start','period_end','opening_minor','ending_minor','currency','source_hash','created_by','created_at'],sortKey:['id'],timestampColumns:['created_at'],bigintColumns:['opening_minor','ending_minor']}),
  include({schema:'public',table:'statement_lines',columns:['household_id','id','statement_id','line_key','line_date','amount_minor','description','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['amount_minor']}),
  include({schema:'public',table:'reconciliation_sessions',columns:['household_id','id','statement_id','account_id','ledger_ending_minor','difference_minor','status','formula_version','period_lock_id','closed_by','closed_at','reopened_at','created_at'],sortKey:['household_id','id'],timestampColumns:['closed_at','reopened_at','created_at'],bigintColumns:['ledger_ending_minor','difference_minor']}),
  include({schema:'public',table:'reconciliation_items',columns:['household_id','id','session_id','statement_line_id','resolution','transaction_id','explanation','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:[]}),
  include({schema:'public',table:'reconciliation_adjustments',columns:['household_id','id','session_id','kind','amount_minor','explanation','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:['amount_minor']}),
  include({schema:'public',table:'close_checklists',columns:['household_id','id','session_id','checklist_version','checks','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:[]}),
  include({schema:'public',table:'reconciliation_status_events',columns:['household_id','id','session_id','transition','reason','actor','command_id','created_at'],sortKey:['household_id','id'],timestampColumns:['created_at'],bigintColumns:[]}),
] as const;

export type ExportTableName = (typeof INCLUDE)[number]['table'];

export interface ExcludedTableDefinition {
  readonly schema: 'public' | 'auth';
  readonly table: string;
  readonly reason: string;
}

export const EXCLUDE = [
  { schema: 'public', table: 'connection_credentials', reason: 'Law 12: encrypted provider credential and wrapped key material are never portable.' },
  { schema: 'public', table: 'plaid_webhook_keys', reason: 'Operational provider verification-key cache; may contain private JWK material if malformed.' },
  { schema: 'public', table: 'webhook_rejections', reason: 'Cross-tenant operational quarantine and rejected request bytes, not household finance data.' },
  { schema: 'public', table: 'webhook_rejection_counters', reason: 'Global operational abuse-prevention counter, not household finance data.' },
  { schema: 'public', table: 'provider_call_budget', reason: 'Global provider circuit-breaker state, not household finance data.' },
  { schema: 'public', table: 'usage_events', reason: 'Operational metering includes null-household system telemetry and is excluded wholesale.' },
  { schema: 'public', table: 'plaid_test_responses', reason: 'Hermetic provider test fixture table; never user data.' },
  { schema: 'public', table: 'plaid_webhook_key_test_responses', reason: 'Hermetic webhook-key test fixture table; never user data.' },
  { schema: 'public', table: 'sync_test_pages', reason: 'Hermetic sync test fixture table; never user data.' },
  { schema: 'public', table: 'sync_attempts', reason: 'Transient provider synchronization execution state and cursors.' },
  { schema: 'public', table: 'sync_checkpoints', reason: 'Transient provider cursor state; raw evidence and ledger history are portable instead.' },
  { schema: 'public', table: 'link_attempts', reason: 'Transient connection workflow state that can contain credential envelope material.' },
  { schema: 'public', table: 'removal_attempts', reason: 'Transient provider disconnection workflow state, not portable finance history.' },
  { schema: 'public', table: 'recurring_detection_claims', reason: 'Transient idempotent cron enqueue claims, not recurring financial history.' },
  { schema: 'auth', table: 'users', reason: 'Auth identities and secrets are excluded; household membership user_id mappings remain portable.' },
] as const satisfies readonly ExcludedTableDefinition[];

export const ALL_PUBLIC_TABLES = [
  ...INCLUDE.map((entry) => entry.table),
  ...EXCLUDE.filter((entry) => entry.schema === 'public').map((entry) => entry.table),
].sort();
