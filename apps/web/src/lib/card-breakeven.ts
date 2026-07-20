import type { RichTransactionRow } from '@/lib/keel-api';

/**
 * Credit-card rewards vs annual-fee break-even (Law 1 deterministic, Law 4
 * BigInt minor units, Law 9 reproducible — callers pass rows already reduced to
 * a stated scope + date range and render the scope in a footnote).
 *
 * The founder's mental model: an annual fee (e.g. a $795 card membership fee) is
 * a *cost*; a reward / statement credit / cashback (money the household RECEIVED
 * on the card) *offsets* it; at year-end he wants to know whether rewards ≥ fees
 * ("did the card pay for itself?").
 *
 * KEEL's ledger already expresses this with account KINDS, not by cramming a
 * positive number into an expense category (which keel_categorize_transaction
 * rightly forbids — an income posting is a credit, an expense posting a debit,
 * and moving across kinds would break the Σ=0 sign conventions the cash-flow
 * graph uses). So this view PAIRS the two kinds on a card rather than merging
 * them:
 *   - REWARDS  = income the user has EXPLICITLY filed as card rewards — the
 *                seeded "Credit card rewards" category (rename-proof pfc-key
 *                `income_card_rewards`), or a user-named rewards category. NOT
 *                all card income: a one-sided card payment that lands as
 *                "Uncategorized Income" (an unconfirmed transfer from checking)
 *                is money movement, not a reward, and must never inflate the
 *                figure (Law 9 — inference is never silently treated as fact;
 *                the number reflects what the user confirmed). `amountMinor` is
 *                cash-sign (positive = money received), so rewards sum the
 *                positive inflow.
 *   - FEES     = expense-kind activity on the card filed under a FEE category
 *                (rename-proof `fees` pfc-key family: annual/bank/ATM/interest/
 *                late fees) — the "Bank Charges" bucket. `amountMinor` is
 *                negative (money out), so fees sum `-amountMinor`.
 *   - NET      = rewards − fees. Net ≥ 0 ⇒ the card paid for itself in-scope.
 *
 * Deliberately NOT memo/description-based (Law 5 data-tier): a transaction is a
 * reward or a fee ONLY by its (kind, category) — never by parsing provider text.
 * Regular card SPEND is out of scope here: this pairs rewards against fees, not
 * against everything you charged.
 */

/** A credit card, by ledger convention: liability accounts carry subtype 'credit card'. */
export const CREDIT_CARD_SUBTYPE = 'credit card';

/**
 * Rename-proof fee-category pfc-key family (subcategories migration): the seeded
 * "Fees" parent (`fees`) and its subs (`fees_bank`, `fees_atm`, `fees_interest`,
 * `fees_late`). A user's own "Bank Charges"-style category created under the
 * Fees parent inherits no pfc_key, so we also accept a category the user has
 * explicitly marked as a fee via its parent — but since RichTransactionRow only
 * carries the leaf's own pfc_key, the deterministic rule here is: pfc_key in the
 * `fees` family. A custom top-level fee category (no fees pfc_key) is picked up
 * by name as a fallback, matching how the rest of the app handles unkeyed
 * user categories.
 */
function isFeePfcKey(pfcKey: string): boolean {
  return pfcKey === 'fees' || pfcKey.startsWith('fees_');
}

/** Fallback for user-created fee categories with no pfc_key (never renames a keyed one). */
function looksLikeFeeName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n.includes('fee') ||
    n.includes('bank charge') ||
    n.includes('annual membership') ||
    n === 'annual fee'
  );
}

/** The seeded rewards category's rename-proof key (migration 20260723030000). */
const REWARDS_PFC_KEY = 'income_card_rewards';

/** Fallback for a user-created rewards category with no pfc_key. */
function looksLikeRewardName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n.includes('reward') ||
    n.includes('cash back') ||
    n.includes('cashback') ||
    n.includes('statement credit') ||
    n.includes('redemption')
  );
}

/** True when an expense row on a card is a FEE (annual/bank charge), not ordinary spend. */
export function isCardFeeRow(txn: RichTransactionRow): boolean {
  if (txn.categoryKind !== 'expense') return false;
  const pfc = txn.categoryPfcKey;
  if (pfc != null && pfc.length > 0) return isFeePfcKey(pfc);
  // Unkeyed user category: name fallback (same posture as unkeyed transfers).
  return txn.categoryName != null && looksLikeFeeName(txn.categoryName);
}

/**
 * True when an income row on a card is a confirmed REWARD / statement credit /
 * cashback — the seeded rewards category (pfc `income_card_rewards`) or a
 * user-named rewards category. Deliberately NOT every income row: an
 * "Uncategorized Income" inflow on a card is almost always a card payment that
 * hasn't been confirmed as a transfer (money movement), and counting it would
 * fabricate rewards the user never earned.
 */
