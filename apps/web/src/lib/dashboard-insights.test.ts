import { describe, expect, it } from 'vitest';

import { buildInsights } from './dashboard-insights';
import type { RichTransactionRow } from '@/lib/keel-api';

// Mid-month clock so both spend windows are genuine partials: this month runs
// 2026-07-01 → 2026-07-15; same-period-last-month runs 2026-06-01 → 2026-06-15.
const NOW = new Date('2026-07-15T12:00:00Z');

let seq = 0;
function txn(over: Partial<RichTransactionRow> & { effectiveDate: string; amountMinor: string }): RichTransactionRow {
  seq += 1;
  return {
    transactionId: `t-${String(seq)}`,
    description: 'Coffee Bar',
    status: 'posted',
    accountId: 'acct-1',
    accountName: 'Checking',
    currency: 'USD',
    categoryLedgerAccountId: 'cat-food',
    categoryName: 'Food',
    categoryKind: 'expense',
    ...over,
  };
}

function pace(insights: ReturnType<typeof buildInsights>) {
  return insights.find((i) => i.label === 'Spending pace vs last month');
}

describe('buildInsights — spending pace vs last month', () => {
  it('compares month-to-date against the SAME period last month (equal-length windows)', () => {
    const rows = [
      // This month, through today: -$100 total.
      txn({ effectiveDate: '2026-07-05', amountMinor: '-6000' }),
      txn({ effectiveDate: '2026-07-10', amountMinor: '-4000' }),
      // Last month, through the 15th: -$80 total (the comparison window).
      txn({ effectiveDate: '2026-06-03', amountMinor: '-5000' }),
      txn({ effectiveDate: '2026-06-14', amountMinor: '-3000' }),
      // Last month AFTER the 15th: must be EXCLUDED (full-month leak guard).
      txn({ effectiveDate: '2026-06-25', amountMinor: '-9999' }),
    ];
    const p = pace(buildInsights(rows, NOW));
    expect(p).toBeDefined();
    // 100 vs 80 → +25%.
    expect(p?.value).toBe('+25%');
    expect(p?.detail).toContain('$100.00 so far');
    expect(p?.detail).toContain('$80.00');
    expect(p?.detail).toContain('by day 15');
    // Drill-in covers exactly the current-month-to-date window.
    expect(p?.href).toBe('/dashboard/ledger?from=2026-07-01&to=2026-07-15');
  });

  it('excludes a FUTURE-dated current-month row so both sides stop at the same day', () => {
    // The bug this guards: the current-month sum used to have no upper bound,
    // so a row dated later this month (manual/projected entry) would inflate
    // "this month so far" while the comparison side stayed capped at the 15th —
    // an apples-to-oranges pace. Both must stop at today.
    const base = [
      txn({ effectiveDate: '2026-07-05', amountMinor: '-6000' }), // in-window: $60
      txn({ effectiveDate: '2026-06-05', amountMinor: '-6000' }), // last-month same period: $60
    ];
    const withoutFuture = pace(buildInsights([...base], NOW));
    // 60 vs 60 → 0%.
    expect(withoutFuture?.value).toBe('+0%');

    const withFuture = pace(
      buildInsights([...base, txn({ effectiveDate: '2026-07-28', amountMinor: '-100000' })], NOW),
    );
    // The future-dated $1000 must NOT move the pace — still 60 vs 60 = 0%.
    expect(withFuture?.value).toBe('+0%');
    expect(withFuture?.detail).toContain('$60.00 so far');
  });

  it('omits the pace insight when either window has no spend', () => {
    const onlyThisMonth = [txn({ effectiveDate: '2026-07-05', amountMinor: '-6000' })];
    expect(pace(buildInsights(onlyThisMonth, NOW))).toBeUndefined();
  });
});
