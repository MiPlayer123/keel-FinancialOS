import type {
  CategorySuggestionRow,
  ConnectionRow,
  ForecastBill,
  RecurringSeriesRow,
  RichTransactionRow,
  TransferLinkRow,
} from '@/lib/keel-api';

/**
 * Pure aggregation behind Home's "Needs attention" module (teardown C16):
 * every ACTIONABLE count on one card, each row deep-linking to the page where
 * the action happens. Law 1 — deterministic counting only, no model anywhere;
 * Law 8 — counts are neutral status, never red (red is negative money only).
 */

/** The fields `isUncategorized` inspects — a subset of RichTransactionRow. */
export type UncategorizedLike = Pick<
  RichTransactionRow,
  'categoryPfcKey' | 'categoryName' | 'splits'
>;

/**
 * Rename-proof "is it still on a landing pad?" check: the stable pfc_key when
 * the migration has landed, the seeded name as a fallback until then. Split
 * transactions are categorized by their splits — never "uncategorized".
 * (Single definition; `txn-edit-dialog` re-exports it for its consumers.)
 */
export function isUncategorized(t: UncategorizedLike): boolean {
  if (t.splits && t.splits.length > 0) return false;
  if (t.categoryPfcKey != null) return t.categoryPfcKey.startsWith('uncategorized');
  return t.categoryName ? t.categoryName.startsWith('Uncategorized') : true;
}

export type AttentionRow = {
  key: 'review' | 'bills' | 'reauth' | 'uncategorized';
  count: number;
  /** One-line label WITHOUT the count — the UI renders the number adjacent (Law 8). */
  label: string;
  href: string;
};

/**
 * Nullable inputs are "still loading" (useKeelQuerySilent semantics) and
 * contribute zero — the module appears calmly as data lands rather than
 * flashing a wrong total.
 */
export type NeedsAttentionInput = {
  /** recurring.list — same source ReviewBadge counts. */
  recurring: Pick<RecurringSeriesRow, 'status'>[] | null;
  /** transfers.list — same source ReviewBadge counts. */
  transfers: Pick<TransferLinkRow, 'status'>[] | null;
  /** categorization.suggestions — same source ReviewBadge counts. */
  categorizations: Pick<CategorySuggestionRow, 'status'>[] | null;
  /** dashboard.cash_flow_forecast bills (already fetched for Projected cash). */
  bills: Pick<ForecastBill, 'date' | 'sign'>[] | null;
  connections: Pick<ConnectionRow, 'status'>[] | null;
  /** transactions.rich rows (already fetched for insights/spending). */
  transactions: UncategorizedLike[] | null;
  /** YYYY-MM-DD, injected so the derivation is deterministic under test. */
  todayIso: string;
};

/** Days ahead that count as "due soon" for the bills row. */
export const BILLS_DUE_HORIZON_DAYS = 7;

/** ISO date + n days, UTC — string compare stays valid across month ends. */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function countSuggested(rows: { status: string }[] | null): number {
  return rows === null ? 0 : rows.filter((r) => r.status === 'suggested').length;
}

/**
 * The card's rows, fixed order, zero-count rows dropped (calm > clutter —
 * an empty array means the module hides entirely).
 */
export function buildNeedsAttention(input: NeedsAttentionInput): AttentionRow[] {
  const reviewCount =
    countSuggested(input.recurring) +
    countSuggested(input.transfers) +
    countSuggested(input.categorizations);

  const horizonIso = addDaysIso(input.todayIso, BILLS_DUE_HORIZON_DAYS);
  const billsCount = (input.bills ?? []).filter(
    (b) => b.sign === 'outflow' && b.date >= input.todayIso && b.date <= horizonIso,
  ).length;

  const reauthCount = (input.connections ?? []).filter(
    (c) => c.status === 'reauth_required',
  ).length;

  const uncategorizedCount = (input.transactions ?? []).filter(isUncategorized).length;

  const rows: AttentionRow[] = [
    {
      key: 'review',
      count: reviewCount,
      label: reviewCount === 1 ? 'suggestion to review' : 'suggestions to review',
      href: '/dashboard/review',
    },
    {
      key: 'bills',
      count: billsCount,
      label:
        billsCount === 1
          ? 'bill due within 7 days'
          : 'bills due within 7 days',
      href: '/dashboard/recurring',
    },
    {
      key: 'reauth',
      count: reauthCount,
      label:
        reauthCount === 1
          ? 'connection needs reconnecting'
          : 'connections need reconnecting',
      href: '/dashboard/connections',
    },
    {
      key: 'uncategorized',
      count: uncategorizedCount,
      label:
        uncategorizedCount === 1
          ? 'uncategorized transaction'
          : 'uncategorized transactions',
      href: '/dashboard/ledger?category=uncategorized',
    },
  ];
  return rows.filter((r) => r.count > 0);
}
