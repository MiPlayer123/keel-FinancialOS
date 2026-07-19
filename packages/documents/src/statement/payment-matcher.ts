/**
 * Pure mirror of the deterministic EXACT-ONLY card-payment matcher (Law 1: the
 * spine is arithmetic; no LLM). This exists so the matching rules can be
 * property-tested in pure TS ahead of the SQL implementation that lands in a
 * later slice (plan §5 `keel_statement_suggest_payments`). The SQL version is
 * authoritative at runtime; this mirror is the executable specification.
 *
 * V1 rules (plan §5, fully specified):
 *   - Candidate must be on a liability/card account (caller filters), an INFLOW
 *     to that card (a payment reduces the card's balance) — modeled here as the
 *     sign convention `paymentSignPositive`.
 *   - Same currency as the statement.
 *   - Status ∈ posted|reviewed and not void (caller filters via `eligible`).
 *   - Date window: [periodEnd, periodEnd + windowDays] INCLUSIVE (default 35d).
 *   - Amount: EXACTLY |endingMinor| — no tolerance in V1.
 *   - Never resurrect a previously rejected pair.
 *   - score = 100 on an exact match.
 *   - Tie-break: prefer an existing transfer-link pair → nearest date →
 *     lowest transaction id.
 *   - More than one exact survivor → ABSTAIN with reason 'ambiguous'
 *     (never auto-confirm, never guess).
 *
 * All money is BIGINT minor units, parsed from decimal strings at the boundary
 * (Law 4). Pure: no I/O, no Supabase, no model.
 */

/** Version stamp recorded on every produced link (mirrors matcher_version). */
export const STATEMENT_PAYMENT_MATCHER_VERSION = 'keel-statement-payment-matcher@v1';

/** Default forward window after period end, inclusive, in days. */
export const DEFAULT_PAYMENT_WINDOW_DAYS = 35;

/** A candidate ledger transaction that might be the card payment. */
export interface PaymentCandidate {
  readonly transactionId: string;
  /** Signed minor-unit amount on the card account side, decimal string. */
  readonly amountMinor: string;
  readonly currency: string;
  /** YYYY-MM-DD effective/posted date. */
  readonly effectiveDate: string;
  /** True if status ∈ posted|reviewed and not void (caller pre-filters). */
  readonly eligible: boolean;
  /** True if this (statement, txn) pair was previously rejected. */
  readonly previouslyRejected: boolean;
  /** True if this txn is already one leg of a confirmed transfer link. */
  readonly hasTransferLink: boolean;
}

/** The statement side of the match. */
export interface StatementPaymentContext {
  /** YYYY-MM-DD statement period end. */
  readonly periodEnd: string;
  /** Ending balance in minor units, decimal string (its absolute value is the
   * payment amount to look for). */
  readonly endingMinor: string;
  readonly currency: string;
}

export type PaymentReasonCode = 'AMOUNT_EXACT' | 'DATE_IN_WINDOW' | 'TRANSFER_LINK_PAIR';

export interface PaymentMatch {
  readonly transactionId: string;
  readonly score: number;
  readonly reasonCodes: readonly PaymentReasonCode[];
  readonly matcherVersion: string;
}

export type PaymentOutcome =
  | { readonly kind: 'suggest'; readonly match: PaymentMatch }
  | { readonly kind: 'abstain'; readonly reason: 'ambiguous' }
  | { readonly kind: 'none' };

export interface PaymentMatcherConfig {
  readonly windowDays: number;
}

export const DEFAULT_PAYMENT_MATCHER_CONFIG: PaymentMatcherConfig = {
  windowDays: DEFAULT_PAYMENT_WINDOW_DAYS,
};

/** Whole-day difference b − a for two YYYY-MM-DD strings, via UTC epoch days. */
const dayDiff = (a: string, b: string): number => {
  const toDays = (iso: string): number => {
    const [y = '0', m = '1', d = '1'] = iso.split('-');
    return Math.floor(Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86_400_000);
  };
  return toDays(b) - toDays(a);
};

/** Absolute value of a signed minor-unit decimal string, as bigint. */
const absMinor = (s: string): bigint => {
  const v = BigInt(s);
  return v < 0n ? -v : v;
};

/**
 * Decide the exact-only payment match. Returns a single suggestion, an
 * abstention on ambiguity (≥2 exact survivors), or none. Deterministic:
 * survivors are ranked by (transfer-link pair, nearest date, lowest id) but a
 * suggestion is only emitted when exactly ONE exact survivor exists — parity
 * with the SQL `>1 exact → abstain` ruling.
 */
export const decidePaymentMatch = (
  statement: StatementPaymentContext,
  candidates: readonly PaymentCandidate[],
  config: PaymentMatcherConfig = DEFAULT_PAYMENT_MATCHER_CONFIG,
): PaymentOutcome => {
  const target = absMinor(statement.endingMinor);

  const survivors = candidates.filter((c) => {
    if (!c.eligible || c.previouslyRejected) return false;
    if (c.currency !== statement.currency) return false;
    const gap = dayDiff(statement.periodEnd, c.effectiveDate);
    if (gap < 0 || gap > config.windowDays) return false;
    return absMinor(c.amountMinor) === target;
  });

  const only = survivors[0];
  if (only === undefined) return { kind: 'none' };
  if (survivors.length > 1) return { kind: 'abstain', reason: 'ambiguous' };

  const reasonCodes: PaymentReasonCode[] = ['AMOUNT_EXACT', 'DATE_IN_WINDOW'];
  if (only.hasTransferLink) reasonCodes.push('TRANSFER_LINK_PAIR');
  return {
    kind: 'suggest',
    match: {
      transactionId: only.transactionId,
      score: 100,
      reasonCodes,
      matcherVersion: STATEMENT_PAYMENT_MATCHER_VERSION,
    },
  };
};

/**
 * Deterministic ranking used when a caller wants the ordered survivor list
 * (e.g. to display why an abstention happened). Order: transfer-link pair
 * first, then nearest date to period end, then lowest transaction id. Pure.
 */
export const rankPaymentSurvivors = (
  statement: StatementPaymentContext,
  candidates: readonly PaymentCandidate[],
  config: PaymentMatcherConfig = DEFAULT_PAYMENT_MATCHER_CONFIG,
): PaymentCandidate[] => {
  const target = absMinor(statement.endingMinor);
  const survivors = candidates.filter((c) => {
    if (!c.eligible || c.previouslyRejected) return false;
    if (c.currency !== statement.currency) return false;
    const gap = dayDiff(statement.periodEnd, c.effectiveDate);
    if (gap < 0 || gap > config.windowDays) return false;
    return absMinor(c.amountMinor) === target;
  });
  return [...survivors].sort((a, b) => {
    if (a.hasTransferLink !== b.hasTransferLink) return a.hasTransferLink ? -1 : 1;
    const ga = dayDiff(statement.periodEnd, a.effectiveDate);
    const gb = dayDiff(statement.periodEnd, b.effectiveDate);
    if (ga !== gb) return ga - gb;
    return a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0;
  });
};
