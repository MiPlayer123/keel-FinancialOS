import type { CommandName, HouseholdRole } from '@keel/contracts';

export const WRITE_ACTIONS = [
  'accounts.create',
  'ingest.record_raw_event',
  'ingest.promote_event',
  'journal.post_batch',
  'journal.reverse_batch',
  'connections.link',
  'connections.disconnect',
  'recurring.confirm',
  'recurring.pause',
  'recurring.resume',
  'recurring.cancel',
  'recurring.reject',
  'recurring.link_schedule',
  'recurring.unlink_schedule',
  'paychecks.create',
  'paychecks.edit',
  'paychecks.reverse',
  'paychecks.restore',
  'paychecks.dismiss_detected',
  'reimbursements.create_claim',
  'reimbursements.settle',
  'reimbursements.reverse_settlement',
  'reimbursements.reverse_claim',
  'statements.create',
  'statements.approve_draft',
  'statements.dismiss_draft',
  'statements.set_cadence',
  'statements.decide_payment_link',
  'statements.detach_payment_link',
  'statements.apply_holdings',
  'statements.unapply_holdings',
  'reconciliations.close',
  'reconciliations.reopen',
  'transactions.manual_create',
  'transactions.manual_void',
  'transactions.set_splits',
  'transactions.set_date',
  'accounts.dedupe_reconnect',
  'accounts.set_opening_balance',
  'accounts.reanchor_balance',
  'categorization.decide_suggestion',
  'documents.confirm_upload',
  'documents.detach',
  'documents.delete',
  'receipts.decide_match',
  'receipts.detach_match',
  'budgets.set_total',
  'budgets.set_target',
  'budgets.remove_target',
  'budgets.set_expected_income',
] as const satisfies readonly CommandName[];

export const EXPORT_ACTIONS = ['admin.export_all'] as const satisfies readonly CommandName[];

export const READ_ACTIONS = [
  'ledger.trial_balance',
  'transactions.list',
  'recurring.list',
  'recurring.classification',
  'recurring.schedule_links',
  'paychecks.list',
  'paychecks.detected_dismissals',
  'reimbursements.list',
  'statements.list',
  'statements.drafts',
  'statements.cadence',
  'statements.find_payment',
  'statements.payment_links',
  'statements.holdings_diff',
  'documents.list_for_target',
  'receipts.inbox',
  'budgets.month',
  'audit.read',
  // AI-agent read reconciliation (Law 7): every read the agent can perform is
  // an explicit, compiler-checked Action gated at viewer tier, not merely a
  // proc-side membership check. These query names already exist in
  // QUERY_TO_PROC and are read-only; the UI's /queries dispatch is unchanged
  // (it authorizes its own hardcoded subset), so adding them here is additive.
  'balances.latest',
  'categories.list',
  'entities.list',
  'budgets.list',
  'notes_tasks.list',
  'transfers.list',
  'transactions.rich',
  'transactions.rich_page',
  'transactions.search',
  'dashboard.net_worth',
  'dashboard.cash_flow',
  'dashboard.cash_flow_forecast',
  'holdings.list',
  'investments.overview',
  'goals.list',
  'rules.list',
  'tags.list',
  ...EXPORT_ACTIONS,
] as const;

export const ACTIONS = [...WRITE_ACTIONS, ...READ_ACTIONS] as const;

