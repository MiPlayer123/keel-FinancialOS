import { describe, expect, it } from 'vitest';

import {
  excludeTaxSpend,
  rollupCategoryTotals,
  taxCategoryIdSet,
  TAX_PFC_KEY,
} from './category-rollup';
import type { CategoryRow } from '@/lib/keel-api';

function cat(
  ledgerAccountId: string,
  name: string,
  extra: Partial<CategoryRow> = {},
): CategoryRow {
  return { ledgerAccountId, name, kind: 'expense', entityId: 'e1', ...extra };
}

const CATEGORIES: CategoryRow[] = [
  cat('food', 'Food & Drink'),
  cat('groceries', 'Groceries', { parentLedgerAccountId: 'food' }),
  cat('restaurants', 'Restaurants', { parentLedgerAccountId: 'food' }),
  cat('travel', 'Travel'),
  cat('gov', 'Government & Nonprofit'),
  cat('taxes', 'Taxes', { parentLedgerAccountId: 'gov', pfcKey: TAX_PFC_KEY }),
];

describe('rollupCategoryTotals', () => {
  it('rolls subcategories into their parent and keeps them as children', () => {
    const groups = rollupCategoryTotals(
      [
        { categoryId: 'groceries', name: 'Groceries', amountMinor: 40000n },
        { categoryId: 'restaurants', name: 'Restaurants', amountMinor: 30000n },
        { categoryId: 'travel', name: 'Travel', amountMinor: 20000n },
      ],
      CATEGORIES,
    );
    expect(groups.map((g) => [g.name, g.amountMinor])).toEqual([
      ['Food & Drink', 70000n],
      ['Travel', 20000n],
    ]);
    expect(groups[0]?.children.map((c) => [c.name, c.amountMinor])).toEqual([
      ['Groceries', 40000n],
      ['Restaurants', 30000n],
    ]);
    expect(groups[1]?.children).toEqual([]);
  });

  it("keeps the parent's own activity as a '(general)' child summing to the group", () => {
    const groups = rollupCategoryTotals(
      [
        { categoryId: 'food', name: 'Food & Drink', amountMinor: 10000n },
        { categoryId: 'groceries', name: 'Groceries', amountMinor: 40000n },
      ],
      CATEGORIES,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.amountMinor).toBe(50000n);
    expect(groups[0]?.children.map((c) => c.name)).toEqual([
      'Groceries',
      'Food & Drink (general)',
    ]);
    const childSum = groups[0]?.children.reduce((acc, c) => acc + c.amountMinor, 0n);
    expect(childSum).toBe(50000n);
  });

  it('nets refund-heavy children into the parent total (can go negative)', () => {
    const groups = rollupCategoryTotals(
      [
        { categoryId: 'groceries', name: 'Groceries', amountMinor: 5000n },
        { categoryId: 'restaurants', name: 'Restaurants', amountMinor: -8000n },
      ],
      CATEGORIES,
    );
    expect(groups[0]?.amountMinor).toBe(-3000n);
  });

  it('leaves Uncategorized and unknown (archived) categories standalone', () => {
    const groups = rollupCategoryTotals(
      [
        { categoryId: null, name: 'Uncategorized', amountMinor: 1000n },
        { categoryId: 'ghost', name: 'Old Category', amountMinor: 2000n },
      ],
      CATEGORIES,
    );
    expect(groups.map((g) => [g.name, g.children.length])).toEqual([
      ['Old Category', 0],
      ['Uncategorized', 0],
    ]);
  });
});

describe('taxCategoryIdSet', () => {
  it('finds the seeded Taxes subcategory by pfc key, not by name', () => {
    expect(taxCategoryIdSet(CATEGORIES)).toEqual(new Set(['taxes']));
    expect(taxCategoryIdSet([cat('t2', 'Taxes')])).toEqual(new Set());
  });

  it('includes categories nested under a tax category', () => {
    const withChild = [...CATEGORIES, cat('property', 'Property tax', { parentLedgerAccountId: 'taxes' })];
    expect(taxCategoryIdSet(withChild)).toEqual(new Set(['taxes', 'property']));
  });
});

describe('excludeTaxSpend', () => {
  const taxIds = new Set(['taxes']);

  it('drops rows categorized to a tax category and keeps others by reference', () => {
    const keep = { categoryLedgerAccountId: 'groceries' };
    const rows = [keep, { categoryLedgerAccountId: 'taxes' }];
    const out = excludeTaxSpend(rows, taxIds);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(keep);
  });

  it('strips only the tax shares from a split row', () => {
    const row = {
      categoryLedgerAccountId: null,
      splits: [
        { categoryLedgerAccountId: 'taxes' },
        { categoryLedgerAccountId: 'groceries' },
        { categoryLedgerAccountId: null },
      ],
    };
    const out = excludeTaxSpend([row], taxIds);
    expect(out[0]?.splits?.map((s) => s.categoryLedgerAccountId)).toEqual(['groceries', null]);
  });

  it('drops a split row whose every share was tax', () => {
    const row = {
      categoryLedgerAccountId: null,
      splits: [{ categoryLedgerAccountId: 'taxes' }],
    };
    expect(excludeTaxSpend([row], taxIds)).toEqual([]);
  });

  it('is a no-op passthrough when no tax categories exist', () => {
    const rows = [{ categoryLedgerAccountId: 'taxes' }];
    expect(excludeTaxSpend(rows, new Set())).toBe(rows);
  });
});
