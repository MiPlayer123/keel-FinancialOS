/**
 * Pure split-editor math (teardown C7). Everything here is BigInt on integer
 * minor-unit STRINGS — never floats (Law 4) — so the "Left to split" remainder
 * the UI shows is exactly the Σ=0 invariant the server re-enforces (Law 3 made
 * visible). No imports from React, Supabase, or the API layer: this file is
 * unit-tested as plain functions.
 */
import { parseSignedDollars, minorToDollars } from '@/lib/hash';

/** One editable split row: a category and a user-typed dollar magnitude. */
export type SplitDraftRow = {
  categoryId: string | null;
  /** Raw user input, dollars (e.g. "12.50"); always a positive magnitude. */
  amount: string;
};

/** A split as the read model reports it (debit-positive minor units). */
export type SplitLike = {
  /** Null for an account-transfer leg (a distribution). */
  categoryLedgerAccountId: string | null;
  amountMinor: string;
};

/**
 * Parse one row's dollar input into a POSITIVE minor-unit magnitude string.
 * Rejects blanks, negatives, and zero — a split share is always a positive
 * slice of the total; direction comes from the transaction's cash sign.
 */
export function parseSplitMagnitude(input: string): string | null {
  const minor = parseSignedDollars(input.trim());
  if (minor === null || minor === '0' || minor.startsWith('-')) return null;
  return minor;
}

/** Absolute value of a signed minor-units string. */
export function magnitudeMinor(signedMinor: string): string {
  return signedMinor.startsWith('-') ? signedMinor.slice(1) : signedMinor;
}

/**
 * Live remainder: |cash amount| minus the sum of every VALID row, as a signed
 * minor-units string. Positive = still left to split; negative = over-
 * allocated (negative money — the one place red is allowed); "0" = balanced.
 * Rows that don't parse contribute nothing — they block save via
 * splitRowsComplete, not by corrupting the arithmetic.
 */
export function splitRemainderMinor(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): string {
  let remainder = BigInt(magnitudeMinor(cashAmountMinor));
  for (const row of rows) {
    const minor = parseSplitMagnitude(row.amount);
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

/** Every row has a category and a valid positive amount, with no duplicates. */
export function splitRowsComplete(rows: readonly SplitDraftRow[]): boolean {
  if (rows.length === 0) return false;
  if (hasDuplicateCategories(rows)) return false;
  return rows.every((row) => row.categoryId !== null && parseSplitMagnitude(row.amount) !== null);
}

/** Save is allowed only when rows are complete AND the remainder is exactly 0. */
export function splitsReady(cashAmountMinor: string, rows: readonly SplitDraftRow[]): boolean {
  return splitRowsComplete(rows) && splitRemainderMinor(cashAmountMinor, rows) === '0';
}

/**
 * Assemble the command payload: debit-positive offsets that sum to exactly
 * -cashAmountMinor. Expense (cash negative) → positive splits; income (cash
 * positive) → negative splits — same convention as manual entry. Returns null
 * unless splitsReady, so an unbalanced editor can never emit a payload.
 */
export function buildSplitsPayload(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): { categoryLedgerAccountId: string; amountMinor: string }[] | null {
  if (!splitsReady(cashAmountMinor, rows)) return null;
  const splitSign = cashAmountMinor.startsWith('-') ? 1n : -1n;
  return rows.map((row) => ({
    // splitsReady guarantees categoryId and a parseable amount.
    categoryLedgerAccountId: row.categoryId as string,
    amountMinor: (splitSign * BigInt(parseSplitMagnitude(row.amount) as string)).toString(),
  }));
}

/** Seed editor rows from the read model's splits (magnitudes as dollars). */
export function seedRowsFromSplits(splits: readonly SplitLike[]): SplitDraftRow[] {
  return splits.map((s) => ({
    categoryId: s.categoryLedgerAccountId,
    amount: minorToDollars(magnitudeMinor(s.amountMinor)),
  }));
}

/**
 * Seed a fresh split from a single-category transaction: two rows, the full
 * amount on row 1 under the current category, row 2 empty (teardown C7).
 */
export function seedRowsForNewSplit(
  cashAmountMinor: string,
  currentCategoryId: string | null,
): SplitDraftRow[] {
  return [
    { categoryId: currentCategoryId, amount: minorToDollars(magnitudeMinor(cashAmountMinor)) },
    { categoryId: null, amount: '' },
  ];
}
