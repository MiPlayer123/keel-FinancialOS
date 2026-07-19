// NORMALIZER_VERSION bumped to v2 alongside the recurring-grid-v2 quality gate:
// v2 adds deterministic P2P / reward / refund suppression (docs/RECURRING-RESEARCH.md
// item C). The counterparty *string* normalization itself is unchanged, but the
// version is part of the grouping key and the candidate input fingerprint, so a
// bump correctly re-groups and re-detects under the new suppression rules.
export const NORMALIZER_VERSION = 'counterparty-v2' as const;

export const normalizeCounterparty = (description: string): string => {
  const normalized = description
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ')
    .replace(/\b(?:store|shop)\s*#?\s*\d+\b/gu, ' ')
    .replace(/(?:\s|#)\d+\s*$/gu, ' ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
  return normalized.length === 0 ? 'unknown' : normalized;
};

// ---------------------------------------------------------------------------
// Recurring suppression (docs/RECURRING-RESEARCH.md item C).
//
// Personal peer-to-peer rails (Venmo / Zelle / Cash App — NOT PayPal, a mixed
// rail; see P2P_PATTERNS) and
// reward / cashback / refund lines are NOT subscriptions or bills, even when the
// same counterparty repeats ≥3× on a regular-looking cadence. Industry detectors
// (Plaid, Monarch, Copilot, Rocket Money) all exclude these. KEEL suppresses them
// deterministically at detection so they are never OFFERED as a recurring series.
//
// This is SUGGESTION SUPPRESSION, not deletion (Law 6): the underlying
// transactions stay in the ledger, in every read model, and in full export. They
// simply do not surface as a recurring candidate. No LLM, no floats — a pure,
// deterministic string test over the already-data-tier description (Law 1/5).
//
// The reasons are enumerated so callers (and tests) can assert *why* a series was
// suppressed rather than only *that* it was.
export type SuppressionReason = 'p2p' | 'reward';

// Personal P2P rails. Word-boundary-ish matching on the normalized-ish text so
// e.g. a merchant literally named "Venmo Inc" (the company) is still caught — the
// research treats the rail itself as non-subscription.
//
// PayPal is DELIBERATELY NOT here (review P2, docs/RECURRING-RESEARCH.md item C).
// Venmo / Zelle / Cash App / Square Cash are pure personal rails, but PayPal is a
// MIXED rail: real merchant subscriptions bill through it, and the bank memo leads
// with the rail token — e.g. "PAYPAL *SPOTIFY", "PP*NYTIMES", "PAYPAL *HULU". A
// bare \bpaypal\b (or \bpp\*) suppressed every one of those genuine PayPal-billed
// subscriptions, which is over-suppression. The safe default is to let PayPal-
// billed lines flow into detection; the A quality gate + amount/cadence regularity
// still reject irregular personal PayPal transfers. (If we ever want to catch
// PERSONAL PayPal transfers specifically, match a clear personal-transfer
// qualifier — never the bare rail token.)
const P2P_PATTERNS: readonly RegExp[] = [
  /\bvenmo\b/u,
  /\bzelle\b/u,
  /\bcash\s*app\b/u,
  /\bcashapp\b/u,
  /\bsquare\s*cash\b/u,
];

// Reward / cashback / refund / rebate credits. These are inflow noise that snaps
// to nearby cadence slots but is not income the user "receives" on a schedule.
const REWARD_PATTERNS: readonly RegExp[] = [
  /\bcash\s*back\b/u,
  /\bcashback\b/u,
  /\breward(?:s)?\b/u,
  /\brefund(?:ed|s)?\b/u,
  /\brebate(?:s)?\b/u,
  /\bstatement\s+credit\b/u,
];

/**
 * Deterministic recurring-suppression classifier. Returns the reason a
 * transaction description should be kept OUT of recurring suggestions, or null
 * if it is eligible for detection. Case-insensitive; operates on the raw
 * description (data-tier text, never executed — Law 5).
 */
export const recurringSuppressionReason = (
  description: string,
): SuppressionReason | null => {
  const text = description.toLowerCase();
  for (const pattern of P2P_PATTERNS) {
    if (pattern.test(text)) return 'p2p';
  }
  for (const pattern of REWARD_PATTERNS) {
    if (pattern.test(text)) return 'reward';
  }
  return null;
};

export const isSuppressedFromRecurring = (description: string): boolean =>
  recurringSuppressionReason(description) !== null;
