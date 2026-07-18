/**
 * Deterministic receipt→transaction matcher (Law 1: the matcher is arithmetic;
 * the LLM only extracts fields from pixels, upstream). Given one extraction and
 * a candidate set of cash transactions in scope, it blocks by amount+date,
 * scores each survivor with integer arithmetic, and decides between a single
 * pre-selected suggestion, a multi-candidate list, or nothing.
 *
 * Precision-first: a wrong pre-selected match that a user rubber-stamps
 * corrupts the ledger's evidence layer, so the thresholds bias toward "no
 * suggestion" over "wrong suggestion" (RECEIPTS-2026-07-16 §2). All money is
 * BIGINT minor units carried as bigint here (parsed from decimal strings at the
 * boundary). Ties break by (score desc, |date gap| asc, id asc) so replays
 * produce identical rankings (reproducible numbers, invariant 7).
 *
 * Pure: no I/O, no Supabase, no model.
 */
import { merchantSimilarity } from './normalize.js';
import type { ReceiptExtraction } from './extraction.js';

/** A cash transaction the receipt might match. Amount is the account-side
 * posting in minor units; sign follows the ledger (outflow negative). */
export interface CandidateTransaction {
  readonly transactionId: string;
  /** Signed account-side amount, minor units, decimal string. */
  readonly amountMinor: string;
  readonly currency: string;
  /** YYYY-MM-DD. */
  readonly effectiveDate: string;
  /** Display/bank descriptor (data-tier). */
  readonly description: string;
  /** True if a CONFIRMED receipt is already attached for the full amount. */
  readonly hasConfirmedMatch: boolean;
  /** True if this (document, txn) pair was previously rejected — never re-suggest. */
  readonly previouslyRejected: boolean;
}

export type ReasonCode =
  | 'AMOUNT_EXACT'
  | 'AMOUNT_TIP_RANGE'
  | 'DATE_SAME_DAY'
  | 'DATE_1D'
  | 'DATE_2_3D'
  | 'DATE_4_5D'
  | 'MERCHANT_EXACT'
  | 'MERCHANT_FUZZY';

export interface ScoredCandidate {
  readonly transactionId: string;
  readonly score: number;
  readonly reasonCodes: readonly ReasonCode[];
  /** Absolute day gap (receipt date → txn date), for tie-break + UI. */
  readonly dayGap: number;
}

export type MatchOutcome =
  | { readonly kind: 'suggest'; readonly candidate: ScoredCandidate }
  | { readonly kind: 'multi'; readonly candidates: readonly ScoredCandidate[] }
  | { readonly kind: 'none' };

/** Tunable thresholds (RECEIPTS-2026-07-16 §2). Committed values, logged in NOTES.md. */
export interface MatcherConfig {
  /** Date window: [receipt−before, receipt+after]. Settle lag is forward-skewed. */
  readonly dateBeforeDays: number;
  readonly dateAfterDays: number;
  /** Tip headroom: a card txn may exceed the receipt total by up to this fraction (bps). */
  readonly tipToleranceBps: number;
  /** Single-suggestion floor. */
  readonly suggestScore: number;
  /** Minimum gap to #2 for a single pre-selected suggestion. */
  readonly suggestGap: number;
  /** Below this, no candidate is offered at all. */
  readonly minMultiScore: number;
  /** Merchant fuzzy similarity that counts as a match signal. */
  readonly merchantFuzzyFloor: number;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  dateBeforeDays: 1,
  dateAfterDays: 5,
  tipToleranceBps: 2500, // 25%
  suggestScore: 75,
  suggestGap: 15,
  minMultiScore: 50,
  merchantFuzzyFloor: 0.6,
};

export const MATCHER_VERSION = 'keel-receipt-matcher@v1';

/** Whole-day difference b − a for two YYYY-MM-DD strings, via UTC epoch days. */
const dayDiff = (a: string, b: string): number => {
  const toDays = (iso: string): number => {
    const [y, m, d] = iso.split('-').map((p) => Number(p));
    return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
  };
  return toDays(b) - toDays(a);
};

interface ScoreParts {
  readonly score: number;
  readonly reasonCodes: ReasonCode[];
}

/** Amount component: exact wins big; a card txn slightly OVER the receipt (tip)
 * scores lower; anything outside the band drops the candidate (null). */
const scoreAmount = (
  receiptMinor: bigint,
  txnMinor: bigint,
  config: MatcherConfig,
): { readonly points: number; readonly code: ReasonCode } | null => {
  const txnAbs = txnMinor < 0n ? -txnMinor : txnMinor;
  const receiptAbs = receiptMinor < 0n ? -receiptMinor : receiptMinor;
  if (txnAbs === receiptAbs) return { points: 50, code: 'AMOUNT_EXACT' };
  // Tip band: txn strictly greater than receipt, up to tolerance over.
  if (txnAbs > receiptAbs) {
    const maxWithTip = receiptAbs + (receiptAbs * BigInt(config.tipToleranceBps)) / 10_000n;
    if (txnAbs <= maxWithTip) return { points: 30, code: 'AMOUNT_TIP_RANGE' };
  }
  return null;
};

