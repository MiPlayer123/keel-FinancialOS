import type { BudgetMonthRow } from '@/lib/keel-api';

/**
 * Budget-vs-spending helpers for the Home Budget card and the Reports Budget
 * vs actual card. Numbers come straight from keel_budget_month (budget-v5:
 * a parent's spent already includes its unbudgeted children, so summing rows
 * never double counts). All money math is BigInt minor units; percentages are
 * only for drawing bars.
 */

export type BudgetStatus = 'over' | 'ahead' | 'on_track' | 'not_started';

/** "Ahead of pace" = share of budget used is more than this many points past the month's share. */
export const AHEAD_MARGIN_PCT = 10;

/** Share of the month elapsed (0–100) for `todayIso` inside `monthIso` (YYYY-MM-01). */
export function monthPacePct(monthIso: string, todayIso: string): number {
  const month = monthIso.slice(0, 7);
  const today = todayIso.slice(0, 7);
  if (today > month) return 100;
  if (today < month) return 0;
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  const day = Number(todayIso.slice(8, 10));
  // Whole percent, floored (display geometry only — not money).
  return Math.trunc((day * 100) / days);
}

/** Days left in the month after today (0 for past months). */
export function daysLeftInMonth(monthIso: string, todayIso: string): number {
  if (todayIso.slice(0, 7) !== monthIso.slice(0, 7)) return 0;
  const [y, m] = monthIso.slice(0, 7).split('-').map(Number);
  const days = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return Math.max(0, days - Number(todayIso.slice(8, 10)));
}

/** Percent of budget used, for bar widths only (uncapped; 0 when no budget). */
export function usedPct(spentMinor: bigint, availableMinor: bigint): number {
  if (availableMinor <= 0n) return spentMinor > 0n ? 100 : 0;
  return Number((spentMinor * 100n) / availableMinor);
}

export function budgetStatus(spentMinor: bigint, availableMinor: bigint, pacePct: number): BudgetStatus {
  if (spentMinor > availableMinor) return 'over';
  if (spentMinor <= 0n) return 'not_started';
  if (usedPct(spentMinor, availableMinor) > pacePct + AHEAD_MARGIN_PCT) return 'ahead';
  return 'on_track';
}

const STATUS_RANK: Record<BudgetStatus, number> = { over: 0, ahead: 1, on_track: 2, not_started: 3 };

export type BudgetLine = {
  row: BudgetMonthRow;
  spentMinor: bigint;
  availableMinor: bigint;
  /** available − spent (negative = over). */
  remainingMinor: bigint;
  status: BudgetStatus;
  children: BudgetLine[];
};

function toLine(row: BudgetMonthRow, pacePct: number): BudgetLine {
  const spentMinor = BigInt(row.spentMinor || '0');
  const availableMinor = BigInt(row.availableMinor || row.resolvedMinor || '0');
  return {
    row,
    spentMinor,
    availableMinor,
    remainingMinor: availableMinor - spentMinor,
    status: budgetStatus(spentMinor, availableMinor, pacePct),
    children: [],
  };
}

function compareLines(a: BudgetLine, b: BudgetLine): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus;
  // Within a status, the bigger overspend / bigger spend first.
  if (a.remainingMinor !== b.remainingMinor) return a.remainingMinor < b.remainingMinor ? -1 : 1;
  return a.row.categoryName.localeCompare(b.row.categoryName);
}

/**
 * Rows grouped one level (budgeted children under their budgeted parent),
 * each level sorted over → ahead → on track → not started. A child whose
 * parent has no budget row stands on its own.
 */
export function budgetLines(rows: BudgetMonthRow[], pacePct: number): BudgetLine[] {
  const lines = rows.map((r) => toLine(r, pacePct));
  const byId = new Map(lines.map((l) => [l.row.categoryLedgerAccountId, l]));
  const top: BudgetLine[] = [];
  for (const l of lines) {
    const parent = l.row.parentLedgerAccountId ? byId.get(l.row.parentLedgerAccountId) : undefined;
    if (parent) parent.children.push(l);
    else top.push(l);
  }
  for (const l of top) l.children.sort(compareLines);
  // A group's rank follows its most urgent member, so an over child lifts its parent.
  const groupRank = (l: BudgetLine) =>
    Math.min(STATUS_RANK[l.status], ...l.children.map((c) => STATUS_RANK[c.status]));
  return top.sort((a, b) => groupRank(a) - groupRank(b) || compareLines(a, b));
}

export type BudgetTotals = {
  budgetedMinor: bigint;
  spentMinor: bigint;
  overCount: number;
  categoryCount: number;
};

/** Plan-level totals over every budget row (rows never overlap in budget-v5). */
export function budgetTotals(rows: BudgetMonthRow[]): BudgetTotals {
  let budgetedMinor = 0n;
  let spentMinor = 0n;
  let overCount = 0;
  for (const r of rows) {
    const spent = BigInt(r.spentMinor || '0');
    const available = BigInt(r.availableMinor || r.resolvedMinor || '0');
    budgetedMinor += available;
    spentMinor += spent;
    if (spent > available) overCount += 1;
  }
  return { budgetedMinor, spentMinor, overCount, categoryCount: rows.length };
}

/** Over-budget rows, biggest overspend first (Home card list). */
export function overBudgetLines(rows: BudgetMonthRow[]): BudgetLine[] {
  return rows
    .map((r) => toLine(r, 100))
    .filter((l) => l.status === 'over')
    .sort((a, b) => (a.remainingMinor < b.remainingMinor ? -1 : a.remainingMinor > b.remainingMinor ? 1 : 0));
}
