import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  resolvePercentMinor,
  resolveTotalMinor,
  resolveCategoryMinor,
  resolvePlan,
  type CategoryTargetInput,
  type PlanTotalInput,
} from '../src/budget.js';

describe('resolvePercentMinor', () => {
  it('floors base × bp / 10000', () => {
    // 10000 minor × 3333 bp = 33_330_000 / 10000 = 3333 (exact)
    expect(resolvePercentMinor(10_000n, 3_333)).toBe(3_333n);
    // 999 minor × 5000 bp = 4_995_000 / 10000 = 499.5 → floor 499
    expect(resolvePercentMinor(999n, 5_000)).toBe(499n);
    // 0% and 100% edges
    expect(resolvePercentMinor(12_345n, 0)).toBe(0n);
    expect(resolvePercentMinor(12_345n, 10_000)).toBe(12_345n);
  });

  it('rejects out-of-range bp and negative base', () => {
    expect(() => resolvePercentMinor(100n, -1)).toThrow();
    expect(() => resolvePercentMinor(100n, 10_001)).toThrow();
    expect(() => resolvePercentMinor(100n, 1.5)).toThrow();
    expect(() => resolvePercentMinor(-1n, 5_000)).toThrow();
  });

  it('never exceeds the base for bp ≤ 10000, and is monotonic in bp', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, bpA, bpB) => {
          const rA = resolvePercentMinor(base, bpA);
          const rB = resolvePercentMinor(base, bpB);
          // bounded by base at 100%
          expect(rA).toBeLessThanOrEqual(base);
          expect(rA).toBeGreaterThanOrEqual(0n);
          // monotonic: more bp never resolves to less
          if (bpA <= bpB) expect(rA).toBeLessThanOrEqual(rB);
        },
      ),
    );
  });

  it('is deterministic (same inputs → same output)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, bp) => {
          expect(resolvePercentMinor(base, bp)).toBe(resolvePercentMinor(base, bp));
        },
      ),
    );
  });
});

describe('resolveTotalMinor', () => {
  it('amount basis returns the declared amount', () => {
    expect(resolveTotalMinor({ basis: 'amount', amountMinor: 500_000n }, 999n)).toBe(500_000n);
  });

  it('percent_of_income floors income × bp / 10000', () => {
    // income 4_000_000 (=$40k) at 5000 bp (50%) = 2_000_000
    expect(resolveTotalMinor({ basis: 'percent_of_income', percentBp: 5_000 }, 4_000_000n)).toBe(
      2_000_000n,
    );
  });

  it('percent_of_income with unknown income resolves to 0 (never fabricates)', () => {
    expect(resolveTotalMinor({ basis: 'percent_of_income', percentBp: 5_000 }, null)).toBe(0n);
  });

  it('rejects a percent_of_income total without percent_bp', () => {
    expect(() => resolveTotalMinor({ basis: 'percent_of_income' }, 100n)).toThrow();
  });
});

describe('resolveCategoryMinor', () => {
  it('amount is as-is; percent_of_total floors total × bp / 10000', () => {
    expect(resolveCategoryMinor({ categoryId: 'a', kind: 'amount', amountMinor: 12_000n }, 999n)).toBe(
      12_000n,
    );
    expect(
      resolveCategoryMinor({ categoryId: 'b', kind: 'percent_of_total', percentBp: 2_500 }, 1_000_001n),
    ).toBe(250_000n); // 1_000_001 × 2500 / 10000 = 250_000.25 → floor 250_000
  });

  it('a missing amount defaults to 0 (opt-in $0 row), and rejects negatives', () => {
    expect(resolveCategoryMinor({ categoryId: 'a', kind: 'amount' }, 100n)).toBe(0n);
    expect(() =>
      resolveCategoryMinor({ categoryId: 'a', kind: 'amount', amountMinor: -1n }, 100n),
    ).toThrow();
  });

  it('rejects a percent_of_total target without percent_bp', () => {
    expect(() => resolveCategoryMinor({ categoryId: 'a', kind: 'percent_of_total' }, 100n)).toThrow(
      'percent_of_total target requires percent_bp',
    );
  });
});

describe('resolveTotalMinor amount edge', () => {
  it('a missing amount defaults to 0 and rejects a negative amount', () => {
    expect(resolveTotalMinor({ basis: 'amount' }, null)).toBe(0n);
    expect(() => resolveTotalMinor({ basis: 'amount', amountMinor: -1n }, null)).toThrow();
  });
});

