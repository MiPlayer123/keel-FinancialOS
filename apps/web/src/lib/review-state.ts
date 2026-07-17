/**
 * Reviewed/unreviewed categorization state (P0-B follow-up #1/#2 —
 * design/TEARDOWN-STATUS-2026-07-17.md queue items 2/3). The primitive
 * already existed: `transaction_categories.source` ('user' | 'rule' |
 * 'plaid_pfc') distinguishes a human decision from whatever a rule or the
 * bank's own PFC mapping filed automatically (Law 9 explicit ownership —
 * inference must never be silently treated as fact). This module is pure
 * derivation only — no new state, no arithmetic (Law 1 n/a).
 *
 * Multi-split transactions carry NO transaction_categories overlay row at
 * all (20260717190000_set_splits.sql §"Overlay coherence": a re-split to
 * MULTIPLE categories deletes it) — but a split can only exist because a
 * user built it through the audited `transactions.set_splits` command, so a
 * split is reviewed-equivalent by construction, not by overlay source.
 */
import type { RichTransactionRow } from '@/lib/keel-api';

/** The fields these checks inspect — a subset of RichTransactionRow. */
export type CategorySourceLike = Pick<RichTransactionRow, 'categorySource' | 'splits'>;

/**
 * True when the CURRENT category was filed by a rule or the bank's PFC
 * mapping and no human has looked at it — the "Auto" badge condition.
 * Splits and user-confirmed rows (source 'user') are never "auto"; neither
 * is a transaction still parked on the Uncategorized landing pad (nothing
 * was ever assigned, so there is nothing to badge as machine-assigned).
 */
export function isAutoCategorized(t: CategorySourceLike): boolean {
  if (t.splits && t.splits.length > 0) return false;
  return t.categorySource === 'rule' || t.categorySource === 'plaid_pfc';
}

/**
 * True when a human has looked at and confirmed this categorization —
 * source 'user', or a split (built only via the audited set-splits command).
 * Not the logical negation of isAutoCategorized: an untouched Uncategorized
 * row is neither auto nor reviewed.
 */
export function isReviewedCategory(t: CategorySourceLike): boolean {
  if (t.splits && t.splits.length > 0) return true;
  return t.categorySource === 'user';
}
