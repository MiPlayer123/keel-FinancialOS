'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BarChart3, ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchCategories,
  type CategoryRow,
  type MonthlyCashFlowRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import {
  CashFlowMonthlyChart,
  CashFlowSankey,
  type SankeyFlowLink,
  type SankeyFlowNode,
} from '@/components/keel/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ReportsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Reports"
        description="Where the money went — by category, by month, exactly."
      />
      <div className="space-y-6 p-6">
        <ReportsBody />
      </div>
    </AppShell>
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

/** Net cash by tag over the trailing months (confirmed transfers excluded). */
function tagTotals(
  rows: RichTransactionRow[],
  months: string[],
): { tagId: string; name: string; count: number; netMinor: bigint }[] {
  const monthSet = new Set(months);
  const byTag = new Map<string, { tagId: string; name: string; count: number; netMinor: bigint }>();
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
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
  return [...byTag.values()].sort((a, b) =>
    a.netMinor < b.netMinor ? -1 : a.netMinor > b.netMinor ? 1 : 0,
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
  const months = useMemo(() => lastMonths(MONTHS_SHOWN), []);
  const tags = useMemo(() => tagTotals(txns.rows, months), [txns.rows, months]);
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
