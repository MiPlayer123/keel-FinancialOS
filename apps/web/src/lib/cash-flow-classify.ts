/**
 * Executable reference for the cash-flow GRAPH's inflow/outflow split
 * (formulaVersion cash-flow-monthly-v6-sign-classified /
 * cash-flow-v7-sign-classified). The authoritative implementation is the SQL
 * proc `public.keel_cash_flow_monthly` — this mirror exists so the sign→
 * direction rule is pinned by a fast, DB-free unit test (Stage-1 worked-example
 * discipline) and so the invariants the proc must uphold are stated once, in
 * code, not just prose.
 *
 * WHY SIGN, NOT CATEGORY KIND. The money-in / money-out bars are a CASH
 * DIRECTION view. A payment the household RECEIVED but tagged to a spend
 * category (a friend paying you back for dinner → Restaurants) is still money
 * that came IN; classifying it by its overlaid EXPENSE category (as v6 did)
 * subtracted it from "money out" and could drive a month's outflow bar
 * NEGATIVE. Direction is intrinsic to the posting sign on the category account:
 *   amount_minor < 0  (credit to a category account → money received) → inflow
 *   amount_minor > 0  (debit  to a category account → money spent)    → outflow
 * Budget math still nets reimbursements into their category — that lives in
 * keel_budget_month and is unchanged (Law 9: two distinct, each reproducible,
 * scoped calculations, not two answers to one question).
 *
 * Money stays BIGINT minor units throughout (Law 4); no floats, no ledger
 * arithmetic beyond summing postings the deterministic spine already produced
 * (Law 1).
 */

/** One surviving category posting (exclusions already applied upstream), as the
 *  proc sees it: the signed minor-unit amount on a category ledger account. */
export type CategoryPosting = { amountMinor: bigint };

export type CashFlowSplit = {
  /** −Σ(amount_minor < 0): money received. Non-negative by construction. */
  inflowMinor: bigint;
  /** +Σ(amount_minor > 0): money spent. Non-negative by construction. */
  outflowMinor: bigint;
  /** inflow − outflow == −Σ(amount_minor): the reproducible invariant that is
   *  IDENTICAL to every prior formula version (only the gross split changed). */
  netMinor: bigint;
};

/**
 * Split a bucket's surviving category postings into money-in / money-out by
 * cash direction (posting sign). Both sides are always ≥ 0 — a cash-flow bar
 * can never render negative. `net` equals −Σ(amount_minor), matching the ledger
 * net exactly.
 */
export function classifyCashFlow(postings: readonly CategoryPosting[]): CashFlowSplit {
  let inflowMinor = 0n;
  let outflowMinor = 0n;
  for (const p of postings) {
    if (p.amountMinor < 0n) inflowMinor -= p.amountMinor; // −(negative) = positive money in
    else if (p.amountMinor > 0n) outflowMinor += p.amountMinor; // money out
    // amount_minor == 0 contributes to neither side.
  }
  return { inflowMinor, outflowMinor, netMinor: inflowMinor - outflowMinor };
}
