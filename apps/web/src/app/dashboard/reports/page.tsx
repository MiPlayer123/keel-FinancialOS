'use client';

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  BarChart3,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Download,
  ListFilter,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { formatMoney } from '@/lib/money';
import { taxLineLabel, taxLineSchedule } from '@/lib/tax-lines';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCategories,
  fetchCategoryTaxLines,
  fetchEntities,
  type AccountRow,
  type CategoryRow,
  type EntityRow,
  type HoldingRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import {
  CashFlowMonthlyChart,
  CashFlowSankey,
  CategoryBarList,
  CategoryDonut,
  type MonthlyFlow,
  type SankeyFlowLink,
  type SankeyFlowNode,
} from '@/components/keel/charts';
import { isDebtOrTransferLike, suggestedTransferCount } from '@/lib/spending';
import {
  excludeTaxSpend,
  rollupCategoryTotals,
  taxCategoryIdSet,
  type CategoryGroupEntry,
  type CategoryRangeEntry,
} from '@/lib/category-rollup';
import { allocationMix } from '@/lib/holdings-allocation';
import {
  clampMonthToRange,
  dominantCurrency,
  ledgerDrillHref,
  parseReportScope,
  presetRange,
  RANGE_PRESETS,
  reportScopeToSearch,
  scopeLabel,
  scopeMonths,
  scopeMonthSpan,
  scopeRows,
  scopedAccountIdSet,
  type ReportScope,
} from '@/lib/report-scope';
import { buildScopedTransactionsCsv, scopedExportFilename } from '@/lib/report-export';
import { TransferNudgeBanner } from '@/components/keel/transfer-nudge-banner';
import { CardBreakEvenCard } from '@/components/keel/card-breakeven-card';
import { cardBreakEven, CREDIT_CARD_SUBTYPE } from '@/lib/card-breakeven';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Where the money went — by category, by month, exactly."
      />
      <div className="space-y-6 p-6">
        {/* Suspense: useSearchParams (scope-in-URL) needs a boundary for the
            static prerender — same pattern as the ledger page. */}
        <Suspense
          fallback={
            <div className="space-y-4">
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-72 w-full" />
            </div>
          }
        >
          <ReportsBody />
        </Suspense>
      </div>
    </>
  );
}

function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7);
}

function monthLabel(key: string): string {
  const [y = '', m = ''] = key.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

type CategoryMonthCell = { total: bigint };
type CategoryReportRow = {
  categoryId: string | null;
  name: string;
  byMonth: Map<string, CategoryMonthCell>;
  total: bigint;
};

/**
 * Category × month matrix, transfers & debt payments excluded, NET signed per
 * month (refund inflows on an expense category reduce it — the same net
 * convention as budget-spent-v1; income view mirrors it). BigInt everywhere.
 * Callers pass rows already reduced to the report scope (accounts + range).
 */
function buildMatrix(
  rows: RichTransactionRow[],
  months: string[],
  kind: 'expense' | 'income',
): CategoryReportRow[] {
  const monthSet = new Set(months);
  const byCategory = new Map<string, CategoryReportRow>();
  const add = (categoryId: string | null, name: string, mk: string, spend: bigint) => {
    const key = categoryId ?? 'uncategorized';
    const entry =
      byCategory.get(key) ??
      ({
        categoryId,
        name,
        byMonth: new Map<string, CategoryMonthCell>(),
        total: 0n,
      } satisfies CategoryReportRow);
    const cell = entry.byMonth.get(mk) ?? { total: 0n };
    cell.total += spend;
    entry.byMonth.set(mk, cell);
    entry.total += spend;
    byCategory.set(key, entry);
  };
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    const mk = monthKey(t.effectiveDate);
    if (!monthSet.has(mk)) continue;
    // Split transactions: attribute each share to its own category.
    // Debit-positive: expense shares are positive spend; income shares are
    // negative (credits), so income received = -share.
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== kind) continue;
        const share = BigInt(s.amountMinor || '0');
        add(s.categoryLedgerAccountId, s.name, mk, kind === 'expense' ? share : -share);
      }
      continue;
    }
    if (t.categoryKind !== kind) continue;
    // Cash convention: negative = money out. Spending = -amount; income = +amount.
    const cash = BigInt(t.amountMinor || '0');
    add(
      t.categoryLedgerAccountId,
      t.categoryName ?? 'Uncategorized',
      mk,
      kind === 'expense' ? -cash : cash,
    );
  }
  return [...byCategory.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
}

type MatrixParentRow = {
  categoryId: string | null;
  name: string;
  byMonth: Map<string, CategoryMonthCell>;
  total: bigint;
  /** Subcategory leaf rows under this parent (empty for standalone rows). */
  children: CategoryReportRow[];
  /** The parent's OWN (non-sub) activity, kept separate so an expanded
   *  parent can show it as its own line and the sub lines still sum to the
   *  parent row. Null when everything under this parent came from subs. */
  direct: CategoryReportRow | null;
};

/** Deterministic report ordering: total desc, then name, then id. */
function compareRows(
  a: { total: bigint; name: string; categoryId: string | null },
  b: { total: bigint; name: string; categoryId: string | null },
): number {
  if (a.total !== b.total) return b.total > a.total ? 1 : -1;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return (a.categoryId ?? '').localeCompare(b.categoryId ?? '');
}

/**
 * F-016b: roll the leaf-grain matrix up to parent categories. A leaf whose
 * category has a live parent contributes to that parent's row and appears as
 * an expandable child; everything else (top-level categories, Uncategorized,
 * archived categories absent from categories.list) stands alone. Client-side
 * and purely derived — the leaf matrix stays the single source of numbers,
 * so parents are exactly the sum of what they contain.
 */
function rollupMatrix(leaves: CategoryReportRow[], categories: CategoryRow[]): MatrixParentRow[] {
  const byId = new Map(categories.map((c) => [c.ledgerAccountId, c]));
  const rows = new Map<string, MatrixParentRow>();
  const ensure = (key: string, categoryId: string | null, name: string): MatrixParentRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created: MatrixParentRow = {
      categoryId,
      name,
      byMonth: new Map<string, CategoryMonthCell>(),
      total: 0n,
      children: [],
      direct: null,
    };
    rows.set(key, created);
    return created;
  };
  const merge = (into: MatrixParentRow, leaf: CategoryReportRow) => {
    for (const [mk, cell] of leaf.byMonth) {
      const t = into.byMonth.get(mk) ?? { total: 0n };
      t.total += cell.total;
      into.byMonth.set(mk, t);
    }
    into.total += leaf.total;
  };
  for (const leaf of leaves) {
    const cat = leaf.categoryId ? byId.get(leaf.categoryId) : undefined;
    const parentCat = cat?.parentLedgerAccountId ? byId.get(cat.parentLedgerAccountId) : undefined;
    if (parentCat) {
      const parent = ensure(parentCat.ledgerAccountId, parentCat.ledgerAccountId, parentCat.name);
      merge(parent, leaf);
      parent.children.push(leaf);
    } else {
      const row = ensure(leaf.categoryId ?? 'uncategorized', leaf.categoryId, leaf.name);
      merge(row, leaf);
      row.direct = leaf;
    }
  }
  const out = [...rows.values()].sort(compareRows);
  for (const row of out) row.children.sort(compareRows);
  return out;
}

/**
 * F-039: top counterparties by money out, derived client-side from the same
 * scoped rows as the rest of the page (payee = the transaction description —
 * KEEL has no separate merchant table yet). Money-out only, dominant currency
 * only, transfers & debt payments excluded; refunds deliberately do NOT
 * offset a payee (this ranks where money goes, not net position).
 */
