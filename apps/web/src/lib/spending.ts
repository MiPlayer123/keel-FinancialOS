import type { RichTransactionRow } from '@/lib/keel-api';
import type { CategorySpend } from '@/components/keel/charts';

/**
 * Stable pfc_keys (subcategories migration) for the seeded TRANSFER buckets that
 * are money-movement, not spending: "Transfers" (expense), "Transfers In"
 * (income) and "Transfers Out" (expense, 20260720140000 — an own-card payoff
 * debit). pfc_key is rename-proof — the display name is user-editable.
 *
 * IMPORTANT (20260720140000, SLICE D): "Loan Payments" is NO LONGER excluded.
 * A real recurring debt payment (mortgage, car, student loan) IS spending, and
 * the server (keel_txn_is_transfer_category / keel_cash_flow) only excludes the
 * transfer categories — never loan_payments. The one money-movement case that
 * used to hide inside loan_payments — an own-credit-card payoff — now routes to
 * its own "Transfers Out" category (a suggest→approve suggestion), so it is
 * excluded HERE via the `transfers_` family without also dropping genuine loan
 * payments. This keeps client SPENDING and server cash-flow in agreement.
 */
const DEBT_TRANSFER_PFC_KEYS = new Set(['transfers']);

/**
 * Seeded subcategories and the sign-split transfer categories carry prefixed
 * pfc_keys (`transfers_internal`, `transfers_in`, `transfers_out`). A row filed
 * under any is money-movement, so the exclusion covers the whole `transfers_`
 * family: exact parent key OR any key under its prefix.
 */
const DEBT_TRANSFER_PFC_PREFIXES = ['transfers_'] as const;

/** Rename-proof pfc_key check: exact transfer bucket or any seeded sub under it. */
function isDebtTransferPfcKey(pfcKey: string): boolean {
  if (DEBT_TRANSFER_PFC_KEYS.has(pfcKey)) return true;
  return DEBT_TRANSFER_PFC_PREFIXES.some((prefix) => pfcKey.startsWith(prefix));
}

/**
 * Same transfer buckets by seeded display name, for shapes that carry a category
 * name but no pfc_key (e.g. `budgets.list` rows). Exported so every surface
 * (budgets, rebalance) shares ONE definition rather than drifting copies.
 * Loan payments are intentionally absent (see DEBT_TRANSFER_PFC_KEYS).
 */
export const DEBT_TRANSFER_CATEGORY_NAMES: ReadonlySet<string> = new Set([
  'transfers',
  'transfers in',
  'transfers out',
]);

/** Shared name-based check for shapes without pfc_key (budgets.list rows). */
export function isMoneyMovementCategoryName(name: string): boolean {
  return DEBT_TRANSFER_CATEGORY_NAMES.has(name.trim().toLowerCase());
}

/** The fields `isDebtOrTransferLike` inspects — a subset of RichTransactionRow. */
export type DebtOrTransferLike = Pick<RichTransactionRow, 'transferStatus' | 'categoryName'> &
  Partial<Pick<RichTransactionRow, 'categoryPfcKey'>>;

/**
 * True when a row is money-movement or debt payoff rather than real spend, so
 * SPENDING analytics can drop it. Either predicate is sufficient:
 *  1. transferStatus === 'confirmed' — a user-approved transfer leg. Suggested
 *     legs are deliberately NOT excluded: a suggestion is unapproved inference,
 *     and the explicit-ownership invariant (Law 9 / BC-v2.1 §9.1) forbids
 *     silently treating it as fact. The nudge banner discloses the pending set.
 *  2. the category is the PFC "Loan Payments"/"Transfers" bucket — matched by
 *     rename-proof pfc_key when present, else by seeded display name. A
 *     deterministic, disclosed formula-scope rule (debt payments and transfers
 *     are money movement, not consumption), stated in every footnote that uses
 *     this predicate.
 *
 * Deliberately absent: memo/description pattern matching (Law 5 data-tier +
 * the NOTES "no memo interpretation" invariant — provider text and
 * user-editable names must never move analytics totals).
 *
 * SPENDING scope only. Cash metrics (free-to-spend "Spent so far", cash-flow)
 * must NOT use this predicate: an unpaired debt payment is real cash out, and
 * only confirmed transfer PAIRS net to zero.
 */
export function isDebtOrTransferLike(txn: DebtOrTransferLike): boolean {
  if (txn.transferStatus === 'confirmed') return true;
  const pfc = txn.categoryPfcKey;
  if (pfc != null && isDebtTransferPfcKey(pfc)) return true;
  return txn.categoryName != null && isMoneyMovementCategoryName(txn.categoryName);
}

/** The fields suggestedTransferCount inspects. */
export type SuggestedTransferLike = Pick<RichTransactionRow, 'transferStatus'> &
  Partial<Pick<RichTransactionRow, 'transactionId' | 'counterpartyTransactionId'>>;

/**
 * Number of SUGGESTED transfer pairings in `rows` — the actionable population
 * the Review page surfaces. Counts pairs, not legs (both legs of a suggestion
 * carry transferStatus === 'suggested'; naive row-counting doubles it). Pair
 * identity via counterpartyTransactionId; a leg whose counterpart is outside
 * the loaded window still counts once.
 */
export function suggestedTransferCount(rows: SuggestedTransferLike[]): number {
  const pairs = new Set<string>();
  let unpaired = 0;
  for (const t of rows) {
    if (t.transferStatus !== 'suggested') continue;
    const self = t.transactionId;
    const other = t.counterpartyTransactionId;
    if (self != null && other != null) {
      pairs.add(self < other ? `${self}:${other}` : `${other}:${self}`);
    } else {
      unpaired += 1;
    }
  }
  return pairs.size + Math.ceil(unpaired / 2);
}

/**
 * Expense totals by category over the trailing N days. Confirmed transfers and
 * the debt-payment/transfer category buckets are excluded (moving money isn't
 * spending); BigInt sums (Law 4); top 6 + Other so the list never sprawls.
 */
export function spendingMix(rows: RichTransactionRow[], days = 30): CategorySpend[] {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const totals = new Map<string, { total: bigint; currency: string }>();
  const add = (name: string, spend: bigint, currency: string) => {
    const entry = totals.get(name) ?? { total: 0n, currency };
    entry.total += spend;
    totals.set(name, entry);
  };
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.effectiveDate < cutoffIso) continue;
    // Split transactions carry their categories on the splits (categoryKind
    // is null at the top level) — attribute each expense share directly.
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== 'expense') continue;
        const share = BigInt(s.amountMinor || '0');
        if (share <= 0n) continue; // debit-positive: positive = spend
        add(s.name, share, t.currency);
      }
      continue;
    }
    if (t.categoryKind !== 'expense') continue;
    const amount = BigInt(t.amountMinor || '0');
    if (amount >= 0n) continue;
    add(t.categoryName ?? 'Uncategorized', -amount, t.currency);
  }

  const sorted = [...totals.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1));
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const items: CategorySpend[] = top.map(([name, v]) => ({
    name,
    totalMinor: v.total.toString(),
    currency: v.currency,
  }));
  if (rest.length > 0) {
    const otherTotal = rest.reduce((acc, [, v]) => acc + v.total, 0n);
    items.push({
      name: 'Other',
      totalMinor: otherTotal.toString(),
      currency: rest[0]?.[1].currency ?? 'USD',
    });
  }
  return items;
}
