import { describe, expect, it } from 'vitest';

import { currencyTotals, primaryCurrencyTotal } from '@/lib/currency-totals';

describe('currencyTotals', () => {
  it('never combines minor units from different currencies', () => {
    expect(
      currencyTotals([
        { amountMinor: '12500', currency: 'USD' },
        { amountMinor: '-2500', currency: 'USD' },
        { amountMinor: '9000', currency: 'EUR' },
      ]),
    ).toEqual([
      { amountMinor: '10000', currency: 'USD', rowCount: 2 },
      { amountMinor: '9000', currency: 'EUR', rowCount: 1 },
    ]);
  });

  it('chooses the most common currency without converting it', () => {
    expect(
      primaryCurrencyTotal([
        { amountMinor: '500', currency: 'EUR' },
        { amountMinor: '1200', currency: 'USD' },
        { amountMinor: '-200', currency: 'USD' },
      ]),
    ).toEqual({
      amountMinor: '1000',
      currency: 'USD',
      rowCount: 2,
    });
  });

  it('returns null for an empty collection', () => {
    expect(primaryCurrencyTotal([])).toBeNull();
  });
});