function payeeTotals(rows: RichTransactionRow[]): {
  currency: string;
  payees: { name: string; count: number; spendMinor: bigint }[];
} {
  const spendRows = rows.filter((t) => !isDebtOrTransferLike(t));
  const currency = dominantCurrency(spendRows);
  const byPayee = new Map<string, { name: string; count: number; spendMinor: bigint }>();
  for (const t of spendRows) {
    if (t.currency !== currency) continue;
    const cash = BigInt(t.amountMinor || '0');
    if (cash >= 0n) continue;
    const key = t.description.trim().toLowerCase();
    const e = byPayee.get(key) ?? { name: t.description.trim(), count: 0, spendMinor: 0n };
    e.count += 1;
    e.spendMinor += -cash;
    byPayee.set(key, e);
  }
  return {
    currency,
    payees: [...byPayee.values()]
      .sort((a, b) =>
        a.spendMinor < b.spendMinor
          ? 1
          : a.spendMinor > b.spendMinor
            ? -1
            : a.name.localeCompare(b.name),
      )
      .slice(0, 15),
  };
}

/**
 * F-039 hover detail for a matrix cell: exact amount + integer share of that
 * month's column total. Share renders only when both sides are positive spend
 * (a net-refund cell's "share" of a month would be nonsense).
 */
function matrixCellTitle(
  name: string,
  mk: string,
  v: bigint,
  columnTotal: bigint,
  currency: string,
): string {
  const base = `${name} · ${monthLabel(mk)}: ${formatMoney(v.toString(), { currency })}`;
  if (v > 0n && columnTotal > 0n) {
    return `${base} · ${String(Number((v * 100n) / columnTotal))}% of ${monthLabel(mk)}`;
  }
  return base;
}

function rangeLabel(from: string, to: string): string {
  return `${from} – ${to}`;
}

/** Same Blob/anchor download pattern as Settings' full-household export. */
function downloadCsvFile(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Net-signed expense totals per LEAF category over an arbitrary inclusive
 * [from, to] calendar-day range — split-aware and transfer/debt-payment-
 * excluding, same convention as buildMatrix. Restricted to the dominant
 * currency within the range (like tagTotals/taxSchedule) so the donut and
 * its total format with one currency. Callers roll leaves up to parents
 * (rollupCategoryTotals) and partition by sign at that grain, so the pie
 * only ever shows honest positive net spend.
 */
function categoryRangeTotals(
  rows: RichTransactionRow[],
  from: string,
  to: string,
): {
  currency: string;
  entries: CategoryRangeEntry[];
} {
  const inRange = (dateIso: string) => {
    const day = dateIso.slice(0, 10);
    return day >= from && day <= to;
  };
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (!inRange(t.effectiveDate)) continue;
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const currency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  const byCategory = new Map<string, { categoryId: string | null; name: string; amountMinor: bigint }>();
  const bump = (categoryId: string | null, name: string, spend: bigint) => {
    const key = categoryId ?? 'uncategorized';
    const e = byCategory.get(key) ?? { categoryId, name, amountMinor: 0n };
    e.amountMinor += spend;
    byCategory.set(key, e);
  };
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== currency) continue;
    if (!inRange(t.effectiveDate)) continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== 'expense') continue;
        bump(s.categoryLedgerAccountId, s.name, BigInt(s.amountMinor || '0'));
      }
      continue;
    }
    if (t.categoryKind !== 'expense') continue;
    bump(
      t.categoryLedgerAccountId,
      t.categoryName ?? 'Uncategorized',
      -BigInt(t.amountMinor || '0'),
    );
  }

  return { currency, entries: [...byCategory.values()].filter((e) => e.amountMinor !== 0n) };
}

type FlowGraph = {
  nodes: SankeyFlowNode[];
  links: SankeyFlowLink[];
  totalInMinor: string;
  totalOutMinor: string;
  savedMinor: string;
  currency: string;
} | null;

/**
 * Money movement as a flow: income categories → Income → spending categories,
 * with "Saved" / "From savings" balancing the sides so every ribbon is
 * positive. Net convention matches the matrix; subcategories roll up into
 * their parents; transfers & debt payments excluded; dominant currency only
 * (voted like monthlyFlow — mixed-currency sums would be meaningless).
 * BigInt sums. Callers pass rows already reduced to the report scope
 * (accounts + date range).
 */
function buildFlow(rows: RichTransactionRow[], categories: CategoryRow[]): FlowGraph {
  const currency = dominantCurrency(rows.filter((t) => !isDebtOrTransferLike(t)));
  const byId = new Map(categories.map((c) => [c.ledgerAccountId, c]));
  const rollup = (id: string | null, fallback: string): { key: string; name: string } => {
    const cat = id ? byId.get(id) : undefined;
    const parent = cat?.parentLedgerAccountId ? byId.get(cat.parentLedgerAccountId) : undefined;
    const top = parent ?? cat;
    return top ? { key: top.ledgerAccountId, name: top.name } : { key: fallback, name: fallback };
  };

  const income = new Map<string, { name: string; total: bigint }>();
  const expense = new Map<string, { name: string; total: bigint }>();
  const add = (
    map: Map<string, { name: string; total: bigint }>,
    key: string,
    name: string,
    v: bigint,
  ) => {
    const e = map.get(key) ?? { name, total: 0n };
    e.total += v;
    map.set(key, e);
  };

  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== currency) continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        const share = BigInt(s.amountMinor || '0');
        const { key, name } = rollup(s.categoryLedgerAccountId, s.name);
        // Debit-positive: expense shares positive = spend; income shares
        // negative = money received.
        if (s.kind === 'expense') add(expense, key, name, share);
        else add(income, key, name, -share);
      }
      continue;
    }
    const cash = BigInt(t.amountMinor || '0');
    const { key, name } = rollup(t.categoryLedgerAccountId, t.categoryName ?? 'Uncategorized');
    if (t.categoryKind === 'expense') add(expense, key, name, -cash);
    else if (t.categoryKind === 'income') add(income, key, name, cash);
  }

  const fold = (map: Map<string, { name: string; total: bigint }>, cap: number, otherName: string) => {
    const positive = [...map.values()].filter((e) => e.total > 0n);
    positive.sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
    const top = positive.slice(0, cap);
    const rest = positive.slice(cap);
    if (rest.length > 0) {
      top.push({ name: otherName, total: rest.reduce((acc, e) => acc + e.total, 0n) });
    }
    return top;
  };

  const inFlows = fold(income, 5, 'Other income');
  const outFlows = fold(expense, 8, 'Everything else');
  const totalIn = inFlows.reduce((a, e) => a + e.total, 0n);
  const totalOut = outFlows.reduce((a, e) => a + e.total, 0n);
  if (totalIn === 0n || totalOut === 0n) return null;

  const saved = totalIn - totalOut;
  const nodes: SankeyFlowNode[] = [];
  const links: SankeyFlowLink[] = [];
  const hubTotal = saved < 0n ? totalOut : totalIn;

  for (const e of inFlows) {
    nodes.push({ name: e.name, side: 'in', column: 'left', totalMinor: e.total.toString() });
  }
  if (saved < 0n) {
    nodes.push({ name: 'From savings', side: 'in', column: 'left', totalMinor: (-saved).toString() });
  }
  const hubIndex = nodes.length;
  nodes.push({ name: 'Income', side: 'hub', column: 'hub', totalMinor: hubTotal.toString() });
  for (let i = 0; i < hubIndex; i++) {
    links.push({ source: i, target: hubIndex, valueMinor: nodes[i]?.totalMinor ?? '0' });
  }
  for (const e of outFlows) {
    links.push({ source: hubIndex, target: nodes.length, valueMinor: e.total.toString() });
    nodes.push({ name: e.name, side: 'out', column: 'right', totalMinor: e.total.toString() });
  }
  if (saved > 0n) {
    links.push({ source: hubIndex, target: nodes.length, valueMinor: saved.toString() });
    nodes.push({ name: 'Saved', side: 'in', column: 'right', totalMinor: saved.toString() });
  }
  return {
    nodes,
    links,
    totalInMinor: totalIn.toString(),
    totalOutMinor: totalOut.toString(),
    savedMinor: saved.toString(),
    currency,
  };
}

