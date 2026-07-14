'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BarChart3, ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { taxLineLabel, taxLineSchedule } from '@/lib/tax-lines';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchCategories,
  fetchCategoryTaxLines,
  type CategoryRow,
  type MonthlyCashFlowRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import {
  CashFlowMonthlyChart,
  CashFlowSankey,
  CategoryDonut,
  type SankeyFlowLink,
  type SankeyFlowNode,
} from '@/components/keel/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Where the money went — by category, by month, exactly."
      />
      <div className="space-y-6 p-6">
        <ReportsBody />
      </div>
    </>
  );
}

const MONTHS_SHOWN = 6;

function monthKey(dateIso: string): string {
  return dateIso.slice(0, 7);
}

function lastMonths(n: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
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
 * Category × month matrix, confirmed transfers excluded, NET signed per
 * month (refund inflows on an expense category reduce it — the same net
 * convention as budget-spent-v1; income view mirrors it). BigInt everywhere.
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
    if (t.transferStatus === 'confirmed') continue;
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

const RANGE_PRESETS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3', label: 'Last 3 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'last_12', label: 'Last 12 months' },
] as const;
type RangePresetKey = (typeof RANGE_PRESETS)[number]['key'];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive [from, to] calendar-day range for a preset chip, anchored on today. */
function presetRange(key: RangePresetKey): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = isoDate(now);
  switch (key) {
    case 'this_month':
      return { from: isoDate(new Date(Date.UTC(y, m, 1))), to: today };
    case 'last_month':
      return {
        from: isoDate(new Date(Date.UTC(y, m - 1, 1))),
        to: isoDate(new Date(Date.UTC(y, m, 0))),
      };
    case 'last_3':
      return { from: isoDate(new Date(Date.UTC(y, m - 2, 1))), to: today };
    case 'ytd':
      return { from: isoDate(new Date(Date.UTC(y, 0, 1))), to: today };
    case 'last_12':
      return { from: isoDate(new Date(Date.UTC(y, m - 11, 1))), to: today };
  }
}

function rangeLabel(from: string, to: string): string {
  return `${from} – ${to}`;
}

/**
 * Net-signed expense totals per category over an arbitrary inclusive
 * [from, to] calendar-day range — split-aware and confirmed-transfer-
 * excluding, same convention as buildMatrix. Restricted to the dominant
 * currency within the range (like tagTotals/taxSchedule) so the donut and
 * its total format with one currency. Categories whose net is negative
 * (refunds outweigh spend in-range) are returned separately so the pie only
 * ever shows honest positive spend.
 */
function categoryRangeTotals(
  rows: RichTransactionRow[],
  from: string,
  to: string,
): {
  currency: string;
  positive: { categoryId: string | null; name: string; amountMinor: bigint }[];
  negative: { categoryId: string | null; name: string; amountMinor: bigint }[];
} {
  const inRange = (dateIso: string) => {
    const day = dateIso.slice(0, 10);
    return day >= from && day <= to;
  };
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
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
    if (t.transferStatus === 'confirmed') continue;
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

  const all = [...byCategory.values()];
  return {
    currency,
    positive: all.filter((e) => e.amountMinor > 0n),
    negative: all.filter((e) => e.amountMinor < 0n),
  };
}

type FlowGraph = {
  nodes: SankeyFlowNode[];
  links: SankeyFlowLink[];
  totalInMinor: string;
  totalOutMinor: string;
  savedMinor: string;
} | null;

/**
 * This month's money movement as a flow: income categories → Income →
 * spending categories, with "Saved" / "From savings" balancing the sides so
 * every ribbon is positive. Net convention matches the matrix; subcategories
 * roll up into their parents; confirmed transfers excluded. BigInt sums.
 */
function buildFlow(rows: RichTransactionRow[], categories: CategoryRow[]): FlowGraph {
  const month = new Date().toISOString().slice(0, 7);
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
    if (t.transferStatus === 'confirmed') continue;
    if (!t.effectiveDate.startsWith(month)) continue;
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
  };
}

/**
 * Actuals grouped by IRS tax line (Quicken's Tax Schedule report). A category
 * carries an optional taxLine; splits attribute their own share. Net cash per
 * line in the dominant currency, current calendar year to date.
 */