export function isCardRewardRow(txn: RichTransactionRow): boolean {
  if (txn.categoryKind !== 'income') return false;
  const pfc = txn.categoryPfcKey;
  if (pfc != null && pfc.length > 0) return pfc === REWARDS_PFC_KEY;
  return txn.categoryName != null && looksLikeRewardName(txn.categoryName);
}

export type CardBreakEven = {
  accountId: string;
  accountName: string;
  currency: string;
  /** Total rewards / statement credits received on the card, minor units (≥ 0). */
  rewardsMinor: bigint;
  /** Total fees / annual charges paid on the card, minor units (≥ 0). */
  feesMinor: bigint;
  /** rewardsMinor − feesMinor. ≥ 0 ⇒ the card paid for itself in-scope. */
  netMinor: bigint;
  /** How many reward rows and fee rows fed the totals (evidence count, Law 9). */
  rewardCount: number;
  feeCount: number;
};

/**
 * Per-credit-card rewards-vs-fees break-even over the rows the caller passes
 * (already account/entity/date scoped, same input every reports widget uses).
 * Only credit-card accounts appear. Split transactions are handled at the split
 * grain: a reward or fee share inside a split counts on its own (a card almost
 * never splits a fee/reward, but the ledger allows it and we stay consistent).
 * A card with neither rewards nor fees in-scope is omitted (nothing to break
 * even on). Deterministic order: net ascending (worst first — the card most
 * "in the hole" leads), then name, then id. BigInt throughout (Law 4).
 */
export function cardBreakEven(
  rows: RichTransactionRow[],
  creditCardAccountIds: ReadonlySet<string>,
): CardBreakEven[] {
  const byCard = new Map<
    string,
    {
      accountName: string;
      currency: string;
      rewardsMinor: bigint;
      feesMinor: bigint;
      rewardCount: number;
      feeCount: number;
    }
  >();

  for (const t of rows) {
    if (!creditCardAccountIds.has(t.accountId)) continue;
    const entry =
      byCard.get(t.accountId) ??
      ({
        accountName: t.accountName,
        currency: t.currency,
        rewardsMinor: 0n,
        feesMinor: 0n,
        rewardCount: 0,
        feeCount: 0,
      } satisfies {
        accountName: string;
        currency: string;
        rewardsMinor: bigint;
        feesMinor: bigint;
        rewardCount: number;
        feeCount: number;
      });

    // Split-aware: attribute reward/fee shares individually. `amountMinor` on a
    // split share is the POSTING amount (debit-positive): expense shares are
    // positive spend, income shares are negative (credits) — so a reward share
    // is `-share` and a fee share is `share`.
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        const share = BigInt(s.amountMinor || '0');
        if (s.kind === 'income' && s.categoryLedgerAccountId !== null) {
          // Splits carry no pfc_key, so a reward split is recognized by category
          // name only — the same unkeyed fallback used for single-offset rows.
          const reward = -share;
          if (looksLikeRewardName(s.name) && reward > 0n) {
            entry.rewardsMinor += reward;
            entry.rewardCount += 1;
          }
        } else if (s.kind === 'expense' && s.categoryLedgerAccountId !== null) {
          // Splits carry no pfc_key (TransactionSplit), so a fee split is
          // recognized by category name only — the same unkeyed fallback used
          // for single-offset rows whose category has no pfc_key.
          if (looksLikeFeeName(s.name) && share > 0n) {
            entry.feesMinor += share;
            entry.feeCount += 1;
          }
        }
      }
      byCard.set(t.accountId, entry);
      continue;
    }

    // Single-offset row: `amountMinor` is CASH sign (positive = money received).
    const cash = BigInt(t.amountMinor || '0');
    if (isCardRewardRow(t)) {
      if (cash > 0n) {
        entry.rewardsMinor += cash;
        entry.rewardCount += 1;
      }
    } else if (isCardFeeRow(t)) {
      const fee = -cash;
      if (fee > 0n) {
        entry.feesMinor += fee;
        entry.feeCount += 1;
      }
    }
    byCard.set(t.accountId, entry);
  }

  const out: CardBreakEven[] = [];
  for (const [accountId, e] of byCard) {
    if (e.rewardsMinor === 0n && e.feesMinor === 0n) continue;
    out.push({
      accountId,
      accountName: e.accountName,
      currency: e.currency,
      rewardsMinor: e.rewardsMinor,
      feesMinor: e.feesMinor,
      netMinor: e.rewardsMinor - e.feesMinor,
      rewardCount: e.rewardCount,
      feeCount: e.feeCount,
    });
  }
  out.sort((a, b) => {
    if (a.netMinor !== b.netMinor) return a.netMinor < b.netMinor ? -1 : 1;
    const byName = a.accountName.localeCompare(b.accountName);
    if (byName !== 0) return byName;
    return a.accountId.localeCompare(b.accountId);
  });
  return out;
}
