import { describe, expect, it } from 'vitest';

import type { BudgetMonthRow } from '@/lib/keel-api';
import {
  budgetLines,
  budgetStatus,
  budgetTotals,
  daysLeftInMonth,
  monthPacePct,
  overBudgetLines,
  planSummary,
} from '@/lib/budget-progress';

function row(o: Partial<BudgetMonthRow> & { categoryName: string }): BudgetMonthRow {
  return {
    categoryLedgerAccountId: o.categoryName,
    parentLedgerAccountId: null,
    currency: 'USD',
    kind: 'amount',
    declared: {},
    resolvedMinor: '10000',
    spentMinor: '0',
    rollover: false,
    carryMinor: null,
    availableMinor: o.resolvedMinor ?? '10000',
    ...o,
  };
}

describe('pace', () => {
  it('is the share of the month elapsed', () => {
    expect(monthPacePct('2026-10-01', '2026-10-20')).toBe(64); // 20/31, floored
    expect(monthPacePct('2026-10-01', '2026-11-03')).toBe(100); // past month
    expect(monthPacePct('2026-12-01', '2026-11-03')).toBe(0); // future month
    expect(daysLeftInMonth('2026-10-01', '2026-10-20')).toBe(11);
    expect(daysLeftInMonth('2026-09-01', '2026-10-20')).toBe(0);
  });
});

describe('status', () => {
  it('classifies over, ahead, on track and not started', () => {
    expect(budgetStatus(12000n, 10000n, 50)).toBe('over');
    expect(budgetStatus(7600n, 10000n, 64)).toBe('ahead'); // 76% used vs 64% of month
    expect(budgetStatus(7000n, 10000n, 64)).toBe('on_track'); // within the 10-point margin
    expect(budgetStatus(0n, 10000n, 64)).toBe('not_started');
    expect(budgetStatus(100n, 0n, 64)).toBe('over'); // spend against a $0 target
  });
});

describe('lines', () => {
  const rows = [
    row({ categoryName: 'Food', categoryLedgerAccountId: 'food', resolvedMinor: '35000', availableMinor: '35000', spentMinor: '79883' }),
    row({ categoryName: 'Groceries', parentLedgerAccountId: 'food', resolvedMinor: '15000', availableMinor: '15000', spentMinor: '11456' }),
    row({ categoryName: 'Transport', resolvedMinor: '13000', availableMinor: '13000', spentMinor: '8223' }),
    row({ categoryName: 'Rent', resolvedMinor: '235200', availableMinor: '235200', spentMinor: '0' }),
    row({ categoryName: 'Fun', resolvedMinor: '12000', availableMinor: '12000', spentMinor: '96640' }),
  ];

  it('groups children under parents and sorts by urgency', () => {
    const lines = budgetLines(rows, 64);
    expect(lines.map((l) => l.row.categoryName)).toEqual(['Fun', 'Food', 'Transport', 'Rent']);
    expect(lines[1]?.children.map((c) => c.row.categoryName)).toEqual(['Groceries']);
    expect(lines[1]?.children[0]?.status).toBe('ahead');
  });

  it('an over child lifts its parent group', () => {
    const lines = budgetLines(
      [
        row({ categoryName: 'Parent', categoryLedgerAccountId: 'p', spentMinor: '100' }),
        row({ categoryName: 'Kid', parentLedgerAccountId: 'p', spentMinor: '20000' }),
        row({ categoryName: 'Ahead', spentMinor: '9000' }),
      ],
      50,
    );
    expect(lines.map((l) => l.row.categoryName)).toEqual(['Parent', 'Ahead']);
  });

  it('totals add rows once and count overs', () => {
    const t = budgetTotals(rows);
    expect(t.budgetedMinor).toBe(35000n + 15000n + 13000n + 235200n + 12000n);
    expect(t.spentMinor).toBe(79883n + 11456n + 8223n + 96640n);
    expect(t.overCount).toBe(2);
  });

  it('lists over rows biggest overspend first', () => {
    expect(overBudgetLines(rows).map((l) => [l.row.categoryName, l.remainingMinor])).toEqual([
      ['Fun', -84640n],
      ['Food', -44883n],
    ]);
  });
});

describe('planSummary', () => {
  const rows = [
    row({ categoryName: 'Fun', resolvedMinor: '5000', availableMinor: '5000', spentMinor: '16109' }),
    row({ categoryName: 'Food', resolvedMinor: '50000', availableMinor: '50000', spentMinor: '14602' }),
    row({ categoryName: 'Other', resolvedMinor: '10000', availableMinor: '10000', spentMinor: '0' }),
    row({ categoryName: 'Transport', resolvedMinor: '10000', availableMinor: '10000', spentMinor: '22093' }),
  ];

  it('counts all spending; no set-aside for everything else without an explicit total', () => {
    const s = planSummary({
      total: { basis: 'implicit_sum' },
      leftToBudgetMinor: '0',
      everythingElseSpentMinor: '816437',
      rows,
    });
    expect(s.categoriesSpentMinor).toBe(52804n);
    expect(s.allSpentMinor).toBe(52804n + 816437n);
    expect(s.elseBudgetMinor).toBeNull();
    expect(s.allBudgetMinor).toBe(75000n);
    expect(s.overCount).toBe(2);
  });

  it('an explicit total sets aside the remainder for everything else', () => {
    const s = planSummary({
      total: { basis: 'amount' },
      leftToBudgetMinor: '175000',
      everythingElseSpentMinor: '816437',
      rows,
    });
    expect(s.elseBudgetMinor).toBe(175000n);
    expect(s.allBudgetMinor).toBe(250000n);
    expect(s.overCount).toBe(3); // everything else is over its $1,750
  });

  it('an over-allocated total leaves nothing for everything else', () => {
    const s = planSummary({ total: { basis: 'amount' }, leftToBudgetMinor: '-2000', everythingElseSpentMinor: '0', rows });
    expect(s.elseBudgetMinor).toBe(0n);
  });
});