describe('resolvePlan — Left-to-budget + Σ resolved invariants', () => {
  it('worked example: $3000 total, 50% + 20% + $400 amount', () => {
    const total: PlanTotalInput = { basis: 'amount', amountMinor: 300_000n };
    const cats: CategoryTargetInput[] = [
      { categoryId: 'rent', kind: 'percent_of_total', percentBp: 5_000 }, // 150_000
      { categoryId: 'food', kind: 'percent_of_total', percentBp: 2_000 }, // 60_000
      { categoryId: 'fun', kind: 'amount', amountMinor: 40_000n }, // 40_000
    ];
    const plan = resolvePlan(total, cats, null);
    expect(plan.totalMinor).toBe(300_000n);
    expect(plan.rows.map((r) => r.resolvedMinor)).toEqual([150_000n, 60_000n, 40_000n]);
    // 300_000 − 250_000 = 50_000 left to budget
    expect(plan.leftToBudgetMinor).toBe(50_000n);
  });

  it('over-allocation yields a negative Left-to-budget (flag state)', () => {
    const plan = resolvePlan(
      { basis: 'amount', amountMinor: 100_000n },
      [
        { categoryId: 'a', kind: 'amount', amountMinor: 80_000n },
        { categoryId: 'b', kind: 'amount', amountMinor: 50_000n },
      ],
      null,
    );
    expect(plan.leftToBudgetMinor).toBe(-30_000n);
  });

  it('PROPERTY: Σ resolved ≤ total whenever every category is percent and Σbp ≤ 10000', () => {
    const target = (): fc.Arbitrary<CategoryTargetInput> =>
      fc.record({
        categoryId: fc.uuid(),
        kind: fc.constant('percent_of_total' as const),
        percentBp: fc.integer({ min: 0, max: 10_000 }),
      });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 14n }),
        fc.array(target(), { maxLength: 30 }),
        (totalMinor, rawCats) => {
          // constrain Σbp ≤ 10000 by scaling down proportionally when needed
          const sumBp = rawCats.reduce((s, c) => s + (c.percentBp ?? 0), 0);
          const cats =
            sumBp <= 10_000
              ? rawCats
              : rawCats.map((c) => ({
                  ...c,
                  percentBp: Math.floor(((c.percentBp ?? 0) * 10_000) / sumBp),
                }));
          const plan = resolvePlan({ basis: 'amount', amountMinor: totalMinor }, cats, null);
          const allocated = plan.rows.reduce((s, r) => s + r.resolvedMinor, 0n);
          expect(allocated).toBeLessThanOrEqual(totalMinor);
          expect(plan.leftToBudgetMinor).toBeGreaterThanOrEqual(0n);
          // and Left-to-budget is exactly total − Σ resolved
          expect(plan.leftToBudgetMinor).toBe(totalMinor - allocated);
        },
      ),
    );
  });

  it('PROPERTY: leftToBudget always equals total − Σ resolved (any mix)', () => {
    const target = (): fc.Arbitrary<CategoryTargetInput> =>
      fc.oneof(
        fc.record({
          categoryId: fc.uuid(),
          kind: fc.constant('amount' as const),
          amountMinor: fc.bigInt({ min: 0n, max: 10n ** 12n }),
        }),
        fc.record({
          categoryId: fc.uuid(),
          kind: fc.constant('percent_of_total' as const),
          percentBp: fc.integer({ min: 0, max: 10_000 }),
        }),
      );
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 14n }),
        fc.array(target(), { maxLength: 30 }),
        (totalMinor, cats) => {
          const plan = resolvePlan({ basis: 'amount', amountMinor: totalMinor }, cats, null);
          const allocated = plan.rows.reduce((s, r) => s + r.resolvedMinor, 0n);
          expect(plan.leftToBudgetMinor).toBe(totalMinor - allocated);
        },
      ),
    );
  });
});

describe('v3-equivalence: amount-only targets reproduce the v3 model', () => {
  // In v3, each budgeted category has a fixed amount; there is no plan total and
  // "spent" is measured separately. v4 with amount-only category targets and an
  // amount total must resolve each category to EXACTLY its declared amount — the
  // arithmetic that backfilled budgets rows must be a pure pass-through.
  it('every amount target resolves to its declared amount, unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 40 }),
        (amounts) => {
          const cats: CategoryTargetInput[] = amounts.map((a, i) => ({
            categoryId: `cat-${String(i)}`,
            kind: 'amount',
            amountMinor: a,
          }));
          // total is irrelevant to amount categories — pick anything
          const plan = resolvePlan({ basis: 'amount', amountMinor: 0n }, cats, null);
          expect(plan.rows.map((r) => r.resolvedMinor)).toEqual(amounts);
        },
      ),
    );
  });
});
