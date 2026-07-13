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
  'paychecks.create',
  'paychecks.reverse',
  'paychecks.restore',
  'reimbursements.create_claim',
  'reimbursements.settle',
  'reimbursements.reverse_settlement',
  'reimbursements.reverse_claim',
  'statements.create',
  'reconciliations.close',
  'reconciliations.reopen',
  'transactions.manual_create',
  'transactions.manual_void',
] as const satisfies readonly CommandName[];

export const EXPORT_ACTIONS = ['admin.export_all'] as const satisfies readonly CommandName[];

export const READ_ACTIONS = [
  'ledger.trial_balance',
  'transactions.list',
  'recurring.list',
  'paychecks.list',
  'reimbursements.list',
  'statements.list',
  'audit.read',
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
  'paychecks.create': 'partner',
  'paychecks.reverse': 'partner',
  'paychecks.restore': 'partner',
  'reimbursements.create_claim':'partner',
  'reimbursements.settle':'partner',
  'reimbursements.reverse_settlement':'partner',
  'reimbursements.reverse_claim':'partner',
  'statements.create':'partner','reconciliations.close':'partner','reconciliations.reopen':'partner',
  'transactions.manual_create': 'partner',
  'transactions.manual_void': 'partner',
  'ledger.trial_balance': 'viewer',
  'transactions.list': 'viewer',
  'recurring.list': 'viewer',
  'paychecks.list': 'viewer',
  'reimbursements.list':'viewer',
  'statements.list':'viewer',
  'audit.read': 'viewer',
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
