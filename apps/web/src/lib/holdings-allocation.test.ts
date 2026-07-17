import { describe, expect, it } from 'vitest';

import { allocationMix } from './holdings-allocation';
import type { HoldingRow } from './keel-api';

function holding(overrides: Partial<HoldingRow>): HoldingRow {
  return {
    holdingId: 'h-1',
    accountId: 'acct-1',
    asOf: '2026-07-18',
    symbol: 'VTI',
    name: null,
    qty: '10',
    priceMinor: '25100',
    valueMinor: '251000',
    costBasisMinor: null,
    currency: 'USD',
    source: 'plaid',
    securityType: 'equity',
    updatedAt: '2026-07-18T00:00:00.000000Z',
    ...overrides,
  };
}

describe('allocationMix', () => {
  it('buckets equity, etf, and mutual fund together as Equity', () => {
    const rows = [
      holding({ holdingId: 'a', securityType: 'equity', valueMinor: '10000' }),
      holding({ holdingId: 'b', securityType: 'etf', valueMinor: '20000' }),
      holding({ holdingId: 'c', securityType: 'mutual fund', valueMinor: '5000' }),
    ];
    expect(allocationMix(rows)).toEqual([{ name: 'Equity', totalMinor: '35000', currency: 'USD' }]);
  });

  it('buckets fixed income and cash into their own groups', () => {
    const rows = [
      holding({ holdingId: 'a', securityType: 'fixed income', valueMinor: '10000' }),
      holding({ holdingId: 'b', securityType: 'cash', valueMinor: '5000' }),
    ];
    expect(allocationMix(rows)).toEqual([
      { name: 'Fixed income', totalMinor: '10000', currency: 'USD' },
      { name: 'Cash', totalMinor: '5000', currency: 'USD' },
    ]);
  });

  it('buckets cryptocurrency, derivative, loan, and other as Other', () => {
    const rows = [
      holding({ holdingId: 'a', securityType: 'cryptocurrency', valueMinor: '1000' }),
      holding({ holdingId: 'b', securityType: 'derivative', valueMinor: '1000' }),
      holding({ holdingId: 'c', securityType: 'loan', valueMinor: '1000' }),
      holding({ holdingId: 'd', securityType: 'other', valueMinor: '1000' }),
    ];
    expect(allocationMix(rows)).toEqual([{ name: 'Other', totalMinor: '4000', currency: 'USD' }]);
  });

  it('buckets manual holdings (null securityType) and unrecognized types as Unclassified', () => {
    const rows = [
      holding({ holdingId: 'a', source: 'manual', securityType: null, valueMinor: '1000' }),
      holding({ holdingId: 'b', securityType: 'some_future_plaid_type', valueMinor: '2000' }),
    ];
    expect(allocationMix(rows)).toEqual([
      { name: 'Unclassified', totalMinor: '3000', currency: 'USD' },
    ]);
  });

  it('sorts buckets largest first', () => {
    const rows = [
      holding({ holdingId: 'a', securityType: 'cash', valueMinor: '1000' }),
      holding({ holdingId: 'b', securityType: 'equity', valueMinor: '5000' }),
      holding({ holdingId: 'c', securityType: 'fixed income', valueMinor: '3000' }),
    ];
    expect(allocationMix(rows).map((r) => r.name)).toEqual(['Equity', 'Fixed income', 'Cash']);
  });

  it('drops non-USD holdings rather than mixing currencies into one total', () => {
    const rows = [
      holding({ holdingId: 'a', currency: 'USD', securityType: 'equity', valueMinor: '10000' }),
      holding({ holdingId: 'b', currency: 'EUR', securityType: 'equity', valueMinor: '99999999' }),
    ];
    expect(allocationMix(rows)).toEqual([{ name: 'Equity', totalMinor: '10000', currency: 'USD' }]);
  });

  it('omits a bucket whose total is zero', () => {
    const rows = [holding({ securityType: 'equity', valueMinor: '0' })];
    expect(allocationMix(rows)).toEqual([]);
  });

  it('returns an empty array for no holdings', () => {
    expect(allocationMix([])).toEqual([]);
  });
});
