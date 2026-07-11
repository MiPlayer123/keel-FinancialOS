import { describe, expect, it } from 'vitest';
import type { HouseholdRole } from '@keel/contracts';
import {
  ACTIONS,
  ACTION_MINIMUM_ROLES,
  READ_ACTIONS,
  WRITE_ACTIONS,
  roleAtLeast,
} from '../src/index.js';

describe('action vocabulary', () => {
  it('contains every Stage 1A command and read action', () => {
    expect(ACTIONS).toEqual([
      'accounts.create',
      'ingest.record_raw_event',
      'ingest.promote_event',
      'journal.post_batch',
      'journal.reverse_batch',
      'ledger.trial_balance',
      'transactions.list',
      'audit.read',
    ]);
  });

  it('maps reads to viewer and writes to partner', () => {
    for (const action of READ_ACTIONS) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe('viewer');
    }

    for (const action of WRITE_ACTIONS) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe('partner');
    }
  });
});

describe('role lattice', () => {
  it.each([
    { role: 'owner', read: true, write: true },
    { role: 'partner', read: true, write: true },
    { role: 'viewer', read: true, write: false },
    { role: 'professional', read: true, write: false },
  ] satisfies readonly { role: HouseholdRole; read: boolean; write: boolean }[])(
    '$role has the expected read/write access',
    ({ role, read, write }) => {
      expect(roleAtLeast(role, 'viewer')).toBe(read);
      expect(roleAtLeast(role, 'partner')).toBe(write);
    },
  );
});
