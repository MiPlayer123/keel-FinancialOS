'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { BarChart3, ArrowDownRight, ArrowUpRight } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import type { MonthlyCashFlowRow, RichTransactionRow } from '@/lib/keel-api';
import { CashFlowMonthlyChart } from '@/components/keel/charts';
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
 * Spending matrix: expense-side transactions, confirmed transfers excluded,
 * NET signed per month (refund inflows on an expense category reduce it —
 * the same net convention as budget-spent-v1). BigInt everywhere.
 */
function buildMatrix(rows: RichTransactionRow[], months: string[]): CategoryReportRow[] {
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
    // Split transactions: attribute each expense share to its own category
    // (debit-positive split amounts ARE net spend).
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== 'expense') continue;
        add(s.categoryLedgerAccountId, s.name, mk, BigInt(s.amountMinor || '0'));
      }
      continue;
    }
    if (t.categoryKind !== 'expense') continue;
    // Cash amount is negative for money out; spending = -amount (net).
    add(t.categoryLedgerAccountId, t.categoryName ?? 'Uncategorized', mk, -BigInt(t.amountMinor || '0'));
  }
  return [...byCategory.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
}

function ReportsBody() {
  const { householdId, ready } = useHousehold();
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const monthlyFlow = useKeelQuerySilent<MonthlyCashFlowRow>(
    'dashboard.cash_flow_monthly',
    householdId,
  );

  const months = useMemo(() => lastMonths(MONTHS_SHOWN), []);
  const matrix = useMemo(() => buildMatrix(txns.rows, months), [txns.rows, months]);

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
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Spending by category · last {MONTHS_SHOWN} months
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Net spending per month (refunds reduce it); confirmed transfers excluded.
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
