import { describe, expect, it } from 'vitest';

import type { RichTransactionRow } from '@/lib/keel-api';
import { monthPace } from '@/lib/month-pace';

let n = 0;
function txn(o: Partial<RichTransactionRow>): RichTransactionRow {
  n += 1;
  return {
    transactionId: `t${String(n)}`,
    effectiveDate: '2026-11-01',
    description: 'Fictional Shop',
    status: 'posted',
    accountId: 'a1',
    accountName: 'Checking',
    amountMinor: '-1000',
    currency: 'USD',
    categoryLedgerAccountId: 'c-food',
    categoryName: 'Groceries',
    categoryKind: 'expense',
    ...o,
  };
}

describe('monthPace', () => {
  it('compares month-to-date with the same day last month', () => {
    const p = monthPace(
      [
        txn({ effectiveDate: '2026-11-01', amountMinor: '-500' }),
        txn({ effectiveDate: '2026-11-02', amountMinor: '-300' }),
        txn({ effectiveDate: '2026-10-02', amountMinor: '-200' }),
        txn({ effectiveDate: '2026-10-20', amountMinor: '-9000' }),
        txn({
          effectiveDate: '2026-11-01',
          amountMinor: '250000',
          categoryKind: 'income',
          categoryName: 'Paycheck',
        }),
      ],
      '2026-11-02',
    );
    expect(p.spentMinor).toBe(800n);
    expect(p.incomeMinor).toBe(250000n);
    expect(p.prevSpentToDateMinor).toBe(200n);
    expect(p.prevSpentTotalMinor).toBe(9200n);
    expect(p.series[1]).toEqual({ day: 2, thisMinor: '800', lastMinor: '200' });
    expect(p.series[2]?.thisMinor).toBeNull();
    expect(p.series).toHaveLength(31);
  });

  it('nets refunds, skips transfers, and uses split category legs only', () => {
    const p = monthPace(
      [
        txn({ amountMinor: '-1000' }),
        txn({ amountMinor: '400' }), // refund on an expense category
        txn({ amountMinor: '-5000', transferStatus: 'confirmed' }),
        txn({
          amountMinor: '300000',
          categoryKind: null,
          categoryName: null,
          splits: [
            { legType: 'category', categoryLedgerAccountId: 'c-pay', name: 'Pay', kind: 'income', amountMinor: '-350000' },
            { legType: 'category', categoryLedgerAccountId: 'c-tax', name: 'Tax', kind: 'expense', amountMinor: '30000' },
            { legType: 'account', categoryLedgerAccountId: null, name: '401k', kind: 'transfer', amountMinor: '20000' },
          ],
        }),
      ],
      '2026-11-02',
    );
    expect(p.spentMinor).toBe(600n + 30000n);
    expect(p.incomeMinor).toBe(350000n);
  });

  it('reports the last activity date when this month is empty', () => {
    const p = monthPace([txn({ effectiveDate: '2026-07-20' })], '2026-11-02');
    expect(p.spentMinor).toBe(0n);
    expect(p.lastActivityDate).toBe('2026-07-20');
  });
});