/** Date component: closer is better; direction-agnostic within the window. */
const scoreDate = (dayGap: number): { readonly points: number; readonly code: ReasonCode } => {
  const g = Math.abs(dayGap);
  if (g === 0) return { points: 25, code: 'DATE_SAME_DAY' };
  if (g === 1) return { points: 20, code: 'DATE_1D' };
  if (g <= 3) return { points: 12, code: 'DATE_2_3D' };
  return { points: 5, code: 'DATE_4_5D' };
};

/** Merchant component: exact-normalized best, graded fuzzy, else nothing. */
const scoreMerchant = (
  receiptMerchant: string | null,
  txnDescription: string,
  config: MatcherConfig,
): { readonly points: number; readonly code: ReasonCode } | null => {
  if (receiptMerchant === null) return null;
  const sim = merchantSimilarity(receiptMerchant, txnDescription);
  if (sim >= 1) return { points: 25, code: 'MERCHANT_EXACT' };
  if (sim >= config.merchantFuzzyFloor) {
    // Grade fuzzy 10..20 across [floor, 1). This block is only entered when
    // floor ≤ sim < 1, so floor < 1 and span > 0 (no divide-by-zero possible).
    const span = 1 - config.merchantFuzzyFloor;
    const graded = 10 + Math.round((10 * (sim - config.merchantFuzzyFloor)) / span);
    return { points: Math.min(20, graded), code: 'MERCHANT_FUZZY' };
  }
  return null;
};

const scoreCandidate = (
  extraction: ReceiptExtraction,
  receiptMinor: bigint,
  candidate: CandidateTransaction,
  config: MatcherConfig,
): { readonly parts: ScoreParts; readonly dayGap: number } | null => {
  // Blocking guards first.
  if (extraction.currency === null || candidate.currency !== extraction.currency) return null;
  if (candidate.hasConfirmedMatch || candidate.previouslyRejected) return null;
  if (extraction.txnDate === null) return null;

  const gap = dayDiff(extraction.txnDate, candidate.effectiveDate);
  if (gap < -config.dateBeforeDays || gap > config.dateAfterDays) return null;

  const amount = scoreAmount(receiptMinor, BigInt(candidate.amountMinor), config);
  if (amount === null) return null;

  const date = scoreDate(gap);
  const merchant = scoreMerchant(extraction.merchant, candidate.description, config);

  const reasonCodes: ReasonCode[] = [amount.code, date.code];
  let score = amount.points + date.points;
  if (merchant !== null) {
    reasonCodes.push(merchant.code);
    score += merchant.points;
  }
  return { parts: { score, reasonCodes }, dayGap: Math.abs(gap) };
};

/**
 * Rank every survivor deterministically. Order: score desc, dayGap asc,
 * transactionId asc — so identical inputs always produce an identical ranking.
 */
export const scoreCandidates = (
  extraction: ReceiptExtraction,
  candidates: readonly CandidateTransaction[],
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): ScoredCandidate[] => {
  if (extraction.totalMinor === null) return [];
  const receiptMinor = BigInt(extraction.totalMinor);
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(extraction, receiptMinor, candidate, config);
    if (result === null) continue;
    scored.push({
      transactionId: candidate.transactionId,
      score: result.parts.score,
      reasonCodes: result.parts.reasonCodes,
      dayGap: result.dayGap,
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.dayGap !== b.dayGap) return a.dayGap - b.dayGap;
    return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
  });
  return scored;
};

/**
 * Decide the outcome from a ranked list:
 *   top ≥ suggestScore and (no #2 OR gap-to-#2 ≥ suggestGap) → single suggestion
 *   top ≥ minMultiScore                                       → multi-candidate list
 *   otherwise                                                 → none
 */
export const decideMatch = (
  extraction: ReceiptExtraction,
  candidates: readonly CandidateTransaction[],
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): MatchOutcome => {
  const ranked = scoreCandidates(extraction, candidates, config);
  if (ranked.length === 0) return { kind: 'none' };
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  const gap = runnerUp ? top.score - runnerUp.score : Number.POSITIVE_INFINITY;

  if (top.score >= config.suggestScore && gap >= config.suggestGap) {
    return { kind: 'suggest', candidate: top };
  }
  if (top.score >= config.minMultiScore) {
    // Only surface candidates that clear the multi floor.
    const shown = ranked.filter((c) => c.score >= config.minMultiScore);
    return { kind: 'multi', candidates: shown };
  }
  return { kind: 'none' };
};