/**
 * Actuals grouped by IRS tax line (Quicken's Tax Schedule report). A category
 * carries an optional taxLine; splits attribute their own share. Net cash per
 * line in the dominant currency. Callers pass rows already reduced to the
 * report scope (accounts + date range) — the footnote states that scope.
 */
function taxSchedule(
  rows: RichTransactionRow[],
  taxByCategory: Map<string, string>,
): {
  currency: string;
  groups: { schedule: string; lines: { line: string; count: number; netMinor: bigint }[] }[];
} {
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const currency =
    [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  const byLine = new Map<string, { count: number; netMinor: bigint }>();
  const bump = (line: string, minor: bigint) => {
    const e = byLine.get(line) ?? { count: 0, netMinor: 0n };
    e.count += 1;
    e.netMinor += minor;
    byLine.set(line, e);
  };
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    if (t.currency !== currency) continue;
    if (t.splits && t.splits.length > 0) {
      for (const sp of t.splits) {
        // Account-transfer legs (distributions) have no category and are money
        // moving between the user's own accounts — never a tax line.
        if (sp.categoryLedgerAccountId === null) continue;
        const line = taxByCategory.get(sp.categoryLedgerAccountId);
        // Split amounts offset the cash leg; negate to read as cash effect.
        if (line) bump(line, -BigInt(sp.amountMinor || '0'));
      }
      continue;
    }
    const line = t.categoryLedgerAccountId
      ? taxByCategory.get(t.categoryLedgerAccountId)
      : undefined;
    if (line) bump(line, BigInt(t.amountMinor || '0'));
  }

  const bySchedule = new Map<string, { line: string; count: number; netMinor: bigint }[]>();
  for (const [line, e] of byLine) {
    const sched = taxLineSchedule(line);
    const list = bySchedule.get(sched) ?? [];
    list.push({ line, count: e.count, netMinor: e.netMinor });
    bySchedule.set(sched, list);
  }
  const groups = [...bySchedule.entries()]
    .map(([schedule, lines]) => ({
      schedule,
      lines: lines.sort((a, b) => a.line.localeCompare(b.line)),
    }))
    .sort((a, b) => a.schedule.localeCompare(b.schedule));
  return { currency, groups };
}

/**
 * Net cash by tag. NET-CASH scope, deliberately different from the spending
 * widgets above: only confirmed transfer pairs are excluded (they net to
 * zero); debt payments are real cash against a tag, so they stay counted.
 * Each card's caption states its own formula (Law 9). Sums are
 * single-currency: restricted to the dominant currency, which is returned so
 * the card formats with it. Callers pass rows already reduced to the report
 * scope (accounts + date range).
 */
function tagTotals(rows: RichTransactionRow[]): {
  currency: string;
  totals: { tagId: string; name: string; count: number; netMinor: bigint }[];
} {
  const currency = dominantCurrency(rows);
  const byTag = new Map<string, { tagId: string; name: string; count: number; netMinor: bigint }>();
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    if (t.currency !== currency) continue;
    if (!t.tags || t.tags.length === 0) continue;
    const cash = BigInt(t.amountMinor || '0');
    for (const tag of t.tags) {
      const e = byTag.get(tag.tagId) ?? { tagId: tag.tagId, name: tag.name, count: 0, netMinor: 0n };
      e.count += 1;
      e.netMinor += cash;
      byTag.set(tag.tagId, e);
    }
  }
  return {
    currency,
    totals: [...byTag.values()].sort((a, b) =>
      a.netMinor < b.netMinor ? -1 : a.netMinor > b.netMinor ? 1 : 0,
    ),
  };
}

type MonthReviewCategory = {
  categoryId: string | null;
  name: string;
  amountMinor: bigint;
  deltaMinor: bigint;
};

export type MonthReview = {
  month: string;
  prevMonth: string;
  currency: string;
  incomeMinor: bigint;
  incomeDeltaMinor: bigint;
  spendingMinor: bigint;
  spendingDeltaMinor: bigint;
  netMinor: bigint;
  netDeltaMinor: bigint;
  topCategories: MonthReviewCategory[];
  biggestPurchase: { description: string; amountMinor: bigint } | null;
  merchantCount: number;
  transactionCount: number;
  /** Integer percent (BigInt division, truncated); null when income <= 0. */
  savingsRatePct: number | null;
};

/** The calendar month immediately before `key` (YYYY-MM), UTC, no DST edge cases. */
function prevMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Income total, expense-category totals (net of refunds, split-aware — same
 * convention as buildMatrix), for one month in the dominant currency.
 * Transfers & debt payments excluded.
 */
function monthIncomeAndSpending(
  rows: RichTransactionRow[],
  month: string,
  currency: string,
): {
  incomeMinor: bigint;
  categories: Map<string, { name: string; amountMinor: bigint }>;
} {
  let incomeMinor = 0n;
  const categories = new Map<string, { name: string; amountMinor: bigint }>();
  const bumpCategory = (key: string, name: string, spend: bigint) => {
    const e = categories.get(key) ?? { name, amountMinor: 0n };
    e.amountMinor += spend;
    categories.set(key, e);
  };
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== currency) continue;
    if (monthKey(t.effectiveDate) !== month) continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        // Account-transfer legs (distributions, e.g. a 401k) move money between
        // the user's own accounts — neither spend nor income.
        if (s.legType === 'account' || s.categoryLedgerAccountId === null) continue;
        const share = BigInt(s.amountMinor || '0');
        if (s.kind === 'expense') {
          bumpCategory(s.categoryLedgerAccountId, s.name, share);
        } else {
          incomeMinor += -share;
        }
      }
      continue;
    }
    const cash = BigInt(t.amountMinor || '0');
    if (t.categoryKind === 'expense') {
      bumpCategory(t.categoryLedgerAccountId ?? 'uncategorized', t.categoryName ?? 'Uncategorized', -cash);
    } else if (t.categoryKind === 'income') {
      incomeMinor += cash;
    }
  }
  return { incomeMinor, categories };
}

/**
 * Biggest single purchase, distinct-merchant count, and transaction count for
 * one month in the dominant currency. "Purchase" = any row that isn't a
 * transfer or debt payment whose cash amount is money out, regardless of
 * category (Uncategorized counts).
 */
function monthActivity(
  rows: RichTransactionRow[],
  month: string,
  currency: string,
): {
  biggestPurchase: { description: string; amountMinor: bigint } | null;
  merchantCount: number;
  transactionCount: number;
} {
  let transactionCount = 0;
  let biggestPurchase: { description: string; amountMinor: bigint } | null = null;
  const merchants = new Set<string>();
  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== currency) continue;
    if (monthKey(t.effectiveDate) !== month) continue;
    transactionCount += 1;
    const cash = BigInt(t.amountMinor || '0');
    if (cash < 0n) {
      const spend = -cash;
      merchants.add(t.description.trim().toLowerCase());
      if (!biggestPurchase || spend > biggestPurchase.amountMinor) {
        biggestPurchase = { description: t.description, amountMinor: spend };
      }
    }
  }
  return { biggestPurchase, merchantCount: merchants.size, transactionCount };
}

/**
 * Copilot-style "Month in Review" recap for one month vs the prior month,
 * dominant currency only, transfers & debt payments excluded. Pure BigInt; the
 * only Number() conversion is the display-only savings-rate percent.
 */
