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
    outAccountId: 'acct-checking',
    outAccountName: 'Checking',
    inTxnId: 'in-1',
    inDescription: 'Transfer in',
    inAccountId: 'acct-savings',
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
    expect(groups[0]?.map((r) => r.linkId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps distinct account pairs in separate groups, preserving first-seen order', () => {
    const rows = [
      link({ linkId: 'a', outAccountId: 'acct-checking', inAccountId: 'acct-savings' }),
      link({ linkId: 'b', outAccountId: 'acct-biz-checking', inAccountId: 'acct-biz-savings' }),
      link({ linkId: 'c', outAccountId: 'acct-checking', inAccountId: 'acct-savings' }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((r) => r.linkId)).toEqual(['a', 'c']);
    expect(groups[1]?.map((r) => r.linkId)).toEqual(['b']);
  });

  it('treats the reverse direction as a different pair', () => {
    const rows = [
      link({ linkId: 'a', outAccountId: 'acct-checking', inAccountId: 'acct-savings' }),
      link({ linkId: 'b', outAccountId: 'acct-savings', inAccountId: 'acct-checking' }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(2);
  });

  it('does not merge two different accounts that happen to share a display name', () => {
    const rows = [
      link({
        linkId: 'a',
        outAccountId: 'acct-personal-checking',
        outAccountName: 'Checking',
        inAccountId: 'acct-personal-savings',
        inAccountName: 'Savings',
      }),
      link({
        linkId: 'b',
        outAccountId: 'acct-business-checking',
        outAccountName: 'Checking',
        inAccountId: 'acct-business-savings',
        inAccountName: 'Savings',
      }),
    ];
    const groups = groupTransfersByAccountPair(rows);
    expect(groups).toHaveLength(2);
  });

  it('returns an empty array for no rows', () => {
    expect(groupTransfersByAccountPair([])).toEqual([]);
  });
});
