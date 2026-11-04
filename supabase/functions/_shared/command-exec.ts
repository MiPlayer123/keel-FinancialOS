/**
 * The typed command path every surface uses to mutate canonical truth
 * (INFRA §5, Law 7): validate envelope → validate payload against its
 * contract → fail-closed authz → the command's SECURITY DEFINER proc through
 * the CALLER's client (the proc re-checks membership via auth.uid() and runs
 * atomically with its audit + domain events).
 *
 * Shared by `api` (`/commands`) and `mcp` (write tools), so both surfaces run
 * the identical validation and authorization. Self-contained by the _shared
 * convention: the domain contract helpers are injected by the index files.
 */

export const COMMAND_TO_PROC: Readonly<Record<string, string>> = {
  'accounts.create': 'keel_cmd_create_account',
  'ingest.record_raw_event': 'keel_cmd_record_raw_event',
  'ingest.promote_event': 'keel_cmd_promote_event',
  'journal.post_batch': 'keel_cmd_post_batch',
  'journal.reverse_batch': 'keel_cmd_reverse_batch',
  'recurring.confirm': 'keel_recurring_confirm',
  'recurring.pause': 'keel_recurring_pause',
  'recurring.resume': 'keel_recurring_resume',
  'recurring.cancel': 'keel_recurring_cancel',
  'recurring.reject': 'keel_recurring_reject',
  'recurring.reclassify_cadence': 'keel_recurring_reclassify_cadence',
  'recurring.set_amount': 'keel_recurring_set_amount',
  'recurring.link_schedule': 'keel_recurring_link_schedule',
  'recurring.unlink_schedule': 'keel_recurring_unlink_schedule',
  'paychecks.create': 'keel_paycheck_create',
  'paychecks.edit': 'keel_paycheck_edit',
  'paychecks.reverse': 'keel_paycheck_reverse',
  'paychecks.restore': 'keel_paycheck_restore',
  'paychecks.dismiss_detected': 'keel_cmd_dismiss_detected_paycheck',
  'paychecks.save_template': 'keel_cmd_paycheck_save_template',
  'paychecks.set_series_settings': 'keel_cmd_paycheck_set_series_settings',
  'paychecks.apply_template': 'keel_cmd_paycheck_apply_template',
  'paychecks.unapply': 'keel_cmd_paycheck_unapply',
  'reimbursements.create_claim': 'keel_reimbursement_create_claim',
  'reimbursements.settle': 'keel_reimbursement_settle',
  'reimbursements.reverse_settlement': 'keel_reimbursement_reverse_settlement',
  'reimbursements.reverse_claim': 'keel_reimbursement_reverse_claim',
  'expected_reimbursements.create': 'keel_expected_reimbursement_create',
  'expected_reimbursements.record_receipt': 'keel_expected_reimbursement_record_receipt',
  'expected_reimbursements.write_off': 'keel_expected_reimbursement_write_off',
  'expected_reimbursements.reopen': 'keel_expected_reimbursement_reopen',
  'expected_reimbursements.reverse_receipt': 'keel_expected_reimbursement_reverse_receipt',
  'statements.create': 'keel_statement_create',
  'statements.approve_draft': 'keel_cmd_statements_approve_draft',
  'statements.dismiss_draft': 'keel_cmd_statements_dismiss_draft',
  'statements.set_cadence': 'keel_statement_set_cadence',
  'statements.decide_payment_link': 'keel_cmd_statements_decide_payment_link',
  'statements.detach_payment_link': 'keel_cmd_statements_detach_payment_link',
  'statements.apply_holdings': 'keel_cmd_statements_apply_holdings',
  'statements.unapply_holdings': 'keel_cmd_statements_unapply_holdings',
  'reconciliations.close': 'keel_reconciliation_close',
  'reconciliations.reopen': 'keel_reconciliation_reopen',
  'transactions.manual_create': 'keel_cmd_manual_transaction',
  'transactions.manual_void': 'keel_cmd_manual_void',
  'transactions.set_splits': 'keel_cmd_set_splits',
  'transactions.set_date': 'keel_cmd_set_date',
  'accounts.dedupe_reconnect': 'keel_cmd_dedupe_reconnect_account',
  'accounts.dedupe_archived': 'keel_cmd_dedupe_archived_duplicates',
  'accounts.set_opening_balance': 'keel_cmd_set_opening_balance',
  'accounts.reanchor_balance': 'keel_cmd_reanchor_balance',
  'categorization.decide_suggestion': 'keel_cmd_decide_category_suggestion',
  'documents.attach': 'keel_cmd_documents_attach',
  'documents.detach': 'keel_cmd_documents_detach',
  'documents.delete': 'keel_cmd_documents_delete',
  'receipts.decide_match': 'keel_cmd_receipts_decide_match',
  'receipts.detach_match': 'keel_cmd_receipts_detach_match',
  'budgets.set_total': 'keel_cmd_budgets_set_total',
  'budgets.set_target': 'keel_cmd_budgets_set_target',
  'budgets.remove_target': 'keel_cmd_budgets_remove_target',
  'budgets.set_expected_income': 'keel_cmd_budgets_set_expected_income',
};

