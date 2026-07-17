import { describe, expect, it } from 'vitest';

import { groupTransfersByAccountPair } from './transfer-grouping';
import type { TransferLinkRow } from './keel-api';

function link(overrides: Partial<TransferLinkRow>): TransferLinkRow {
  return {
    linkId: 'link-1',
    status: 'suggested',
    effectiveDate: '2026-07-01',
    amountMinor: '10000',
    currency: 'USD',
    outTxnId: 'out-1',
    outDescription: 'Transfer out',
    outAccountName: 'Checking',
    inTxnId: 'in-1',
    inDescription: 'Transfer in',
    inAccountName: 'Savings',
    dayGap: 0,
    ...overrides,
  };
}

describe('groupTransfersByAccountPair', () => {
  it('groups repeated pairs on the same two accounts together', () => {
    const rows = [
      link({ linkId: 'a', effectiveDate: '2026-07-01' }),
      link({ linkId: 'b', effectiveDate: '2026-07-08' }),
      link({ linkId: 'c', effectiveDate: '2026-07-15' }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.linkId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps distinct account pairs in separate groups, preserving first-seen order', () => {
    const rows = [
      link({ linkId: 'a', outAccountName: 'Checking', inAccountName: 'Savings' }),
      link({ linkId: 'b', outAccountName: 'Business Checking', inAccountName: 'Business Savings' }),
      link({ linkId: 'c', outAccountName: 'Checking', inAccountName: 'Savings' }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((r) => r.linkId)).toEqual(['a', 'c']);
    expect(groups[1].map((r) => r.linkId)).toEqual(['b']);
  });

  it('treats the reverse direction as a different pair', () => {
    const rows = [
      link({ linkId: 'a', outAccountName: 'Checking', inAccountName: 'Savings' }),
      link({ linkId: 'b', outAccountName: 'Savings', inAccountName: 'Checking' }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(2);
  });

  it('returns an empty array for no rows', () => {
    expect(groupTransfersByAccountPair([])).toEqual([]);
  });
});
