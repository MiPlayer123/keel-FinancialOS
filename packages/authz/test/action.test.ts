import { describe, expect, it } from 'vitest';
import type { HouseholdRole } from '@keel/contracts';
import {
  ACTIONS,
  ACTION_MINIMUM_ROLES,
  EXPORT_ACTIONS,
  READ_ACTIONS,
  WRITE_ACTIONS,
  isReadAction,
  isWriteAction,
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
      'connections.link',
      'connections.disconnect',
      'recurring.confirm',
      'recurring.pause',
      'recurring.resume',
      'recurring.cancel',
      'recurring.reject',
      'ledger.trial_balance',
      'transactions.list',
      'recurring.list',
      'audit.read',
      'admin.export_all',
    ]);
  });

  it('requires partner for recurring mutations and viewer for scoped recurring reads', () => {
    expect(ACTION_MINIMUM_ROLES['recurring.confirm']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.pause']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.resume']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.cancel']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.reject']).toBe('partner');
    expect(ACTION_MINIMUM_ROLES['recurring.list']).toBe('viewer');
  });

  it('maps ordinary reads to viewer, writes to partner, and export to owner', () => {
    for (const action of READ_ACTIONS.filter((action) => action !== 'admin.export_all')) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe('viewer');
    }

    for (const action of WRITE_ACTIONS) {
      expect(ACTION_MINIMUM_ROLES[action]).toBe('partner');
    }

    expect(EXPORT_ACTIONS).toEqual(['admin.export_all']);
    expect(ACTION_MINIMUM_ROLES['admin.export_all']).toBe('owner');
    expect(isReadAction('admin.export_all')).toBe(true);
    expect(isWriteAction('admin.export_all')).toBe(false);
  });
});

describe('role lattice', () => {
  it.each([
    { role: 'owner', read: true, write: true, export: true },
    { role: 'partner', read: true, write: true, export: false },
    { role: 'viewer', read: true, write: false, export: false },
    { role: 'professional', read: true, write: false, export: false },
  ] satisfies readonly { role: HouseholdRole; read: boolean; write: boolean; export: boolean }[])(
    '$role has the expected read/write/export access',
    ({ role, read, write, export: canExport }) => {
      expect(roleAtLeast(role, 'viewer')).toBe(read);
      expect(roleAtLeast(role, 'partner')).toBe(write);
      expect(roleAtLeast(role, 'owner')).toBe(canExport);
    },
  );
});