// deno-lint-ignore no-explicit-any
type UserClient = any;

export interface CommandEnvelope {
  readonly commandId: string;
  readonly command: string;
  readonly economicEventKey: string;
  readonly actor: unknown;
  readonly householdId: string;
  readonly payload: Record<string, unknown>;
}

/** Domain contract helpers, injected from the vendored domain bundle. */
export interface CommandContract {
  readonly parseEnvelope: (
    body: unknown,
  ) => { success: true; data: CommandEnvelope } | { success: false; error: { issues: unknown } };
  /** Throws when the payload fails its command's schema. */
  readonly parsePayload: (command: string, payload: unknown) => unknown;
  readonly authorize: (
    ctx: unknown,
    action: string,
    resource: Record<string, unknown>,
  ) => { allowed: true } | { allowed: false; code: string; reason: string };
  readonly isEntityId: (value: unknown) => boolean;
  readonly isAccountId: (value: unknown) => boolean;
  readonly toSnakeKeys: (value: unknown) => unknown;
}

export type CommandOutcome =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
  | { readonly ok: false; readonly dbError: { code?: string; message?: string } };

const fail = (status: number, code: string, message: string, details: Record<string, unknown> = {}): CommandOutcome => ({
  ok: false,
  status,
  code,
  message,
  details,
});

export const executeCommand = async (
  contract: CommandContract,
  supabase: UserClient,
  loadAuthz: () => Promise<unknown>,
  body: unknown,
): Promise<CommandOutcome> => {
  const envelope = contract.parseEnvelope(body);
  if (!envelope.success) {
    return fail(400, 'invalid_command', 'Envelope failed validation.', { issues: envelope.error.issues });
  }
  const { command, householdId } = envelope.data;
  const proc = COMMAND_TO_PROC[command];
  if (!proc) return fail(400, 'invalid_command', 'Unknown command.');

  let payload: Record<string, unknown>;
  try {
    payload = contract.parsePayload(command, envelope.data.payload) as Record<string, unknown>;
  } catch {
    return fail(400, 'invalid_command', 'Payload failed validation.');
  }

  // recurring.* commands that name a series gate on that series' account.
  // recurring.unlink_schedule names only a linkId — it falls through to the
  // household check here and the DB proc re-checks the series behind the link.
  let recurringAccountId: string | undefined;
  if (command.startsWith('recurring.') && typeof payload['seriesId'] === 'string') {
    const { data, error } = await supabase.rpc('keel_list_recurring', { p_household_id: householdId });
    if (error) return { ok: false, dbError: error };
    const series = ((data?.rows ?? []) as { seriesId?: string; accountId?: string }[]).find(
      (row) => row.seriesId === payload['seriesId'],
    );
    if (!series?.accountId) return fail(404, 'not_found', 'Not found.');
    recurringAccountId = series.accountId;
  }

  const resource: Record<string, unknown> = {
    householdId,
    ...(recurringAccountId ? { kind: 'recurring_series', accountId: recurringAccountId } : {}),
    ...(contract.isEntityId(payload['entityId']) ? { entityId: payload['entityId'] } : {}),
    ...(contract.isAccountId(payload['accountId']) ? { accountId: payload['accountId'] } : {}),
  };
  const decision = contract.authorize(await loadAuthz(), command, resource);
  if (!decision.allowed) {
    // Scope violations answer not_found — never confirm existence cross-tenant.
    return decision.code === 'household_scope_violation'
      ? fail(404, 'not_found', 'Not found.')
      : fail(403, 'not_authorized', decision.reason);
  }

  const { data, error } = await supabase.rpc(proc, {
    p_command_id: envelope.data.commandId,
    p_economic_event_key: envelope.data.economicEventKey,
    p_actor: envelope.data.actor,
    p_household_id: householdId,
    p_payload: contract.toSnakeKeys(payload),
  });
  if (error) return { ok: false, dbError: error };
  return { ok: true, data };
};
