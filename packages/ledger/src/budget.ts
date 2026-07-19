/**
 * Budgeting v2 — pure, deterministic target resolution (research doc §2/§3,
 * formulaVersion `budget-v4-plan`). This module is the single source of truth
 * for the INTEGER arithmetic the `keel_budget_month` SQL read model mirrors:
 * every rounding decision made here is reproduced verbatim in SQL, so the
 * property tests over this code prove invariants the read model also holds
 * (Law 1: no float ledger math; Law 4: BIGINT minor units; invariant 7:
 * reproducible numbers).
 *
 * Percent basis points (bp) are integers in [0, 10000]; 10000 bp = 100%.
 * Percent resolution is a FLOOR (truncate toward zero on non-negative inputs):
 * `floor(base × bp / 10000)`. The remainder is intentionally NOT allocated —
 * it stays in Left-to-budget (documented in the formula version). This differs
 * from `allocateMoney`'s largest-remainder distribution on purpose: the plan
 * total is the one steering wheel, and percent categories must never sum to
 * more than the total merely because of rounding.
 */

/** floor(base × bp / 10000) for non-negative base, bp ∈ [0, 10000]. */
export const resolvePercentMinor = (baseMinor: bigint, bp: number): bigint => {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) {
    throw new Error(`budget percent_bp out of range: ${String(bp)}`);
  }
  if (baseMinor < 0n) {
    throw new Error('budget base must be non-negative');
  }
  return (baseMinor * BigInt(bp)) / 10_000n; // BigInt division truncates toward zero == floor here
};

export type TotalBasis = 'amount' | 'percent_of_income';
export type TargetKind = 'amount' | 'percent_of_total';

export interface PlanTotalInput {
  readonly basis: TotalBasis;
  /** Present iff basis === 'amount'. Non-negative minor units. */
  readonly amountMinor?: bigint;
  /** Present iff basis === 'percent_of_income'. Integer bp ∈ [0, 10000]. */
  readonly percentBp?: number;
}

export interface CategoryTargetInput {
  readonly categoryId: string;
  readonly kind: TargetKind;
  /** Present iff kind === 'amount'. Non-negative minor units. */
  readonly amountMinor?: bigint;
  /** Present iff kind === 'percent_of_total'. Integer bp ∈ [0, 10000]. */
  readonly percentBp?: number;
}

export interface ResolvedCategory {
  readonly categoryId: string;
  readonly kind: TargetKind;
  readonly resolvedMinor: bigint;
}

export interface ResolvedPlan {
  readonly totalMinor: bigint;
  readonly rows: readonly ResolvedCategory[];
  /** total − Σ resolved category targets. Negative = over-allocated. */
  readonly leftToBudgetMinor: bigint;
}

/**
 * Resolve the plan total.
 *   amount            → the declared amount (as-is)
 *   percent_of_income → floor(expectedIncome × bp / 10000)
 * `expectedIncomeMinor` may be null (unknown); a percent-of-income total then
 * resolves to 0 (you cannot take a percent of an unknown income — the plan is
 * simply unallocated until income is set). Amount totals ignore income.
 */
export const resolveTotalMinor = (
  total: PlanTotalInput,
  expectedIncomeMinor: bigint | null,
): bigint => {
  if (total.basis === 'amount') {
    const a = total.amountMinor ?? 0n;
    if (a < 0n) throw new Error('budget total amount must be non-negative');
    return a;
  }
  if (total.percentBp === undefined) {
    throw new Error('percent_of_income total requires percent_bp');
  }
  if (expectedIncomeMinor === null) return 0n;
  return resolvePercentMinor(expectedIncomeMinor, total.percentBp);
};

/** Resolve one category target against an already-resolved plan total. */
export const resolveCategoryMinor = (target: CategoryTargetInput, totalMinor: bigint): bigint => {
  if (target.kind === 'amount') {
    const a = target.amountMinor ?? 0n;
    if (a < 0n) throw new Error('budget category amount must be non-negative');
    return a;
  }
  if (target.percentBp === undefined) {
    throw new Error('percent_of_total target requires percent_bp');
  }
  return resolvePercentMinor(totalMinor, target.percentBp);
};

/**
 * Resolve a whole plan: total first, then every category against that total,
 * then Left-to-budget = total − Σ resolved. Deterministic and float-free.
 */
export const resolvePlan = (
  total: PlanTotalInput,
  categories: readonly CategoryTargetInput[],
  expectedIncomeMinor: bigint | null,
): ResolvedPlan => {
  const totalMinor = resolveTotalMinor(total, expectedIncomeMinor);
  const rows = categories.map<ResolvedCategory>((c) => ({
    categoryId: c.categoryId,
    kind: c.kind,
    resolvedMinor: resolveCategoryMinor(c, totalMinor),
  }));
  const allocated = rows.reduce((sum, r) => sum + r.resolvedMinor, 0n);
  return { totalMinor, rows, leftToBudgetMinor: totalMinor - allocated };
};
