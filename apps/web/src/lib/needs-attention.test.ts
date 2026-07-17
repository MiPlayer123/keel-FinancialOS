import { describe, expect, it } from 'vitest';

import {
  buildNeedsAttention,
  isUncategorized,
  type NeedsAttentionInput,
} from '@/lib/needs-attention';

const EMPTY: NeedsAttentionInput = {
  recurring: [],
  transfers: [],
  categorizations: [],
  bills: [],
  connections: [],
  transactions: [],
  todayIso: '2026-07-17',
};

const occ = (expectedDate: string, status = 'expected') =>
  ({ expectedDate, status, expectedAmountMinor: '-1000', currency: 'USD', occurrenceId: expectedDate }) as never;

describe('buildNeedsAttention', () => {
  it('returns no rows when everything is zero (module hides)', () => {
    expect(buildNeedsAttention(EMPTY)).toEqual([]);
  });

  it('treats null (still-loading) inputs as zero', () => {
    expect(
      buildNeedsAttention({
        ...EMPTY,
        recurring: null,
        transfers: null,
        categorizations: null,
        bills: null,
        connections: null,
        transactions: null,
      }),
    ).toEqual([]);
  });

  it('sums suggested transfers + recurring + categorizations into one review row', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      recurring: [
        { status: 'suggested', sign: 'outflow', occurrences: [] },
        { status: 'confirmed', sign: 'outflow', occurrences: [] },
        { status: 'rejected', sign: 'outflow', occurrences: [] },
      ],
      transfers: [{ status: 'suggested' }, { status: 'confirmed' }],
      categorizations: [
        { status: 'suggested' },
        { status: 'accepted' },
        { status: 'dismissed' },
      ],
    });
    expect(rows).toEqual([
      {
        key: 'review',
        count: 3,
        label: 'suggestions to review',
        href: '/dashboard/review',
      },
    ]);
  });

  it('counts only outflow bills inside the 7-day window, inclusive on both ends', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      bills: [
        { date: '2026-07-17', sign: 'outflow' }, // today — counts
        { date: '2026-07-24', sign: 'outflow' }, // today + 7 — counts
        { date: '2026-07-25', sign: 'outflow' }, // today + 8 — outside
        { date: '2026-07-16', sign: 'outflow' }, // past — outside
        { date: '2026-07-20', sign: 'inflow' }, // income, not a bill
      ],
    });
    expect(rows).toEqual([
      {
        key: 'bills',
        count: 2,
        label: 'bills due within 7 days',
        href: '/dashboard/recurring',
      },
    ]);
  });

  it('handles the 7-day horizon crossing a month boundary', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      todayIso: '2026-07-28',
      bills: [
        { date: '2026-08-04', sign: 'outflow' }, // +7 across the boundary — counts
        { date: '2026-08-05', sign: 'outflow' }, // +8 — outside
      ],
    });
    expect(rows).toEqual([
      {
        key: 'bills',
        count: 1,
        label: 'bill due within 7 days',
        href: '/dashboard/recurring',
      },
    ]);
  });

  it('counts only reauth_required connections', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      connections: [
        { status: 'active' },
        { status: 'reauth_required' },
        { status: 'disconnected' },
      ],
    });
    expect(rows).toEqual([
      {
        key: 'reauth',
        count: 1,
        label: 'connection needs reconnecting',
        href: '/dashboard/connections',
      },
    ]);
  });

  it('counts uncategorized transactions via the shared predicate', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      transactions: [
        { categoryPfcKey: 'uncategorized_expense', categoryName: 'Uncategorized Expense' },
        { categoryPfcKey: 'groceries', categoryName: 'Groceries' },
        // pre-migration shape: no pfc key, seeded name fallback
        { categoryName: 'Uncategorized Income' },
        // no category info at all — uncategorized
        { categoryName: null },
        // split transactions are categorized by their splits
        {
          categoryPfcKey: 'uncategorized_expense',
          categoryName: 'Uncategorized Expense',
          splits: [
            {
              categoryLedgerAccountId: 'c1',
              name: 'Groceries',
              kind: 'expense' as const,
              amountMinor: '100',
            },
          ],
        },
      ],
    });
    expect(rows).toEqual([
      {
        key: 'uncategorized',
        count: 3,
        label: 'uncategorized transactions',
        href: '/dashboard/ledger?category=uncategorized',
      },
    ]);
  });

  it('emits rows in fixed order and drops zero-count rows', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      transfers: [{ status: 'suggested' }],
      connections: [{ status: 'reauth_required' }],
      transactions: [{ categoryName: null }],
    });
    expect(rows.map((r) => r.key)).toEqual(['review', 'reauth', 'uncategorized']);
    expect(rows.every((r) => r.count > 0)).toBe(true);
  });

  it('uses singular labels at count 1', () => {
    const rows = buildNeedsAttention({
      ...EMPTY,
      transfers: [{ status: 'suggested' }],
    });
    expect(rows[0]?.label).toBe('suggestion to review');
  });
});

describe('isUncategorized', () => {
  it('prefers the rename-proof pfc key when present', () => {
    expect(
      isUncategorized({ categoryPfcKey: 'uncategorized_income', categoryName: 'Renamed' }),
    ).toBe(true);
    expect(
      isUncategorized({ categoryPfcKey: 'transfers', categoryName: 'Uncategorized Expense' }),
    ).toBe(false);
  });

  it('falls back to the seeded name, then to missing category', () => {
    expect(isUncategorized({ categoryName: 'Uncategorized Expense' })).toBe(true);
    expect(isUncategorized({ categoryName: 'Groceries' })).toBe(false);
    expect(isUncategorized({ categoryName: null })).toBe(true);
  });

  it('counts due-TODAY bills from recurring occurrences (forecast starts tomorrow)', () => {
    const rows = buildNeedsAttention({
      recurring: [
        { status: 'confirmed', sign: 'outflow', occurrences: [occ('2026-07-17')] } as never,
        // inflows and suggested series contribute nothing to bills
        { status: 'confirmed', sign: 'inflow', occurrences: [occ('2026-07-17')] } as never,
        { status: 'suggested', sign: 'outflow', occurrences: [occ('2026-07-17')] } as never,
      ],
      transfers: [],
      categorizations: [],
      bills: [{ date: '2026-07-19', sign: 'outflow' }],
      connections: [],
      transactions: [],
      todayIso: '2026-07-17',
    });
    const bills = rows.find((r) => r.key === 'bills');
    expect(bills?.count).toBe(2); // one due today + one in-window forecast bill
  });
});