function taxSchedule(
  rows: RichTransactionRow[],
  taxByCategory: Map<string, string>,
): {
  currency: string;
  year: string;
  groups: { schedule: string; lines: { line: string; count: number; netMinor: bigint }[] }[];
} {
  const year = new Date().toISOString().slice(0, 4);
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
    if (!t.effectiveDate.startsWith(year)) continue;
    if (t.splits && t.splits.length > 0) {
      for (const sp of t.splits) {
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
  return { currency, year, groups };
}

/**
 * Net cash by tag over the trailing months (confirmed transfers excluded).
 * Sums are single-currency: restricted to the household's dominant currency,
 * which is returned so the card formats with it.
 */
function tagTotals(
  rows: RichTransactionRow[],
  months: string[],
): {
  currency: string;
  totals: { tagId: string; name: string; count: number; netMinor: bigint }[];
} {
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const currency =
    [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
  const monthSet = new Set(months);
  const byTag = new Map<string, { tagId: string; name: string; count: number; netMinor: bigint }>();
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    if (t.currency !== currency) continue;
    if (!t.tags || t.tags.length === 0) continue;
    if (!monthSet.has(monthKey(t.effectiveDate))) continue;
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
 * Confirmed transfers excluded.
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
    if (t.transferStatus === 'confirmed') continue;
    if (t.currency !== currency) continue;
    if (monthKey(t.effectiveDate) !== month) continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
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
 * one month in the dominant currency. "Purchase" = any non-transfer row whose
 * cash amount is money out, regardless of category (Uncategorized counts).
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
    if (t.transferStatus === 'confirmed') continue;
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
 * dominant currency only, confirmed transfers excluded. Pure BigInt; the only
 * Number() conversion is the display-only savings-rate percent.
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

/** Small "+$120 vs May" delta line; no color — a delta's sign isn't itself a loss/gain signal. */
function DeltaLine({ deltaMinor, vsLabel }: { deltaMinor: bigint; vsLabel: string }) {
  if (deltaMinor === 0n) {
    return <p className="text-xs text-muted-foreground">No change vs {vsLabel}</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      <Money amountMinor={deltaMinor.toString()} signed className="text-xs" muteZero={false} /> vs{' '}
      {vsLabel}
    </p>
  );
}

function ReportsBody() {
  const { householdId, ready } = useHousehold();
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

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
    return () => {
      active = false;
    };
  }, [householdId]);
  const monthlyFlow = useKeelQuerySilent<MonthlyCashFlowRow>(
    'dashboard.cash_flow_monthly',
    householdId,
  );

  const [view, setView] = useState<'expense' | 'income'>('expense');
  const flow = useMemo(() => buildFlow(txns.rows, categories), [txns.rows, categories]);

  // Spending-by-category donut: preset chips fill the from/to inputs;
  // editing either input directly switches the control to "custom" (the
  // active preset chip un-highlights, but the inputs keep whatever the user
  // typed — a fully custom range).
  const [donutPreset, setDonutPreset] = useState<RangePresetKey | null>('this_month');
  const [donutFrom, setDonutFrom] = useState<string>(() => presetRange('this_month').from);
  const [donutTo, setDonutTo] = useState<string>(() => presetRange('this_month').to);
  const applyDonutPreset = (key: RangePresetKey) => {
    const r = presetRange(key);
    setDonutFrom(r.from);
    setDonutTo(r.to);
    setDonutPreset(key);
  };
  const donutRange = useMemo(() => {
    if (donutFrom && donutTo && donutFrom <= donutTo) return { from: donutFrom, to: donutTo };
    return presetRange('this_month');
  }, [donutFrom, donutTo]);
  const donutReport = useMemo(
    () => categoryRangeTotals(txns.rows, donutRange.from, donutRange.to),
    [txns.rows, donutRange],
  );
  const months = useMemo(() => lastMonths(MONTHS_SHOWN), []);
  const tagReport = useMemo(() => tagTotals(txns.rows, months), [txns.rows, months]);
  const tags = tagReport.totals;
  // Default to the last FULL month — the current month (months[last]) is still in progress.
  const [reviewMonth, setReviewMonth] = useState<string>(
    () => months[months.length - 2] ?? months[months.length - 1] ?? '',
  );
  const monthReview = useMemo(
    () => (reviewMonth ? buildMonthReview(txns.rows, reviewMonth, tagReport.currency) : null),
    [txns.rows, reviewMonth, tagReport.currency],
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
  const taxReport = useMemo(() => taxSchedule(txns.rows, taxLines), [txns.rows, taxLines]);
  const matrix = useMemo(
    () => buildMatrix(txns.rows, months, view),
    [txns.rows, months, view],
  );

  const comparison = useMemo(() => {
    const [prev, curr] = [months[months.length - 2], months[months.length - 1]];
    if (!prev || !curr) return [];
    return matrix
      .map((row) => {
        const a = row.byMonth.get(prev)?.total ?? 0n;
        const b = row.byMonth.get(curr)?.total ?? 0n;
        return { name: row.name, categoryId: row.categoryId, prev: a, curr: b, delta: b - a };
      })
      .filter((r) => r.prev !== 0n || r.curr !== 0n)
      .sort((x, y) => {
        const ax = x.delta < 0n ? -x.delta : x.delta;
        const ay = y.delta < 0n ? -y.delta : y.delta;
        return ay > ax ? 1 : ay < ax ? -1 : 0;
      })
      .slice(0, 8);
  }, [matrix, months]);

  if (!ready || txns.loading) {
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

  const showFlow =
    monthlyFlow !== null &&
    monthlyFlow.some((m) => m.inflowMinor !== '0' || m.outflowMinor !== '0');

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
            <span>Month in review</span>
            <span className="flex flex-wrap gap-1">
              {months.map((m) => (
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
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <Money amountMinor={c.deltaMinor.toString()} signed className="text-xs" />{' '}
                          vs {monthLabel(monthReview.prevMonth)}
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
                {monthLabel(reviewMonth)}, dominant currency only, confirmed transfers excluded.
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex flex-wrap gap-1">
              {RANGE_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  variant={donutPreset === p.key ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    applyDonutPreset(p.key);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Input
                type="date"
                value={donutFrom}
                max={donutTo}
                className="h-7 w-[9.5rem] text-xs"
                onChange={(e) => {
                  setDonutFrom(e.target.value);
                  setDonutPreset(null);
                }}
              />
              <span>to</span>
              <Input
                type="date"
                value={donutTo}
                min={donutFrom}
                className="h-7 w-[9.5rem] text-xs"
                onChange={(e) => {
                  setDonutTo(e.target.value);
                  setDonutPreset(null);
                }}
              />
            </span>
          </div>
          {donutReport.positive.length > 0 ? (
            <CategoryDonut
              items={donutReport.positive.map((c) => ({
                name: c.name,
                amountMinor: c.amountMinor.toString(),
              }))}
              currency={donutReport.currency}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No spending in {rangeLabel(donutRange.from, donutRange.to)}.
            </p>
          )}
          {donutReport.negative.length > 0 ? (
            <div className="border-t border-border pt-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Net refunds (excluded from the chart)
              </p>
              <div className="space-y-1">
                {donutReport.negative.map((c) => (
                  <div key={c.categoryId ?? c.name} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.name}</span>
                    <Money
                      amountMinor={c.amountMinor.toString()}
                      currency={donutReport.currency}
                      signed
                      className="text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {rangeLabel(donutRange.from, donutRange.to)}, dominant currency only, confirmed
            transfers excluded, net of refunds.
          </p>
        </CardContent>
      </Card>

      {flow ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Where this month&apos;s money went
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CashFlowSankey nodes={flow.nodes} links={flow.links} />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                Income <Money amountMinor={flow.totalInMinor} className="text-foreground" />
              </span>
              <span className="text-muted-foreground">
                Spent <Money amountMinor={flow.totalOutMinor} className="text-foreground" />
              </span>
              <span className="text-muted-foreground">
                {flow.savedMinor.startsWith('-') ? 'From savings ' : 'Saved '}
                <Money
                  amountMinor={
                    flow.savedMinor.startsWith('-') ? flow.savedMinor.slice(1) : flow.savedMinor
                  }
                  className="text-foreground"
                />
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Income on the left, spending on the right; subcategories roll up into
              their parents. Confirmed transfers excluded.
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
            <CashFlowMonthlyChart rows={monthlyFlow} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
            <span>
              {view === 'expense' ? 'Spending' : 'Income'} by category · last {MONTHS_SHOWN}{' '}
              months
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
            {view === 'expense'
              ? 'Net spending per month (refunds reduce it); confirmed transfers excluded.'
              : 'Net income per month; confirmed transfers excluded.'}{' '}
            Click a category to open it in the ledger.
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
                {matrix.map((row) => (
                  <tr key={row.categoryId ?? 'uncategorized'} className="border-b border-border/60">
                    <td className="max-w-44 truncate py-2 pr-3">
                      <Link
                        href={
                          row.categoryId
                            ? `/dashboard/ledger?category=${row.categoryId}`
                            : '/dashboard/ledger?category=uncategorized'
                        }
                        className="hover:underline"
                      >
                        {row.name}
                      </Link>
                    </td>
                    {months.map((m) => {
                      const v = row.byMonth.get(m)?.total ?? 0n;
                      return (
                        <td key={m} className="px-2 py-2 text-right">
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
                ))}
                <tr>
                  <td className="py-2 pr-3 text-xs font-medium text-muted-foreground">
                    All categories
                  </td>
                  {months.map((m) => {
                    const v = matrix.reduce(
                      (acc, r) => acc + (r.byMonth.get(m)?.total ?? 0n),
                      0n,
                    );
                    return (
                      <td key={m} className="px-2 py-2 text-right">
                        <Money amountMinor={v.toString()} className="text-sm font-medium" />
                      </td>
                    );
                  })}
                  <td className="py-2 pl-2 text-right">
                    <Money
                      amountMinor={matrix.reduce((acc, r) => acc + r.total, 0n).toString()}
                      className="text-sm font-semibold"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>


      {tags.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              By tag · last {MONTHS_SHOWN} months
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
              Net cash for tagged transactions — tag things like tax-deductible or a
              trip, then read the total here.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {taxReport.groups.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tax schedule · {taxReport.year} YTD
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
              Actual cash per IRS line, from the tax lines you set on categories
              (Home → Categories → Manage). Bookkeeping, not tax advice.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {comparison.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              This month vs last month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {comparison.map((r) => (
              <div key={r.categoryId ?? r.name} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
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
              Sorted by biggest change; the current month is still in progress.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
