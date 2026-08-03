/**
 * Pure split-editor math (teardown C7). Everything here is BigInt on integer
 * minor-unit STRINGS — never floats (Law 4) — so the "Left to split" remainder
 * the UI shows is exactly the Σ=0 invariant the server re-enforces (Law 3 made
 * visible). No imports from React, Supabase, or the API layer: this file is
 * unit-tested as plain functions.
 *
 * SIGN MODEL (20260802, contra legs). Each row carries the SIGNED posting it
 * contributes, debit-positive — the same convention the server stores and
 * keel_cmd_set_splits accepts. A positive row is a debit (a normal expense
 * share, or money you now owe); a NEGATIVE row is a credit — a refund or
 * reimbursement that reduces a category you already paid. Category legs must
 * sum to −cash (a $43 expense → +43 of offsets; a +$23 net reimbursement →
 * legs that net to −23, mixing +debits and −credits). The editor no longer
 * derives one global sign from the cash direction, which could not represent a
 * mixed/contra split at all.
 */
import { parseSignedDollars, minorToDollars } from '@/lib/hash';

/** One editable split row: a category and a user-typed SIGNED dollar amount. */
export type SplitDraftRow = {
  categoryId: string | null;
  /**
   * Raw user input, signed dollars (e.g. "12.50", or "-55.83" for a refund /
   * reimbursement credit). Debit-positive, matching the stored posting.
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
 * Category legs must sum to −cash, so remainder = (−cash) − Σ(signed rows).
 * "0" = balanced; positive = still left to split; negative = over-allocated
 * (the one place red is allowed). Rows that don't parse contribute nothing —
 * they block save via splitRowsComplete, not by corrupting the arithmetic.
 */
export function splitRemainderMinor(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): string {
  let remainder = -BigInt(cashAmountMinor);
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
 * Assemble the command payload: the SIGNED offsets exactly as typed, which
 * splitsReady has already proven sum to −cashAmountMinor. No global sign is
 * applied — a positive row is a debit, a negative row a credit (contra).
 * Returns null unless splitsReady, so an unbalanced editor can never emit.
 */
export function buildSplitsPayload(
  cashAmountMinor: string,
  rows: readonly SplitDraftRow[],
): { categoryLedgerAccountId: string; amountMinor: string }[] | null {
  if (!splitsReady(cashAmountMinor, rows)) return null;
  return rows.map((row) => ({
    // splitsReady guarantees categoryId and a parseable amount.
    categoryLedgerAccountId: row.categoryId as string,
    amountMinor: parseSplitAmount(row.amount) as string,
  }));
}

/** Seed editor rows from the read model's splits, preserving each leg's SIGN
 *  (a stored −55.83 credit seeds as "-55.83", not "55.83"). */
export function seedRowsFromSplits(splits: readonly SplitLike[]): SplitDraftRow[] {
  return splits.map((s) => ({
    categoryId: s.categoryLedgerAccountId,
    amount: minorToDollars(s.amountMinor),
  }));
}

/**
 * Seed a fresh split from a single-category transaction: two rows, the full
 * offset (−cash, debit-positive) on row 1 under the current category, row 2
 * empty (teardown C7). For an expense (cash −4300) row 1 is +43.00; for an
 * inflow (cash +4300) it is −43.00 (a credit), matching the posting.
 */
export function seedRowsForNewSplit(
  cashAmountMinor: string,
  currentCategoryId: string | null,
): SplitDraftRow[] {
  return [
    { categoryId: currentCategoryId, amount: minorToDollars((-BigInt(cashAmountMinor)).toString()) },
    { categoryId: null, amount: '' },
  ];
}
