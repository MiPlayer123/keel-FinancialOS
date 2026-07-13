'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCashFlowForecast,
  fetchConnections,
  syncConnection,
  type AccountRow,
  type DailyBalanceRow,
  type ForecastBill,
  type MonthlyCashFlowRow,
  type RichTransactionRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { CashFlowCard } from '@/components/keel/cash-flow-card';
import {
  BalanceTrendChart,
  CashFlowMonthlyChart,
  CategoryBarList,
} from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { formatMoney } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function HomePage() {
  return (
    <AppShell>
      <PageHeader title="Home" description="Your financial position at a glance." />
      <div className="space-y-8 p-6">
        <HomeBody />
      </div>
    </AppShell>
  );
}

/**
 * "Do I have to sync manually?" — no: KEEL syncs itself every few minutes
 * (a 3-minute drain cron plus a 15-minute scheduler). This shows when data
 * last landed and offers an immediate refresh for the impatient moment.
 */
function SyncStatus({ householdId }: { householdId: string }) {
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchConnections(householdId)
      .then((conns) => {
        if (!active) return;
        const synced = conns
          .filter((c) => c.lastSuccessfulSyncAt !== null)
          .sort((a, b) => (b.lastSuccessfulSyncAt ?? '').localeCompare(a.lastSuccessfulSyncAt ?? ''));
        setLastSync(synced[0]?.lastSuccessfulSyncAt ?? null);
        setConnectionId(conns[0]?.id ?? null);
      })
      .catch(() => {
        if (active) setLastSync(null);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  if (!connectionId) return null;

  const ago = lastSync ? agoLabel(lastSync) : null;

  async function syncNow() {
    if (!connectionId) return;
    setBusy(true);
    try {
      await syncConnection({ householdId, connectionId });
      toast.success('Sync started — new transactions land within a minute or two.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed to start.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {ago ? `Updated ${ago}` : 'Syncs automatically'}
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs"
        disabled={busy}
        onClick={() => {
          void syncNow();
        }}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        Sync
      </Button>
    </span>
  );
}

function agoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.trunc(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.trunc(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.trunc(hours / 24))}d ago`;
}


type Insight = { label: string; value: string; detail: string };

/**
 * Deterministic pocket insights from data already on the page (Law 1 — no
 * model anywhere near this). BigInt sums; labels format minor strings.
 */
function buildInsights(rows: RichTransactionRow[]): Insight[] {
  const out: Insight[] = [];
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const month = todayIso.slice(0, 7);
  const dayOfMonth = Number(todayIso.slice(8, 10));
  const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevMonth = prev.toISOString().slice(0, 7);
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoIso = weekAgo.toISOString().slice(0, 10);

  let biggest: RichTransactionRow | null = null;
  let mtd = 0n;
  let prevToSameDay = 0n;
  const merchants = new Map<string, bigint>();

  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    const cash = BigInt(t.amountMinor || '0');
    if (cash >= 0n) continue; // outflows only
    if (t.effectiveDate >= weekAgoIso) {
      if (!biggest || cash < BigInt(biggest.amountMinor)) biggest = t;
    }
    if (t.effectiveDate.startsWith(month)) {
      mtd += -cash;
      merchants.set(t.description, (merchants.get(t.description) ?? 0n) + -cash);
    }
    if (
      t.effectiveDate.startsWith(prevMonth) &&
      Number(t.effectiveDate.slice(8, 10)) <= dayOfMonth
    ) {
      prevToSameDay += -cash;
    }
  }

  if (biggest) {
    out.push({
      label: 'Biggest purchase · 7 days',
      value: formatMoney(biggest.amountMinor.replace('-', '')),
      detail: biggest.description.slice(0, 40),
    });
  }
  if (mtd > 0n && prevToSameDay > 0n) {
    const deltaPct = Number(((mtd - prevToSameDay) * 100n) / prevToSameDay);
    out.push({
      label: 'Spending pace vs last month',
      value: `${deltaPct >= 0 ? '+' : ''}${String(deltaPct)}%`,
      detail: `${formatMoney(mtd.toString())} so far vs ${formatMoney(prevToSameDay.toString())} by day ${String(dayOfMonth)}`,
    });
  }
  const topMerchant = [...merchants.entries()].sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  )[0];
  if (topMerchant && topMerchant[1] > 0n) {
    out.push({
      label: 'Top merchant this month',
      value: formatMoney(topMerchant[1].toString()),
      detail: topMerchant[0].slice(0, 40),
    });
  }
  return out;
}

function HomeBody() {
  const { householdId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const netWorthTrend = useKeelQuerySilent<DailyBalanceRow>(
    'dashboard.net_worth_daily',
    householdId,
  );
  const monthlyFlow = useKeelQuerySilent<MonthlyCashFlowRow>(
    'dashboard.cash_flow_monthly',
    householdId,
  );
  const richTxns = useKeelQuerySilent<RichTransactionRow>('transactions.rich', householdId);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [forecast, setForecast] = useState<{
    rows: DailyBalanceRow[];
    bills: ForecastBill[];
  } | null>(null);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchCashFlowForecast(householdId, 30).then((f) => {
      if (active) setForecast(f);
    });
    return () => {
      active = false;
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchAccounts(householdId)
      .then((a) => {
        if (active) setAccounts(a);
      })
      .catch(() => {
        if (active) setAccounts([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  const waitingForAccounts = householdId !== null && accounts === null;
  const loading = !ready || balances.loading || waitingForAccounts;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full max-w-sm" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!householdId) {
    return (
      <EmptyState
        icon={<Wallet className="size-6" />}
        title="No household yet"
        description="Once your account is set up with a household, balances and accounts appear here."
      />
    );
  }

  const accountList = accounts ?? [];

  const balanceByLedger = new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor]));
  const netMinor = accountList.reduce((acc, a) => {
    const b = balanceByLedger.get(a.ledgerAccountId) ?? '0';
    return acc + BigInt(b);
  }, 0n);

  const spending = spendingMix(richTxns ?? []);
  const insights = buildInsights(richTxns ?? []);
  const showMonthlyFlow =
    monthlyFlow !== null &&
    monthlyFlow.some((m) => m.inflowMinor !== '0' || m.outflowMinor !== '0');

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net position
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Money
              amountMinor={netMinor.toString()}
              className="text-3xl font-semibold"
              muteZero={false}
            />
          </CardContent>
        </Card>
        <CashFlowCard householdId={householdId} />
      </div>

      {insights.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {insights.map((i) => (
            <div key={i.label} className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">{i.label}</p>
              <p className="text-lg font-semibold tabular-nums">{i.value}</p>
              <p className="truncate text-xs text-muted-foreground" title={i.detail}>
                {i.detail}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {forecast !== null && forecast.rows.length > 1 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              Projected cash · next 30 days
              <Badge variant="outline" className="text-[10px] uppercase">
                Projection
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <BalanceTrendChart points={forecast.rows} height={160} />
            {forecast.bills.length > 0 ? (
              <div className="space-y-1">
                {forecast.bills.slice(0, 5).map((b) => (
                  <div
                    key={`${b.seriesId}-${b.date}`}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                      {b.date.slice(5)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <Money
                      amountMinor={b.sign === 'outflow' ? `-${b.amountMinor}` : b.amountMinor}
                      currency={b.currency}
                      signed
                      className="shrink-0 text-sm"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No confirmed recurring bills in the window yet — confirm suggestions on the
                Recurring page to project them here.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              A preview from your confirmed recurring bills — not a statement of record.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {netWorthTrend !== null && netWorthTrend.length > 1 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Net worth · last 90 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BalanceTrendChart points={netWorthTrend} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {showMonthlyFlow ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Cash flow by month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CashFlowMonthlyChart rows={monthlyFlow} />
            </CardContent>
          </Card>
        ) : null}
        {spending.length > 0 ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Spending · last 30 days
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryBarList items={spending} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Accounts</h2>
          <SyncStatus householdId={householdId} />
        </div>
        {accountList.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-6" />}
            title="No accounts yet"
            description="Connect a bank or add an account to start tracking balances."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {accountList.map((a, i) => (
              <Link
                key={a.id}
                href={`/dashboard/accounts/${a.id}`}
                className={`flex items-center justify-between px-4 py-3 transition-colors hover:bg-secondary/50 ${
                  i > 0 ? 'border-t border-border' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {a.subtype.replaceAll('_', ' ')}
                  </p>
                </div>
                <Money
                  amountMinor={balanceByLedger.get(a.ledgerAccountId) ?? '0'}
                  currency={a.currency}
                  className="text-sm"
                />
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