function buildMonthReview(
  rows: RichTransactionRow[],
  month: string,
  currency: string,
): MonthReview {
  const prevMonth = prevMonthKey(month);
  const curr = monthIncomeAndSpending(rows, month, currency);
  const prev = monthIncomeAndSpending(rows, prevMonth, currency);
  const activity = monthActivity(rows, month, currency);

  const currSpendingMinor = [...curr.categories.values()].reduce((acc, c) => acc + c.amountMinor, 0n);
  const prevSpendingMinor = [...prev.categories.values()].reduce((acc, c) => acc + c.amountMinor, 0n);
  const netMinor = curr.incomeMinor - currSpendingMinor;
  const prevNetMinor = prev.incomeMinor - prevSpendingMinor;

  const topCategories: MonthReviewCategory[] = [...curr.categories.entries()]
    .map(([key, c]) => ({
      categoryId: key === 'uncategorized' ? null : key,
      name: c.name,
      amountMinor: c.amountMinor,
      deltaMinor: c.amountMinor - (prev.categories.get(key)?.amountMinor ?? 0n),
    }))
    .sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0))
    .slice(0, 5);

  const savingsRatePct = curr.incomeMinor > 0n ? Number((netMinor * 100n) / curr.incomeMinor) : null;

  return {
    month,
    prevMonth,
    currency,
    incomeMinor: curr.incomeMinor,
    incomeDeltaMinor: curr.incomeMinor - prev.incomeMinor,
    spendingMinor: currSpendingMinor,
    spendingDeltaMinor: currSpendingMinor - prevSpendingMinor,
    netMinor,
    netDeltaMinor: netMinor - prevNetMinor,
    topCategories,
    biggestPurchase: activity.biggestPurchase,
    merchantCount: activity.merchantCount,
    transactionCount: activity.transactionCount,
    savingsRatePct,
  };
}

/**
 * Small "↑ $120 vs May" delta line. Law 8 (REPORTSCASHFLOW-4): a delta's minus
 * sign is arithmetic direction, not negative money, so direction wears a neutral
 * up/down glyph + muted tone — never red. Magnitude is rendered unsigned so the
 * Money component can't tint it; red stays reserved for the figures that are
 * themselves negative money (the Net readout above, unchanged).
 */
function DeltaLine({ deltaMinor, vsLabel }: { deltaMinor: bigint; vsLabel: string }) {
  if (deltaMinor === 0n) {
    return <p className="text-xs text-muted-foreground">No change vs {vsLabel}</p>;
  }
  const magnitude = (deltaMinor < 0n ? -deltaMinor : deltaMinor).toString();
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      {deltaMinor > 0n ? (
        <ArrowUpRight className="size-3.5" />
      ) : (
        <ArrowDownRight className="size-3.5" />
      )}
      <Money amountMinor={magnitude} className="text-xs text-muted-foreground" muteZero={false} />
      <span>vs {vsLabel}</span>
    </p>
  );
}

/** Refund-heavy rows a donut can't plot, listed under it (Law 9: disclosed,
 *  never silently dropped). Renders nothing when there are none. */
