import type { CommandName, HouseholdRole } from '@keel/contracts';

export const WRITE_ACTIONS = [
  'accounts.create',
  'ingest.record_raw_event',
  'ingest.promote_event',
  'journal.post_batch',
  'journal.reverse_batch',
  'connections.link',
  'connections.disconnect',
] as const satisfies readonly CommandName[];

export const READ_ACTIONS = ['ledger.trial_balance', 'transactions.list', 'audit.read'] as const;

export const ACTIONS = [...WRITE_ACTIONS, ...READ_ACTIONS] as const;

export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type ReadAction = (typeof READ_ACTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type MinimumRole = 'viewer' | 'partner';

/** Every known action has exactly one explicit minimum-role requirement. */
export const ACTION_MINIMUM_ROLES = {
  'accounts.create': 'partner',
  'ingest.record_raw_event': 'partner',
  'ingest.promote_event': 'partner',
  'journal.post_batch': 'partner',
  'journal.reverse_batch': 'partner',
  'connections.link': 'partner',
  'connections.disconnect': 'partner',
  'ledger.trial_balance': 'viewer',
  'transactions.list': 'viewer',
  'audit.read': 'viewer',
} as const satisfies Readonly<Record<Action, MinimumRole>>;

/**
 * Explicit Stage 1A role lattice. Professionals intentionally share viewer's
 * read capability and never satisfy the partner write requirement.
 */
const ROLE_LATTICE = {
  owner: { viewer: true, partner: true },
  partner: { viewer: true, partner: true },
  viewer: { viewer: true, partner: false },
  professional: { viewer: true, partner: false },
} as const satisfies Readonly<Record<HouseholdRole, Readonly<Record<MinimumRole, boolean>>>>;

export const roleAtLeast = (role: HouseholdRole, minimum: MinimumRole): boolean =>
  ROLE_LATTICE[role][minimum];

export const isReadAction = (action: Action): action is ReadAction =>
  ACTION_MINIMUM_ROLES[action] === 'viewer';

export const isWriteAction = (action: Action): action is WriteAction =>
  ACTION_MINIMUM_ROLES[action] === 'partner';