export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type ReadAction = (typeof READ_ACTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type MinimumRole = 'viewer' | 'partner' | 'owner';

/** Every known action has exactly one explicit minimum-role requirement. */
export const ACTION_MINIMUM_ROLES = {
  'accounts.create': 'partner',
  'ingest.record_raw_event': 'partner',
  'ingest.promote_event': 'partner',
  'journal.post_batch': 'partner',
  'journal.reverse_batch': 'partner',
  'connections.link': 'partner',
  'connections.disconnect': 'partner',
  'recurring.confirm': 'partner',
  'recurring.pause': 'partner',
  'recurring.resume': 'partner',
  'recurring.cancel': 'partner',
  'recurring.reject': 'partner',
  'recurring.link_schedule': 'partner',
  'recurring.unlink_schedule': 'partner',
  'paychecks.create': 'partner',
  'paychecks.edit': 'partner',
  'paychecks.reverse': 'partner',
  'paychecks.restore': 'partner',
  'paychecks.dismiss_detected': 'partner',
  'reimbursements.create_claim':'partner',
  'reimbursements.settle':'partner',
  'reimbursements.reverse_settlement':'partner',
  'reimbursements.reverse_claim':'partner',
  'statements.create':'partner','statements.approve_draft':'partner','statements.dismiss_draft':'partner','statements.set_cadence':'partner','statements.decide_payment_link':'partner','statements.detach_payment_link':'partner','statements.apply_holdings':'partner','statements.unapply_holdings':'partner','reconciliations.close':'partner','reconciliations.reopen':'partner',
  'transactions.manual_create': 'partner',
  'transactions.manual_void': 'partner',
  'transactions.set_splits': 'partner',
  'transactions.set_date': 'partner',
  'accounts.dedupe_reconnect': 'partner',
  'accounts.set_opening_balance': 'partner',
  'accounts.reanchor_balance': 'partner',
  'categorization.decide_suggestion': 'partner',
  'documents.confirm_upload': 'partner',
  'documents.detach': 'partner',
  'documents.delete': 'partner',
  'receipts.decide_match': 'partner',
  'receipts.detach_match': 'partner',
  'budgets.set_total': 'partner',
  'budgets.set_target': 'partner',
  'budgets.remove_target': 'partner',
  'budgets.set_expected_income': 'partner',
  'budgets.month': 'viewer',
  'ledger.trial_balance': 'viewer',
  'transactions.list': 'viewer',
  'recurring.list': 'viewer',
  'recurring.classification': 'viewer',
  'recurring.schedule_links': 'viewer',
  'paychecks.list': 'viewer',
  'paychecks.detected_dismissals': 'viewer',
  'reimbursements.list':'viewer',
  'statements.list':'viewer',
  'statements.drafts':'viewer',
  'statements.cadence':'viewer',
  'statements.find_payment':'viewer',
  'statements.payment_links':'viewer',
  'statements.holdings_diff':'viewer',
  'documents.list_for_target': 'viewer',
  'receipts.inbox': 'viewer',
  'audit.read': 'viewer',
  // AI-agent read reconciliation (viewer tier — see READ_ACTIONS above).
  'balances.latest': 'viewer',
  'categories.list': 'viewer',
  'entities.list': 'viewer',
  'budgets.list': 'viewer',
  'notes_tasks.list': 'viewer',
  'transfers.list': 'viewer',
  'transactions.rich': 'viewer',
  'transactions.rich_page': 'viewer',
  'transactions.search': 'viewer',
  'dashboard.net_worth': 'viewer',
  'dashboard.cash_flow': 'viewer',
  'dashboard.cash_flow_forecast': 'viewer',
  'holdings.list': 'viewer',
  'investments.overview': 'viewer',
  'goals.list': 'viewer',
  'rules.list': 'viewer',
  'tags.list': 'viewer',
  'admin.export_all': 'owner',
} as const satisfies Readonly<Record<Action, MinimumRole>>;

/**
 * Explicit Stage 1A role lattice. Professionals intentionally share viewer's
 * read capability and never satisfy the partner write requirement.
 */
const ROLE_LATTICE = {
  owner: { viewer: true, partner: true, owner: true },
  partner: { viewer: true, partner: true, owner: false },
  viewer: { viewer: true, partner: false, owner: false },
  professional: { viewer: true, partner: false, owner: false },
} as const satisfies Readonly<Record<HouseholdRole, Readonly<Record<MinimumRole, boolean>>>>;

export const roleAtLeast = (role: HouseholdRole, minimum: MinimumRole): boolean =>
  ROLE_LATTICE[role][minimum];

export const isReadAction = (action: Action): action is ReadAction =>
  (READ_ACTIONS as readonly Action[]).includes(action);

export const isWriteAction = (action: Action): action is WriteAction =>
  (WRITE_ACTIONS as readonly Action[]).includes(action);
