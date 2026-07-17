import { describe, expect, it } from 'vitest';

import { resolveEditingAfterSave } from './txn-edit-guard';

describe('resolveEditingAfterSave', () => {
  it('clears the panel when the save that completed is for the row still open', () => {
    const rowA = { transactionId: 'txn-a' };
    expect(resolveEditingAfterSave(rowA, 'txn-a')).toBeNull();
  });

  it('review fix: ignores a stale completion from a row the user already switched away from', () => {
    // User opened row A, started a save, then switched to row B before A's
    // save resolved. A's completion must not close row B's panel.
    const rowB = { transactionId: 'txn-b' };
    expect(resolveEditingAfterSave(rowB, 'txn-a')).toBe(rowB);
  });

  it('is a no-op when nothing is currently open', () => {
    expect(resolveEditingAfterSave(null, 'txn-a')).toBeNull();
  });
});