function NetRefundsStrip({
  entries,
  currency,
}: {
  entries: { key: string; name: string; amountMinor: bigint }[];
  currency: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="border-t border-border pt-3">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Net refunds (excluded from the chart)
      </p>
      <div className="space-y-1">
        {entries.map((e) => (
          <div key={e.key} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.name}</span>
            <Money
              amountMinor={e.amountMinor.toString()}
              currency={currency}
              signed
              className="text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Focused view of one parent slice: its subcategories as their own donut,
 * with "Filter transactions" opening the register on the whole subtree (the
 * exact population behind the parent's number) and a leaf click opening just
 * that subcategory.
 */
function DonutBreakdown({
  group,
  currency,
  scopeText,
  onBack,
  onFilterTransactions,
  onLeafClick,
}: {
  group: CategoryGroupEntry;
  currency: string;
  scopeText: string;
  onBack: () => void;
  onFilterTransactions: () => void;
  onLeafClick: (categoryId: string | null) => void;
}) {
  const positive = group.children.filter((c) => c.amountMinor > 0n);
  const negative = group.children.filter((c) => c.amountMinor < 0n);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          All categories
        </Button>
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{group.name}</span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onFilterTransactions}>
            <ListFilter className="size-3.5" />
            Filter transactions
          </Button>
        </span>
      </div>
      {positive.length > 0 ? (
        <CategoryDonut
          items={positive.map((c) => ({
            id: c.categoryId,
            name: c.name,
            amountMinor: c.amountMinor.toString(),
          }))}
          currency={currency}
          onSliceClick={(slice) => {
            onLeafClick(slice.id);
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Refunds outweigh spending in every {group.name} subcategory for this range.
        </p>
      )}
      <NetRefundsStrip
        entries={negative.map((c) => ({
          key: c.categoryId ?? c.name,
          name: c.name,
          amountMinor: c.amountMinor,
        }))}
        currency={currency}
      />
      <p className="text-xs text-muted-foreground">
        {group.name} subcategories · {scopeText}, dominant currency only, transfers & debt
        payments excluded, net of refunds. Click a slice to open it in the ledger.
      </p>
    </>
  );
}

/**
 * THE scope bar (teardown C14): one date range + account subset + entity
 * drives every widget below it. State lives in the URL (shareable views);
 * flex-wrap keeps it usable at 390px. Entity select renders only for
 * multi-entity households.
 */
function ScopeBar({
  scope,
  accounts,
  entities,
  onScopeChange,
}: {
  scope: ReportScope;
  accounts: AccountRow[];
  entities: EntityRow[];
  onScopeChange: (next: ReportScope) => void;
}) {
  const entityAccounts =
    scope.entityId === null ? accounts : accounts.filter((a) => a.entityId === scope.entityId);
  const selectedIds =
    scope.accountIds.length === 0
      ? entityAccounts.map((a) => a.id)
      : entityAccounts.filter((a) => scope.accountIds.includes(a.id)).map((a) => a.id);
  const allSelected = selectedIds.length === entityAccounts.length && entityAccounts.length > 0;

  const toggleAccount = (id: string) => {
    const has = selectedIds.includes(id);
    // Never allow an empty scope — the last checked account stays checked.
    if (has && selectedIds.length === 1) return;
    const next = has ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    // A full selection canonicalizes to [] ("all"), so new accounts join the
    // scope automatically and the URL stays clean.
    onScopeChange({
      ...scope,
      accountIds: next.length === entityAccounts.length ? [] : next,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
      <span className="flex flex-wrap gap-1">
        {RANGE_PRESETS.map((p) => (
          <Button
            key={p.key}
            variant={scope.preset === p.key ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              onScopeChange({ ...scope, preset: p.key, ...presetRange(p.key) });
            }}
          >
            {p.label}
          </Button>
        ))}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Input
          type="date"
          value={scope.from}
          max={scope.to}
          className="h-8 w-[9.5rem] text-xs"
          onChange={(e) => {
            const v = e.target.value;
            if (v && v <= scope.to) onScopeChange({ ...scope, preset: null, from: v });
          }}
        />
        <span>to</span>
        <Input
          type="date"
          value={scope.to}
          min={scope.from}
          className="h-8 w-[9.5rem] text-xs"
          onChange={(e) => {
            const v = e.target.value;
            if (v && v >= scope.from) onScopeChange({ ...scope, preset: null, to: v });
          }}
        />
      </span>
      {entities.length > 1 ? (
        <Select
          value={scope.entityId ?? 'all'}
          items={{
            all: 'All entities',
            ...Object.fromEntries(entities.map((e) => [e.entityId, e.name])),
          }}
          onValueChange={(v) => {
            if (!v) return;
            // Switching entity resets the account picks — the old picks belong
            // to another entity's account list.
            onScopeChange({ ...scope, entityId: v === 'all' ? null : v, accountIds: [] });
          }}
        >
          <SelectTrigger className="h-8 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All entities</SelectItem>
            {entities.map((e) => (
              <SelectItem key={e.entityId} value={e.entityId}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {entityAccounts.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="h-8">
                {allSelected
                  ? 'All accounts'
                  : `${String(selectedIds.length)} of ${String(entityAccounts.length)} accounts`}
                <ChevronDown className="size-4 text-muted-foreground" />
              </Button>
            }
          />
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuCheckboxItem
              checked={allSelected}
              closeOnClick={false}
              onCheckedChange={() => {
                onScopeChange({ ...scope, accountIds: [] });
              }}
            >
              All accounts
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {entityAccounts.map((a) => (
              <DropdownMenuCheckboxItem
                key={a.id}
                checked={selectedIds.includes(a.id)}
                closeOnClick={false}
                onCheckedChange={() => {
                  toggleAccount(a.id);
                }}
              >
                {a.name}
                {a.archivedAt ? ' (closed)' : ''}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        variant={scope.includeTaxes ? 'ghost' : 'secondary'}
        size="sm"
        className={`h-7 text-xs${scope.includeTaxes ? ' text-muted-foreground' : ''}`}
        aria-pressed={!scope.includeTaxes}
        title="Exclude tax payments (the Taxes category) from the spending widgets. The tax schedule and CSV export always stay complete."
        onClick={() => {
          onScopeChange({ ...scope, includeTaxes: !scope.includeTaxes });
        }}
      >
        {scope.includeTaxes ? 'Taxes: on' : 'Taxes: off'}
      </Button>
    </div>
  );
}

function ReportsBody() {
  const { householdId, ready } = useHousehold();
  const router = useRouter();
  const searchParams = useSearchParams();
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    fetchCategories(householdId)
      .then((c) => {
        if (active) setCategories(c);
      })
      .catch(() => {
        if (active) setCategories([]);
      });
    // includeArchived: reports scope over HISTORY — a closed account's
    // transactions are still in transactions.rich, and dropping them from
    // entity/account scopes would understate totals vs the unscoped default
    // (review r3603410820). The picker labels archived rows.
    fetchAccounts(householdId, { includeArchived: true })
      .then((a) => {
        if (active) setAccounts(a);
      })
      .catch(() => {
        if (active) setAccounts([]);
      });
    fetchEntities(householdId)
      .then((e) => {
        if (active) setEntities(e);
      })
      .catch(() => {
        if (active) setEntities([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  // ---- THE scope (C14): parsed from the URL, honored by every widget. ----
  const scope = useMemo(() => parseReportScope(searchParams), [searchParams]);
  const setScope = useCallback(
    (next: ReportScope) => {
      const qs = reportScopeToSearch(next);
      router.replace(qs ? `/dashboard/reports?${qs}` : '/dashboard/reports', { scroll: false });
    },
    [router],
  );
  const accountSet = useMemo(() => scopedAccountIdSet(scope, accounts), [scope, accounts]);
  /** Account/entity-scoped rows (all dates) — for month-granular widgets. */
  const scopedRows = useMemo(
    () => (accountSet === null ? txns.rows : txns.rows.filter((r) => accountSet.has(r.accountId))),
    [txns.rows, accountSet],
  );
  const taxIds = useMemo(() => taxCategoryIdSet(categories), [categories]);
  /** Scoped rows with tax payments removed when the scope bar says taxes off. */
  const spendScopedRows = useMemo(
    () => (scope.includeTaxes ? scopedRows : excludeTaxSpend(scopedRows, taxIds)),
    [scope.includeTaxes, scopedRows, taxIds],
  );
  /** Rows inside the full scope: accounts AND the [from, to] day range —
   *  UNfiltered by the tax toggle (tax schedule + CSV export stay complete). */
  const rangedRowsFull = useMemo(() => scopeRows(scopedRows, scope, null), [scopedRows, scope]);
  /** What every spending widget consumes: ranged rows honoring the tax toggle. */
  const rangedRows = useMemo(
    () => (scope.includeTaxes ? rangedRowsFull : excludeTaxSpend(rangedRowsFull, taxIds)),
    [scope.includeTaxes, rangedRowsFull, taxIds],
  );
  const entityName = scope.entityId
    ? (entities.find((e) => e.entityId === scope.entityId)?.name ?? null)
    : null;
  const baseScopeText = scopeLabel({
    scope,
    accountSet,
    totalAccounts: accounts.length,
    entityName,
  });
  /** "3 of 5 accounts · 2026-05-01 – 2026-07-17[ · taxes excluded]" — every
   *  spending-widget footnote leads with this (Law 9); the tax-schedule card
   *  and CSV export use baseScopeText because they never drop tax rows. */
  const scopeText = scope.includeTaxes ? baseScopeText : `${baseScopeText} · taxes excluded`;

  const [view, setView] = useState<'expense' | 'income'>('expense');
  const flow = useMemo(() => buildFlow(rangedRows, categories), [rangedRows, categories]);

  const donutReport = useMemo(
    () => categoryRangeTotals(spendScopedRows, scope.from, scope.to),
    [spendScopedRows, scope.from, scope.to],
  );
  // Parent grain (F-016b): the donut agrees with the matrix and the Sankey —
  // a slice is a parent's rolled-up net; its leaves live one click (or one
  // hover) below.
  const donutGroups = useMemo(
    () => rollupCategoryTotals(donutReport.entries, categories),
    [donutReport, categories],
  );
  const donutPositive = useMemo(
    () => donutGroups.filter((g) => g.amountMinor > 0n),
    [donutGroups],
  );
  const donutNegative = useMemo(
    () => donutGroups.filter((g) => g.amountMinor < 0n),
    [donutGroups],
  );
  // Drill-down focus: a parent group key ('uncategorized' for null). Derived
  // against the live groups so a scope change that empties the parent simply
  // falls back to the top-level view — no stale state to clean up.
  const [donutFocusKey, setDonutFocusKey] = useState<string | null>(null);
  const donutFocus = useMemo(
    () =>
      donutFocusKey === null
        ? null
        : (donutPositive.find(
            (g) => (g.categoryId ?? 'uncategorized') === donutFocusKey && g.children.length > 0,
          ) ?? null),
    [donutFocusKey, donutPositive],
  );
  const months = useMemo(() => scopeMonths(scope.from, scope.to), [scope.from, scope.to]);
  const tagReport = useMemo(() => tagTotals(rangedRows), [rangedRows]);
  const tags = tagReport.totals;
  // Household-wide (unscoped by date/account) — allocation describes what
  // you currently hold, not a range of activity like the rest of this page.
  const holdings = useKeelQuerySilent<HoldingRow>('holdings.list', householdId);
  const allocation = useMemo(() => allocationMix(holdings ?? []), [holdings]);
  // Month chips: the months the scope range touches (last 6). Default to the
  // last FULL month — the newest month is usually still in progress.
  const reviewMonths = useMemo(() => months.slice(-6), [months]);
  const [reviewMonth, setReviewMonth] = useState<string>(
    () => reviewMonths[reviewMonths.length - 2] ?? reviewMonths[reviewMonths.length - 1] ?? '',
  );
  useEffect(() => {
    if (reviewMonths.length === 0) return;
    if (!reviewMonths.includes(reviewMonth)) {
      setReviewMonth(
        reviewMonths[reviewMonths.length - 2] ?? reviewMonths[reviewMonths.length - 1] ?? '',
      );
    }
  }, [reviewMonths, reviewMonth]);
  // Month review is month-granular by design: it honors the ACCOUNT/entity
  // scope, offers only in-range months, and states its month in the footnote;
  // the "vs previous month" baseline deliberately reads the full prior month
  // (a range-clamped baseline would fake huge deltas — Law 9 over-honesty).
  const monthReview = useMemo(
    () => (reviewMonth ? buildMonthReview(spendScopedRows, reviewMonth, tagReport.currency) : null),
    [spendScopedRows, reviewMonth, tagReport.currency],
  );
  // Includes archived categories: their history stays on the tax schedule.
  const [taxLines, setTaxLines] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!householdId) return;
    void fetchCategoryTaxLines(householdId)
      .then(setTaxLines)
      .catch(() => {
        setTaxLines(new Map());
      });
  }, [householdId]);
  const taxReport = useMemo(() => taxSchedule(rangedRowsFull, taxLines), [rangedRowsFull, taxLines]);
  // Data-quality nudge, not a report number: counts the whole household's
  // suggested transfers regardless of scope, so a narrow scope can't hide
  // pending review work.
  const suggestedCount = useMemo(() => suggestedTransferCount(txns.rows), [txns.rows]);
  const matrix = useMemo(
    () => buildMatrix(rangedRows, months, view),
    [rangedRows, months, view],
  );
  // F-016b: parent-level rollup is the default view of the matrix; leaves
  // stay reachable behind each parent's chevron.
  const rolledMatrix = useMemo(() => rollupMatrix(matrix, categories), [matrix, categories]);
  const matrixMonthTotals = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const row of rolledMatrix) {
      for (const [mk, cell] of row.byMonth) {
        totals.set(mk, (totals.get(mk) ?? 0n) + cell.total);
      }
    }
    return totals;
  }, [rolledMatrix]);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const toggleCat = useCallback((key: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // F-039: top payees from the very same scoped rows every widget uses.
  const payeeReport = useMemo(() => payeeTotals(rangedRows), [rangedRows]);

  // Income vs spending per scope month, derived client-side from the scoped
  // rows (same net convention as the matrix — transfers & debt payments
  // excluded) so this trend honors the scope bar; the server-side
  // dashboard.cash_flow_monthly aggregate stays household-wide (Home uses it).
  const monthlyFlow = useMemo<MonthlyFlow[]>(() => {
    // Vote on currency using only the rows monthIncomeAndSpending actually
    // counts (review r3603814918) — a scope heavy on transfer/debt rows in
    // one currency must not steer the chart onto a currency with zero
    // reportable activity in it.
    const currency = dominantCurrency(rangedRows.filter((t) => !isDebtOrTransferLike(t)));
    return months.map((m) => {
      const { incomeMinor, categories: cats } = monthIncomeAndSpending(rangedRows, m, currency);
      const spending = [...cats.values()].reduce((acc, c) => acc + c.amountMinor, 0n);
      return {
        month: m,
        currency,
        inflowMinor: incomeMinor.toString(),
        outflowMinor: spending.toString(),
        netMinor: (incomeMinor - spending).toString(),
      };
    });
  }, [rangedRows, months]);

  // Credit-card rewards vs annual-fee break-even, over the SAME ranged rows and
  // the report scope's account set. Credit cards are the liability accounts,
  // marked by the canonical Plaid subtype 'credit card' (deterministic, never
  // memo-derived — Law 5). Pure BigInt in cardBreakEven (Law 1/4); the card's
  // footnote states scopeText (Law 9).
  const creditCardIds = useMemo(
    () => new Set(accounts.filter((a) => a.subtype === CREDIT_CARD_SUBTYPE).map((a) => a.id)),
    [accounts],
  );
  const cardBreakEvenRows = useMemo(
    () => cardBreakEven(rangedRows, creditCardIds),
    [rangedRows, creditCardIds],
  );

  // Parent grain (rolledMatrix), matching the matrix's default view — a
  // seeded subcategory tree at leaf grain would fragment the biggest movers.
  const comparison = useMemo(() => {
    const [prev, curr] = [months[months.length - 2], months[months.length - 1]];
    if (!prev || !curr) return [];
    return rolledMatrix
      .map((row) => {
        const a = row.byMonth.get(prev)?.total ?? 0n;
        const b = row.byMonth.get(curr)?.total ?? 0n;
        return {
          name: row.name,
          categoryId: row.categoryId,
          hasSubs: row.children.length > 0,
          prev: a,
          curr: b,
          delta: b - a,
        };
      })
      .filter((r) => r.prev !== 0n || r.curr !== 0n)
      .sort((x, y) => {
        const ax = x.delta < 0n ? -x.delta : x.delta;
        const ay = y.delta < 0n ? -y.delta : y.delta;
        return ay > ax ? 1 : ay < ax ? -1 : 0;
      })
      .slice(0, 8);
  }, [rolledMatrix, months]);

  // C15: export EXACTLY the current scope bar's resolution — the full
  // scoped transaction set (accounts ∩ entity, [from, to]), not any single
  // widget's narrower convention (no transfer/debt-payment exclusion here;
  // that stays widget-specific, disclosed in each card's own footnote). Must
  // sit above the early returns below (rules-of-hooks: hooks can't be
  // conditional).
  const handleExportCsv = useCallback(() => {
    const generatedAt = new Date();
    const csv = buildScopedTransactionsCsv({
      rows: rangedRowsFull,
      scope: { from: scope.from, to: scope.to },
      scopeText: baseScopeText,
      asOf: txns.asOf,
      generatedAt,
    });
    downloadCsvFile(scopedExportFilename({ from: scope.from, to: scope.to }, generatedAt), csv);
    toast.success(
      `Exported ${String(rangedRowsFull.length)} transaction${rangedRowsFull.length === 1 ? '' : 's'}.`,
    );
  }, [rangedRowsFull, scope.from, scope.to, baseScopeText, txns.asOf]);

  const scopeRestricted = scope.entityId !== null || scope.accountIds.length > 0;
  if (
    !ready ||
    txns.loading ||
    // A restricted scope can't resolve until the account list arrives —
    // rendering unscoped numbers first would be a silent scope violation.
    (scopeRestricted && accounts.length === 0 && txns.rows.length > 0)
  ) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (txns.error || txns.rows.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 className="size-6" />}
        title={txns.error ? "Couldn't load report data" : 'Nothing to report yet'}
        description={txns.error ?? 'Reports appear as soon as transactions sync.'}
      />
    );
  }

  const showFlow = monthlyFlow.some((m) => m.inflowMinor !== '0' || m.outflowMinor !== '0');
  const monthsLabel =
    months.length === 1 ? monthLabel(months[0] ?? '') : `${String(months.length)} months`;
  // A custom range longer than the 12-column cap shows only the most recent
  // 12 months even though scopeText states the full from–to range (review
  // r3603814914) — disclose the narrowing rather than let the widgets imply
  // full coverage (Law 9).
  const monthsTruncated = scopeMonthSpan(scope.from, scope.to) > months.length;
  const monthsTruncatedNote = monthsTruncated
    ? ` Showing the most recent ${String(months.length)} of ${String(scopeMonthSpan(scope.from, scope.to))} months in range.`
    : '';

  return (
    <>
      <TransferNudgeBanner count={suggestedCount} />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <ScopeBar scope={scope} accounts={accounts} entities={entities} onScopeChange={setScope} />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={handleExportCsv}
        >
          <Download className="size-4" />
          Export CSV
        </Button>
      </div>

      {rangedRows.length === 0 ? (
        <EmptyState
          icon={<BarChart3 className="size-6" />}
          title="Nothing in this scope"
          description={`No transactions for ${scopeText}. Widen the date range or accounts above.`}
        />
      ) : (
        <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
            <span>Month in review</span>
            <span className="flex flex-wrap gap-1">
              {reviewMonths.map((m) => (
                <Button
                  key={m}
                  variant={reviewMonth === m ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setReviewMonth(m);
                  }}
                >
                  {monthLabel(m)}
                </Button>
              ))}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {monthReview && monthReview.transactionCount > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Income</p>
                  <Money
                    amountMinor={monthReview.incomeMinor.toString()}
                    currency={monthReview.currency}
                    className="text-lg font-semibold"
                  />
                  <DeltaLine
                    deltaMinor={monthReview.incomeDeltaMinor}
                    vsLabel={monthLabel(monthReview.prevMonth)}
                  />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Spending</p>
                  <Money
                    amountMinor={monthReview.spendingMinor.toString()}
                    currency={monthReview.currency}
                    className="text-lg font-semibold"
                  />
                  <DeltaLine
                    deltaMinor={monthReview.spendingDeltaMinor}
                    vsLabel={monthLabel(monthReview.prevMonth)}
                  />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Net</p>
                  <Money
                    amountMinor={monthReview.netMinor.toString()}
                    currency={monthReview.currency}
                    signed
                    className="text-lg font-semibold"
                  />
                  <DeltaLine
                    deltaMinor={monthReview.netDeltaMinor}
                    vsLabel={monthLabel(monthReview.prevMonth)}
                  />
                </div>
              </div>

              {monthReview.topCategories.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Top spending categories
                  </p>
                  <div className="space-y-2">
                    {monthReview.topCategories.map((c) => (
                      <div key={c.categoryId ?? 'uncategorized'} className="flex items-center gap-3 text-sm">
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          {c.deltaMinor > 0n ? (
                            <ArrowUpRight className="size-3.5" />
                          ) : c.deltaMinor < 0n ? (
                            <ArrowDownRight className="size-3.5" />
                          ) : null}
                          <Money
                            amountMinor={(c.deltaMinor < 0n ? -c.deltaMinor : c.deltaMinor).toString()}
                            className="text-xs text-muted-foreground"
                          />
                          <span>vs {monthLabel(monthReview.prevMonth)}</span>
                        </span>
                        <Money
                          amountMinor={c.amountMinor.toString()}
                          currency={monthReview.currency}
                          className="w-24 shrink-0 text-right text-sm font-medium"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Biggest single purchase</p>
                  {monthReview.biggestPurchase ? (
                    <p className="text-sm">
                      <span className="truncate">{monthReview.biggestPurchase.description}</span>{' '}
                      <Money
                        amountMinor={monthReview.biggestPurchase.amountMinor.toString()}
                        currency={monthReview.currency}
                        className="font-medium"
                      />
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No purchases this month.</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Activity</p>
                  <p className="text-sm">
                    You spent at {monthReview.merchantCount} place
                    {monthReview.merchantCount === 1 ? '' : 's'} across{' '}
                    {monthReview.transactionCount} transaction
                    {monthReview.transactionCount === 1 ? '' : 's'}.
                    {monthReview.savingsRatePct !== null
                      ? ` Savings rate: ${String(monthReview.savingsRatePct)}%.`
                      : ''}
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {entityName ? `${entityName} · ` : ''}
                {accountSet === null
                  ? 'All accounts'
                  : `${String(accountSet.size)} of ${String(accounts.length)} accounts`}{' '}
                · full month {monthLabel(reviewMonth)}, dominant currency only, transfers &
                debt payments excluded.
                {scope.includeTaxes ? '' : ' Taxes excluded.'}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No activity in {monthLabel(reviewMonth)}.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Spending by category
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {donutFocus ? (
            <DonutBreakdown
              group={donutFocus}
              currency={donutReport.currency}
              scopeText={scopeText}
              onBack={() => {
                setDonutFocusKey(null);
              }}
              onFilterTransactions={() => {
                router.push(
                  ledgerDrillHref({
                    categoryId: donutFocus.categoryId,
                    includeSubcategories: true,
                    from: scope.from,
                    to: scope.to,
                    accountSet,
                  }),
                );
              }}
              onLeafClick={(categoryId) => {
                router.push(
                  ledgerDrillHref({
                    categoryId,
                    from: scope.from,
                    to: scope.to,
                    accountSet,
                  }),
                );
              }}
            />
          ) : (
            <>
              {donutPositive.length > 0 ? (
                <CategoryDonut
                  items={donutPositive.map((g) => ({
                    id: g.categoryId,
                    name: g.name,
                    amountMinor: g.amountMinor.toString(),
                    breakdown: g.children.map((c) => ({
                      name: c.name,
                      amountMinor: c.amountMinor.toString(),
                    })),
                  }))}
                  currency={donutReport.currency}
                  onSliceClick={(slice) => {
                    const key = slice.id ?? 'uncategorized';
                    const group = donutPositive.find(
                      (g) => (g.categoryId ?? 'uncategorized') === key,
                    );
                    if (group && group.children.length > 0) {
                      setDonutFocusKey(key);
                      return;
                    }
                    router.push(
                      ledgerDrillHref({
                        categoryId: slice.id,
                        from: scope.from,
                        to: scope.to,
                        accountSet,
                      }),
                    );
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No spending in {rangeLabel(scope.from, scope.to)}.
                </p>
              )}
              <NetRefundsStrip
                entries={donutNegative.map((g) => ({
                  key: g.categoryId ?? g.name,
                  name: g.name,
                  amountMinor: g.amountMinor,
                }))}
                currency={donutReport.currency}
              />
              <p className="text-xs text-muted-foreground">
                {scopeText}, dominant currency only, transfers & debt payments excluded, net
                of refunds. Subcategories roll up into their parents — click a slice to break
                it down (a category without subcategories opens straight in the ledger).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {flow ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Where the money went
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CashFlowSankey nodes={flow.nodes} links={flow.links} />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                Income{' '}
                <Money
                  amountMinor={flow.totalInMinor}
                  currency={flow.currency}
                  className="text-foreground"
                />
              </span>
              <span className="text-muted-foreground">
                Spent{' '}
                <Money
                  amountMinor={flow.totalOutMinor}
                  currency={flow.currency}
                  className="text-foreground"
                />
              </span>
              <span className="text-muted-foreground">
                {flow.savedMinor.startsWith('-') ? 'From savings ' : 'Saved '}
                <Money
                  amountMinor={
                    flow.savedMinor.startsWith('-') ? flow.savedMinor.slice(1) : flow.savedMinor
                  }
                  currency={flow.currency}
                  className="text-foreground"
                />
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {scopeText}. Income on the left, spending on the right; subcategories roll up
              into their parents. Dominant currency only, transfers & debt payments excluded.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {showFlow ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Income vs spending by month
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CashFlowMonthlyChart
              rows={monthlyFlow}
              onMonthClick={(m) => {
                const clamped = clampMonthToRange(m, scope.from, scope.to);
                router.push(
                  ledgerDrillHref({ from: clamped.from, to: clamped.to, accountSet }),
                );
              }}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {scopeText}, dominant currency only, transfers & debt payments excluded. Click a
              month to open it in the ledger.
              {monthsTruncatedNote}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <CardBreakEvenCard cards={cardBreakEvenRows} scopeText={scopeText} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
            <span>
              {view === 'expense' ? 'Spending' : 'Income'} by category · {monthsLabel}
            </span>
            <span className="flex gap-1">
              {(['expense', 'income'] as const).map((k) => (
                <Button
                  key={k}
                  variant={view === k ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setView(k);
                  }}
                >
                  {k === 'expense' ? 'Spending' : 'Income'}
                </Button>
              ))}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            {scopeText}.{' '}
            {view === 'expense'
              ? 'Net spending per month (refunds reduce it); transfers & debt payments excluded.'
              : 'Net income per month; transfers & debt payments excluded.'}{' '}
            Click a category to open it in the ledger; expand a parent to see its
            subcategories.
            {monthsTruncatedNote}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Category</th>
                  {months.map((m) => (
                    <th key={m} className="px-2 py-2 text-right font-medium">
                      {monthLabel(m)}
                    </th>
                  ))}
                  <th className="py-2 pl-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rolledMatrix.map((row) => {
                  const rowKey = row.categoryId ?? 'uncategorized';
                  const expandable = row.children.length > 0;
                  const expanded = expandable && expandedCats.has(rowKey);
                  // The parent's own (non-sub) activity renders as its own
                  // sub-line so the visible children always sum to the parent.
                  const childRows: { key: string; label: string; drillId: string | null; row: CategoryReportRow }[] =
                    expanded
                      ? [
                          ...(row.direct
                            ? [
                                {
                                  key: `${rowKey}:direct`,
                                  label: `${row.name} (general)`,
                                  drillId: row.direct.categoryId,
                                  row: row.direct,
                                },
                              ]
                            : []),
                          ...row.children.map((c) => ({
                            key: c.categoryId ?? `${rowKey}:uncat`,
                            label: c.name,
                            drillId: c.categoryId,
                            row: c,
                          })),
                        ]
                      : [];
                  return (
                    <Fragment key={rowKey}>
                      <tr className="border-b border-border/60">
                        <td className="max-w-52 py-2 pr-3">
                          <span className="flex items-center gap-1">
                            {expandable ? (
                              <button
                                type="button"
                                aria-expanded={expanded}
                                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.name} subcategories`}
                                className="-ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                onClick={() => {
                                  toggleCat(rowKey);
                                }}
                              >
                                {expanded ? (
                                  <ChevronDown className="size-3.5" />
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )}
                              </button>
                            ) : (
                              <span className="w-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <Link
                              href={ledgerDrillHref({
                                categoryId: row.categoryId,
                                includeSubcategories: expandable,
                                from: scope.from,
                                to: scope.to,
                                accountSet,
                              })}
                              className="min-w-0 truncate hover:underline"
                            >
                              {row.name}
                            </Link>
                          </span>
                        </td>
                        {months.map((m) => {
                          const v = row.byMonth.get(m)?.total ?? 0n;
                          return (
                            <td
                              key={m}
                              className="px-2 py-2 text-right"
                              title={matrixCellTitle(
                                row.name,
                                m,
                                v,
                                matrixMonthTotals.get(m) ?? 0n,
                                donutReport.currency,
                              )}
                            >
                              {v === 0n ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <Money amountMinor={v.toString()} className="text-sm" />
                              )}
                            </td>
                          );
                        })}
                        <td className="py-2 pl-2 text-right">
                          <Money amountMinor={row.total.toString()} className="text-sm font-medium" />
                        </td>
                      </tr>
                      {childRows.map((child) => (
                        <tr key={child.key} className="border-b border-border/40 bg-secondary/30">
                          <td className="max-w-52 py-1.5 pl-8 pr-3">
                            <Link
                              href={ledgerDrillHref({
                                categoryId: child.drillId,
                                from: scope.from,
                                to: scope.to,
                                accountSet,
                              })}
                              className="block truncate text-xs text-muted-foreground hover:underline"
                            >
                              {child.label}
                            </Link>
                          </td>
                          {months.map((m) => {
                            const v = child.row.byMonth.get(m)?.total ?? 0n;
                            return (
                              <td
                                key={m}
                                className="px-2 py-1.5 text-right"
                                title={matrixCellTitle(
                                  child.label,
                                  m,
                                  v,
                                  matrixMonthTotals.get(m) ?? 0n,
                                  donutReport.currency,
                                )}
                              >
                                {v === 0n ? (
                                  <span className="text-xs text-muted-foreground">—</span>
                                ) : (
                                  <Money amountMinor={v.toString()} className="text-xs" />
                                )}
                              </td>
                            );
                          })}
                          <td className="py-1.5 pl-2 text-right">
                            <Money amountMinor={child.row.total.toString()} className="text-xs" />
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                <tr>
                  <td className="py-2 pr-3 text-xs font-medium text-muted-foreground">
                    All categories
                  </td>
                  {months.map((m) => {
                    const v = matrixMonthTotals.get(m) ?? 0n;
                    return (
                      <td key={m} className="px-2 py-2 text-right">
                        <Money amountMinor={v.toString()} className="text-sm font-medium" />
                      </td>
                    );
                  })}
                  <td className="py-2 pl-2 text-right">
                    <Money
                      amountMinor={rolledMatrix.reduce((acc, r) => acc + r.total, 0n).toString()}
                      className="text-sm font-semibold"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>


      {payeeReport.payees.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Top payees
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {payeeReport.payees.map((p) => (
              <div key={p.name.toLowerCase()} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {String(p.count)} txn{p.count === 1 ? '' : 's'}
                </span>
                <Money
                  amountMinor={p.spendMinor.toString()}
                  currency={payeeReport.currency}
                  className="w-28 shrink-0 text-right text-sm"
                />
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {scopeText}. Top {String(payeeReport.payees.length)} payees by money out
              (payee = transaction description), dominant currency only, transfers &
              debt payments excluded. Refunds don&apos;t offset a payee — this ranks
              where money goes.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {allocation.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Investment allocation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <CategoryBarList items={allocation} />
            <p className="pt-1 text-xs text-muted-foreground">
              What you currently hold, by asset class (USD holdings only) — not a date-range view
              like the rest of this page. Descriptive only; doesn&apos;t affect net worth (that
              already comes from each account&apos;s balance).
            </p>
          </CardContent>
        </Card>
      ) : null}
      {tags.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              By tag
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {tags.map((t) => (
              <div key={t.tagId} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">#{t.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {String(t.count)} txn{t.count === 1 ? '' : 's'}
                </span>
                <Money
                  amountMinor={t.netMinor.toString()}
                  currency={tagReport.currency}
                  signed
                  className="w-28 shrink-0 text-right text-sm"
                />
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {scopeText}. Net cash for tagged transactions — tag things like tax-deductible
              or a trip, then read the total here. Confirmed transfers excluded; debt
              payments count (net cash, not spending).
            </p>
          </CardContent>
        </Card>
      ) : null}
      {taxReport.groups.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tax schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {taxReport.groups.map((g) => (
              <div key={g.schedule} className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.schedule}
                </p>
                {g.lines.map((l) => (
                  <div key={l.line} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">{taxLineLabel(l.line)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {String(l.count)} txn{l.count === 1 ? '' : 's'}
                    </span>
                    <Money
                      amountMinor={l.netMinor.toString()}
                      currency={taxReport.currency}
                      signed
                      className="w-28 shrink-0 text-right text-sm"
                    />
                  </div>
                ))}
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {scopeText}. Actual cash per IRS line, from the tax lines you set on categories
              (Home → Categories → Manage). Confirmed transfers excluded. Bookkeeping, not
              tax advice.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {comparison.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {monthLabel(months[months.length - 1] ?? '')} vs{' '}
              {monthLabel(months[months.length - 2] ?? '')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {comparison.map((r) => (
              <div key={r.categoryId ?? r.name} className="flex items-center gap-3 text-sm">
                <Link
                  href={ledgerDrillHref({
                    categoryId: r.categoryId,
                    includeSubcategories: r.hasSubs,
                    from: scope.from,
                    to: scope.to,
                    accountSet,
                  })}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {r.name}
                </Link>
                <span className="text-muted-foreground">
                  <Money amountMinor={r.prev.toString()} className="text-xs" /> →{' '}
                  <Money amountMinor={r.curr.toString()} className="text-sm" />
                </span>
                <span className="flex w-24 items-center justify-end gap-1 text-xs text-muted-foreground">
                  {r.delta > 0n ? (
                    <ArrowUpRight className="size-3.5" />
                  ) : r.delta < 0n ? (
                    <ArrowDownRight className="size-3.5" />
                  ) : null}
                  <Money
                    amountMinor={(r.delta < 0n ? -r.delta : r.delta).toString()}
                    className="text-xs"
                  />
                </span>
              </div>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              {scopeText}. Sorted by biggest change; the newest month may still be in
              progress.
            </p>
          </CardContent>
        </Card>
      ) : null}
        </>
      )}
    </>
  );
}
