'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TrendingUp, Plus, AlertTriangle, Lock } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { HoldingFormDialog } from '@/components/keel/holding-form-dialog';
import { BalanceTrendChart, CategoryBarList, type CategorySpend } from '@/components/keel/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchInvestmentsOverview,
  fetchInvestmentsValueDaily,
  type InvestmentsOverview,
  type InvestmentValuePoint,
  type InvestmentHoldingRow,
} from '@/lib/keel-api';

export default function InvestmentsPage() {
  const { householdId } = useHousehold();
  const [overview, setOverview] = useState<InvestmentsOverview | null>(null);
  const [valuePoints, setValuePoints] = useState<InvestmentValuePoint[] | null>(null);
  // Distinct load/error/data state so a failed load can NEVER masquerade as
  // "still loading" (skeletons forever) or as "empty". null overview means
  // not-yet-loaded; `loadError` set means the last attempt failed.
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [valueHistoryFailed, setValueHistoryFailed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAccount, setDialogAccount] = useState<{ accountId: string; currency: string } | null>(
    null,
  );

  const load = useCallback(() => {
    if (!householdId) return;
    setLoadState('loading');
    setValueHistoryFailed(false);
    fetchInvestmentsOverview(householdId)
      .then((data) => {
        setOverview(data);
        setLoadState('loaded');
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : 'Could not load investments.');
        setLoadState('error');
      });
    fetchInvestmentsValueDaily(householdId)
      .then((points) => {
        setValuePoints(points);
        setValueHistoryFailed(false);
      })
      .catch(() => {
        setValuePoints([]);
        setValueHistoryFailed(true);
      });
  }, [householdId]);

  useEffect(() => {
    load();
  }, [load]);

  // Group holdings by account for the household-wide table.
  const holdingsByAccount = useMemo(() => {
    const groups = new Map<string, { accountName: string; rows: InvestmentHoldingRow[] }>();
    for (const row of overview?.holdings ?? []) {
      const existing = groups.get(row.accountId);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(row.accountId, { accountName: row.accountName, rows: [row] });
      }
    }
    return [...groups.entries()].map(([accountId, g]) => ({ accountId, ...g }));
  }, [overview]);

  const allocationItems: CategorySpend[] = useMemo(
    () =>
      (overview?.allocation ?? []).map((a) => ({
        name: a.name ? `${a.symbol} · ${a.name}` : a.symbol,
        totalMinor: a.valueMinor,
        currency: overview?.currency ?? 'USD',
      })),
    [overview],
  );

  const trendPoints = useMemo(
    () =>
      (valuePoints ?? []).map((p) => ({
        date: p.date,
        balanceMinor: p.valueMinor,
        currency: overview?.currency ?? 'USD',
      })),
    [valuePoints, overview],
  );

  // USD headline currency; non-USD amounts are surfaced explicitly (never
  // folded into the USD figure — the server does no FX conversion).
  const currency = overview?.currency ?? 'USD';
  const loading = loadState === 'loading';
  const errored = loadState === 'error';
  const hasAnything =
    (overview?.accounts.length ?? 0) > 0 || (overview?.holdings.length ?? 0) > 0;
  // Non-USD balance groups to render alongside the USD headline (Finding 7).
  const nonUsdBalances = (overview?.balancesByCurrency ?? []).filter((b) => b.currency !== 'USD');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investments"
        description="Brokerage and retirement accounts, holdings, and allocation across your household."
      />

      {/* Holdings sync errors (F-014): tells the user to re-link. Rendered
          OUTSIDE the empty/non-empty switch so it is never hidden when the
          household has no accounts yet but a connection is erroring. */}
      {(overview?.holdingsErrors ?? []).map((e) => (
        <Card key={e.connectionId} className="border-keel-negative/40 bg-keel-negative/5">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-keel-negative" />
            <div className="text-sm">
              <p className="font-medium">
                Holdings unavailable{e.displayName ? ` — ${e.displayName}` : ''}
              </p>
              <p className="text-muted-foreground">
                Reconnect this institution in update mode to grant investment access. Balances
                still sync; only holdings and investment activity are affected.
              </p>
            </div>
          </CardContent>
        </Card>
      ))}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : errored ? (
        <Card className="border-keel-negative/40 bg-keel-negative/5">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <AlertTriangle className="size-6 text-keel-negative" />
            <div className="text-sm">
              <p className="font-medium">Couldn&apos;t load investments</p>
              <p className="text-muted-foreground">
                Something went wrong fetching this page. Your data is safe.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !overview || !hasAnything ? (
        <EmptyState
          icon={<TrendingUp className="size-6" />}
          title="No investment accounts yet"
          description="Connect a brokerage or retirement account, or add a manual account, to see holdings and allocation here."
        />
      ) : (
        <>
          {/* Totals */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total investment balance
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Money
                  amountMinor={overview.totalBalanceMinor}
                  currency={currency}
                  className="text-2xl font-semibold"
                />
                {nonUsdBalances.length > 0 ? (
                  <div className="mt-2 space-y-0.5">
                    {nonUsdBalances.map((b) => (
                      <div
                        key={b.currency}
                        className="flex items-center justify-between text-xs text-muted-foreground"
                      >
                        <span>{b.currency}</span>
                        <Money amountMinor={b.totalMinor} currency={b.currency} className="text-xs" />
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Holdings value tracked
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Money
                  amountMinor={overview.totalHoldingsValueMinor}
                  currency={currency}
                  className="text-2xl font-semibold"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  A breakdown of what&apos;s inside your balances, not a separate total.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Value over time */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Value over time
              </CardTitle>
            </CardHeader>
            <CardContent>
              {trendPoints.length >= 2 ? (
                <BalanceTrendChart points={trendPoints} />
              ) : valueHistoryFailed ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Couldn&apos;t load value history.{' '}
                  <button
                    type="button"
                    onClick={load}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    Retry
                  </button>
                </p>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Value history builds up as syncs run. Check back after a day or two of tracking.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Allocation */}
          {allocationItems.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Allocation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CategoryBarList items={allocationItems} />
              </CardContent>
            </Card>
          ) : null}

          {/* Accounts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Investment accounts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {overview.accounts.map((a) => (
                <div
                  key={a.accountId}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                      {a.isManual ? (
                        <Badge variant="secondary" className="font-normal">
                          Manual
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs capitalize text-muted-foreground">{a.subtype}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Money
                      amountMinor={a.currentMinor}
                      currency={a.currency}
                      className="text-sm font-medium"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => {
                        setDialogAccount({ accountId: a.accountId, currency: a.currency });
                        setDialogOpen(true);
                      }}
                    >
                      <Plus className="size-3.5" />
                      Holding
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Household holdings, grouped by account */}
          {holdingsByAccount.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">Holdings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {holdingsByAccount.map((group) => {
                  // Sum per currency so a mixed-currency account never sums
                  // apples to oranges under one (wrong) currency label.
                  const totalsByCurrency = new Map<string, bigint>();
                  for (const r of group.rows) {
                    totalsByCurrency.set(
                      r.currency,
                      (totalsByCurrency.get(r.currency) ?? 0n) + BigInt(r.valueMinor || '0'),
                    );
                  }
                  const groupTotals = [...totalsByCurrency.entries()];
                  return (
                    <div key={group.accountId} className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">{group.accountName}</p>
                      {group.rows.map((row) => (
                        <div
                          key={row.holdingId}
                          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-sm font-medium">{row.symbol}</p>
                              {row.source === 'plaid' ? (
                                <Badge variant="secondary" className="gap-1 font-normal">
                                  <Lock className="size-3" />
                                  Synced
                                </Badge>
                              ) : null}
                            </div>
                            {row.name ? (
                              <p className="truncate text-xs text-muted-foreground">{row.name}</p>
                            ) : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <Money
                              amountMinor={row.valueMinor}
                              currency={row.currency}
                              className="text-sm"
                            />
                            <p className="text-xs text-muted-foreground">
                              {row.qty} sh ·{' '}
                              <Money
                                amountMinor={row.priceMinor}
                                currency={row.currency}
                                className="text-xs"
                              />
                            </p>
                          </div>
                        </div>
                      ))}
                      <div className="space-y-1 border-t pt-2 text-sm">
                        {groupTotals.map(([cur, total], idx) => (
                          <div key={cur} className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                              {idx === 0 ? 'Total' : ''}
                            </span>
                            <Money
                              amountMinor={total.toString()}
                              currency={cur}
                              className="font-medium"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      {dialogAccount ? (
        <HoldingFormDialog
          open={dialogOpen}
          householdId={householdId}
          accountId={dialogAccount.accountId}
          currency={dialogAccount.currency}
          editing={null}
          onClose={() => {
            setDialogOpen(false);
          }}
          onSaved={() => {
            setDialogOpen(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
