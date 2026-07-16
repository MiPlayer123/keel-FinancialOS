import type { RichTransactionRow } from '@/lib/keel-api';
import type { CategorySpend } from '@/components/keel/charts';

/**
 * Stable pfc_keys (subcategories migration) for the two seeded buckets that are
 * money-movement, not spending: "Loan Payments" (credit-card / loan payoffs)
 * and "Transfers". pfc_key is rename-proof — the display name is user-editable.
 */
const DEBT_TRANSFER_PFC_KEYS = new Set(['loan_payments', 'transfers']);

/**
 * Same two buckets by seeded display name, for shapes that carry a category
 * name but no pfc_key (e.g. `budgets.list` rows).
 */
const DEBT_TRANSFER_CATEGORY_NAMES = new Set(['loan payments', 'transfers']);

/**
 * Conservative credit-card / loan payoff memo patterns for the payment leg that
 * hasn't been paired into a confirmed transfer yet. Deliberately narrow — a
 * false negative (a real payoff slips through as spend) is safer than a false
 * positive (real spend stripped from analytics), so each pattern demands the
 * word "payment" plus an explicit card/credit cue.
 */
const CC_PAYOFF_PATTERNS: readonly RegExp[] = [
  // "Payment To Chase card ending 1234", "AUTOPAY PAYMENT ... CREDIT CARD"
  /payment\b.*\b(credit )?card\b/i,
  // "ONLINE PAYMENT ... TO ... CREDIT CARD" / "... TO ... CARD"
  /online payment\b.*\bto\b.*\b(card|credit)\b/i,
  // Classic card-statement memo on the incoming payment leg
  /payment thank you/i,
];

/** The fields `isDebtOrTransferLike` inspects — a subset of RichTransactionRow. */
export type DebtOrTransferLike = Pick<
  RichTransactionRow,
  'transferStatus' | 'categoryName' | 'description'
> &
  Partial<Pick<RichTransactionRow, 'categoryPfcKey' | 'originalDescription'>>;

/**
 * True when a row is money-movement or debt payoff rather than real spend, so
 * spend analytics can drop it. Any single predicate is sufficient:
 *  1. transferStatus is confirmed OR suggested — a detected transfer leg.
 *     (Only 'confirmed' was excluded before; unconfirmed legs polluted spend.)
 *  2. the category is the PFC "Loan Payments"/"Transfers" bucket — matched by
 *     rename-proof pfc_key when present, else by seeded display name.
 *  3. the raw memo matches a conservative CC/loan-payoff pattern — the payment
 *     leg before any transfer pairing exists.
 * Conservative by design: prefers false negatives over stripping real spend.
 */
export function isDebtOrTransferLike(txn: DebtOrTransferLike): boolean {
  // (1) detected transfer leg, confirmed or merely suggested.
  if (txn.transferStatus === 'confirmed' || txn.transferStatus === 'suggested') return true;
  // (2) the debt/transfer category buckets.
  const pfc = txn.categoryPfcKey;
  if (pfc != null && DEBT_TRANSFER_PFC_KEYS.has(pfc)) return true;
  if (
    txn.categoryName != null &&
    DEBT_TRANSFER_CATEGORY_NAMES.has(txn.categoryName.trim().toLowerCase())
  ) {
    return true;
  }
  // (3) CC/loan payoff memo on the raw (provider) description when available.
  const raw = txn.originalDescription ?? txn.description;
  return CC_PAYOFF_PATTERNS.some((re) => re.test(raw));
}

/**
 * Count of rows that read as debt/transfer movement but are NOT confirmed
 * transfers yet — the population a "confirm your transfers" nudge surfaces
 * (numbers that exclude them may shift once the user confirms; Law 9).
 */
export function unconfirmedTransferLikeCount(rows: DebtOrTransferLike[]): number {
  return rows.reduce(
    (n, t) => (t.transferStatus !== 'confirmed' && isDebtOrTransferLike(t) ? n + 1 : n),
    0,
  );
}

/**
 * Expense totals by category over the trailing N days. Transfers and debt
 * payments are excluded (moving money isn't spending); BigInt sums (Law 4);
 * top 6 + Other so the list never sprawls.
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
