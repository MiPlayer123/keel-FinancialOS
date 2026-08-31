/**
 * Pure split-editor math (teardown C7). Everything here is BigInt on integer
 * minor-unit STRINGS — never floats (Law 4) — so the "Left to split" remainder
 * the UI shows is exactly the Σ=0 invariant the server re-enforces (Law 3 made
 * visible). No imports from React, Supabase, or the API layer: this file is
 * unit-tested as plain functions.
 *
 * SIGN MODEL (20260802 contra legs; 20260831 register signs).
 *
 * The LEDGER is debit-positive: an expense posts POSITIVE, income posts
 * NEGATIVE (doc 10 §2.4), and category legs sum to −cash. That is what the
 * server stores and keel_cmd_set_splits accepts — unchanged.
 *
 * The EDITOR shows REGISTER signs instead — the same convention as the
 * transaction list and as Quicken: **positive is money toward you, negative is
 * money away from you**. A tax withheld reads −268.47; the gross pay that
 * earned it reads +1992.18. Previously the editor printed the raw ledger sign,
 * which inverted BOTH lines relative to the register the user reads
 * everywhere else, so a paycheck's gross appeared as negative income.
 *
 * Because a register amount is exactly the negation of its posting, the whole
 * bridge is one negation — no per-category rules. The useful consequence is
 * that legs now sum to the TRANSACTION AMOUNT rather than its negation, so a
 * paycheck reads the way a payslip does:
 *
 *     +1992.18 gross − 602.85 withheld = +1389.33   ← the ledger line item
 *
 * Refunds and contra legs are unaffected in meaning, only in sign: a
 * reimbursement coming back to you is POSITIVE (money toward you), and a share
 * you owe is negative. A +$23 net reimbursement is legs summing to +23.
 */
import { parseSignedDollars, minorToDollars } from '@/lib/hash';

/** Negate a signed minor-units string ("-199218" ⇄ "199218"). */
function negateMinor(signedMinor: string): string {
  return (-BigInt(signedMinor)).toString();
}

/** One editable split row: a category and a user-typed REGISTER-SIGN amount. */
export type SplitDraftRow = {
  categoryId: string | null;
  /**
   * Raw user input, register signs: NEGATIVE for money away from you (an
   * expense, a tax withheld, a share you owe), POSITIVE for money toward you
   * (income, a refund, a reimbursement). The stored posting is the negation.
   */
  amount: string;
};

/** A split as the read model reports it (debit-positive minor units). */
export type SplitLike = {
  /** Null for an account-transfer leg (a distribution). */
  categoryLedgerAccountId: string | null;
  amountMinor: string;
};

/**
 * Parse one row's signed dollar input into a signed minor-unit string.
 * Rejects blanks and zero — a leg must move some money — but accepts either
 * direction: a negative amount is a credit (refund / reimbursement) leg.
 */
export function parseSplitAmount(input: string): string | null {
  const minor = parseSignedDollars(input.trim());
  if (minor === null || minor === '0') return null;
  return minor;
}

/** Absolute value of a signed minor-units string. */
export function magnitudeMinor(signedMinor: string): string {
  return signedMinor.startsWith('-') ? signedMinor.slice(1) : signedMinor;
}

/**
 * Live remainder as a signed minor-units string: the amount still unallocated.
 * In register signs the legs sum to the TRANSACTION AMOUNT, so
 * remainder = cash − Σ(rows). "0" = balanced; non-zero = still unallocated or
 * over-allocated (the one place red is allowed). Rows that don't parse
 * contribute nothing — they block save via splitRowsComplete, not by
 * corrupting the arithmetic.
 */
export function splitRemainderMinor(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): string {
  let remainder = BigInt(cashAmountMinor);
  for (const row of rows) {
    const minor = parseSplitAmount(row.amount);
    if (minor !== null) remainder -= BigInt(minor);
  }
  return remainder.toString();
}

/** True when two rows point at the same category (server rejects duplicates). */
export function hasDuplicateCategories(rows: readonly SplitDraftRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    if (seen.has(row.categoryId)) return true;
    seen.add(row.categoryId);
  }
  return false;
}

/** Every row has a category and a valid non-zero amount, with no duplicates. */
export function splitRowsComplete(rows: readonly SplitDraftRow[]): boolean {
  if (rows.length === 0) return false;
  if (hasDuplicateCategories(rows)) return false;
  return rows.every((row) => row.categoryId !== null && parseSplitAmount(row.amount) !== null);
}

/** Save is allowed only when rows are complete AND the remainder is exactly 0. */
export function splitsReady(cashAmountMinor: string, rows: readonly SplitDraftRow[]): boolean {
  return splitRowsComplete(rows) && splitRemainderMinor(cashAmountMinor, rows) === '0';
}

/**
 * Assemble the command payload in RAW debit-positive minor units: each register
 * amount negated. splitsReady has already proven the rows sum to
 * cashAmountMinor, so the negated legs sum to −cash exactly as the server
 * requires. A tax typed as −268.47 emits "26847"; gross typed as +1992.18
 * emits "-199218". Returns null unless splitsReady, so an unbalanced editor
 * can never emit.
 */
export function buildSplitsPayload(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): { categoryLedgerAccountId: string; amountMinor: string }[] | null {
  if (!splitsReady(cashAmountMinor, rows)) return null;
  return rows.map((row) => ({
    // splitsReady guarantees categoryId and a parseable amount.
    categoryLedgerAccountId: row.categoryId as string,
    amountMinor: negateMinor(parseSplitAmount(row.amount) as string),
  }));
}

/**
 * Seed editor rows from the read model's splits, converting each stored
 * posting into its register sign (negation): a stored −199218 income credit
 * seeds as "1992.18", a stored 26847 tax debit seeds as "-268.47", and a
 * stored −5583 expense credit (a refund) seeds as "55.83" — money that came
 * back to you.
 */
export function seedRowsFromSplits(splits: readonly SplitLike[]): SplitDraftRow[] {
  return splits.map((s) => ({
    categoryId: s.categoryLedgerAccountId,
    amount: minorToDollars(negateMinor(s.amountMinor)),
  }));
}

/**
 * Seed a fresh split from a single-category transaction: two rows, the whole
 * transaction amount on row 1 under the current category, row 2 empty
 * (teardown C7). In register signs row 1 simply mirrors the line item — an
 * expense (cash −4300) seeds as −43.00, an inflow (cash +4300) as +43.00.
 */
export function seedRowsForNewSplit(
  cashAmountMinor: string,
  currentCategoryId: string | null,
): SplitDraftRow[] {
  return [
    { categoryId: currentCategoryId, amount: minorToDollars(cashAmountMinor) },
    { categoryId: null, amount: '' },
  ];
}
