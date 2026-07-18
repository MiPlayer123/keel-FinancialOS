'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCashFlowForecast,
  fetchConnections,
  fetchSchedules,
  syncConnection,
  type AccountRow,
  type ConnectionRow,
  type DailyBalanceRow,
  type ForecastBill,
  type MonthlyCashFlowRow,
  type RecurringSeriesRow,
  type RichTransactionRow,
  type ScheduleRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { merchantDisplayName } from '@/lib/merchant-name';
import { stepScheduleDue } from '@/lib/recurring';
import { relativeDueLabel } from '@/lib/relative-date';
import { Badge } from '@/components/ui/badge';
import { CashFlowCard } from '@/components/keel/cash-flow-card';
import { BalanceTrendChart, CashFlowMonthlyChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix, isDebtOrTransferLike } from '@/lib/spending';
import { NetWorthHero } from '@/components/keel/net-worth-hero';
import { NotesTasksCard } from '@/components/keel/notes-tasks-card';
import { NeedsAttention } from '@/components/keel/needs-attention';
import { formatMoney } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button, buttonVariants } from '@/components/ui/button';
import { RefreshCw, Loader2, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';

export default function HomePage() {
  return (
    <>
      <PageHeader title="Home" description="Your financial position at a glance." />
      <div className="space-y-8 p-6">
        <HomeBody />
      </div>
    </>
  );
}

/**
 * "Do I have to sync manually?" — no: KEEL syncs itself every few minutes
 * (a 3-minute drain cron plus a 15-minute scheduler). This shows when data
 * last landed and offers an immediate refresh for the impatient moment.
 * Connections arrive as a prop — HomeBody fetches them once and shares the
 * result with the Needs-attention module (reauth row).
 */
function SyncStatus({
  householdId,
  connections,
}: {
  householdId: string;
  connections: ConnectionRow[];
}) {
  const [busy, setBusy] = useState(false);

  const syncableConnections = connections.filter(
    (connection) => connection.status !== 'disconnected',
  );
  const syncTimestamps = syncableConnections.flatMap((connection) =>
    connection.lastSuccessfulSyncAt ? [connection.lastSuccessfulSyncAt] : [],
  );
  const lastSync =
    syncTimestamps.length === syncableConnections.length
      ? (syncTimestamps.sort((a, b) => a.localeCompare(b))[0] ?? null)
      : null;

  if (syncableConnections.length === 0) return null;

  const ago = lastSync ? agoLabel(lastSync) : null;

  async function syncNow() {
    setBusy(true);
    try {
      await Promise.all(
        syncableConnections.map((connection) =>
          syncConnection({ householdId, connectionId: connection.id }),
        ),
      );
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

// rawDetail: unabbreviated source string (e.g. the raw bank memo behind a
// cleaned merchant name) — surfaces in the tooltip so the inference never
// hides the source (Law 9; review finding).
type Insight = { label: string; value: string; detail: string; rawDetail?: string };

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

  // BigInt sums are only meaningful within one currency; aggregate the
  // household's dominant currency and format with it.
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const domCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  let biggest: RichTransactionRow | null = null;
  let mtd = 0n;
  let prevToSameDay = 0n;
  const merchants = new Map<string, bigint>();

  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== domCurrency) continue;
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
      value: formatMoney(biggest.amountMinor.replace('-', ''), { currency: biggest.currency }),
      detail: merchantDisplayName(biggest.description).slice(0, 40),
      rawDetail: biggest.description,
    });
  }
  if (mtd > 0n && prevToSameDay > 0n) {
    const deltaPct = Number(((mtd - prevToSameDay) * 100n) / prevToSameDay);
    out.push({
      label: 'Spending pace vs last month',
      value: `${deltaPct >= 0 ? '+' : ''}${String(deltaPct)}%`,
      detail: `${formatMoney(mtd.toString(), { currency: domCurrency })} so far vs ${formatMoney(prevToSameDay.toString(), { currency: domCurrency })} by day ${String(dayOfMonth)}`,
    });
  }
  const rankedMerchants = [...merchants.entries()].sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  );
  // The true top merchant, always — even when it also owns the biggest 7-day
  // purchase. Skipping to rank 2 would mislabel the tile (review finding);
  // with money-movement excluded upstream, an honest overlap is fine.
  const topMerchant = rankedMerchants[0];
  if (topMerchant && topMerchant[1] > 0n) {
    out.push({
      label: 'Top merchant this month',
      value: formatMoney(topMerchant[1].toString(), { currency: domCurrency }),
      // Display-only cleanup; aggregation stays keyed on the raw memo.
      detail: merchantDisplayName(topMerchant[0]).slice(0, 40),
      rawDetail: topMerchant[0],
    });
  }
  return out;
}

type FreeToSpend = {
  currency: string;
  freeMinor: bigint;
  receivedMinor: bigint;
  expectedMinor: bigint;
  spentMinor: bigint;
  billsDueMinor: bigint;
  /** Whole days strictly after today through month end (may be 0 on the last day). */
  daysLeft: number;
  /** Floor(free / daysLeft) minor units, only meaningful when free > 0 and days remain. */
  perDayMinor: bigint | null;
  hasRecurringData: boolean;
};

/**
 * "Free to spend" this month (Simplifi/Copilot-style headline), computed
 * entirely from data already on the page — Law 1, no model in the loop.
 * free = received so far + expected income still to come
 *       − spent so far − bills still due.
 * CASH scope: only confirmed transfer pairs are excluded (they net to zero in
 * the household); an unpaired debt/CC payment is real cash out and counts as
 * spent — excluding it would overstate "free" (review finding). This differs
 * deliberately from the SPENDING scope used by the mix/insight cards.
 * Only confirmed recurring series and active schedules count as "still to
 * come" — mirrors Recurring's Projected Cash card, including its documented
 * double-count risk when a schedule duplicates a detected series (the user
 * is expected to pause one; no fuzzy dedupe here either).
 */
function computeFreeToSpend(
  richTxns: RichTransactionRow[],
  series: RecurringSeriesRow[],
  schedules: ScheduleRow[],
): FreeToSpend | null {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [yearStr, monthStr] = todayIso.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  const month = todayIso.slice(0, 7);
  const dayOfMonth = Number(todayIso.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const monthEndIso = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);

  const currencyCounts = new Map<string, number>();
  for (const t of richTxns) {
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const currency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  let receivedMinor = 0n;
  let spentMinor = 0n;
  for (const t of richTxns) {
    // CASH semantics, not spending semantics: only confirmed transfer PAIRS
    // net to zero inside the household. An unpaired debt/CC payment is real
    // cash that left this month — excluding it would overstate "free to
    // spend" in the dangerous direction (review finding; cf. ledger "Out").
    if (t.transferStatus === 'confirmed') continue;
    if (t.currency !== currency) continue;
    if (!t.effectiveDate.startsWith(month)) continue;
    const amt = BigInt(t.amountMinor || '0');
    if (amt > 0n) receivedMinor += amt;
    else if (amt < 0n) spentMinor += -amt;
  }

  let expectedMinor = 0n;
  let billsDueMinor = 0n;
  for (const s of series) {
    if (s.status !== 'confirmed') continue;
    for (const o of s.occurrences) {
      if (o.status !== 'expected') continue;
      if (o.currency !== currency) continue;
      if (!o.expectedDate.startsWith(month)) continue;
      // Today counts as STILL DUE: an occurrence dated today with status
      // 'expected' hasn't matched a posted transaction yet, so it's in
      // neither received nor spent — dropping it would overstate "free"
      // right before the money leaves. Once it posts and matches, its
      // status leaves 'expected' and it exits this sum.
      if (o.expectedDate < todayIso) continue;
      const amt = BigInt(o.expectedAmountMinor || '0');
      if (s.sign === 'inflow') expectedMinor += amt;
      else billsDueMinor += amt;
    }
  }

  for (const sc of schedules) {
    if (sc.status !== 'active') continue;
    if (sc.currency !== currency) continue;
    let due = sc.nextDueDate;
    let guard = 0;
    while (due <= monthEndIso && guard < 60) {
      // Same today-counts-as-due rule: an un-entered schedule due today is
      // still ahead of you (Enter advances the date, removing it here).
      if (due >= todayIso) {
        const amt = BigInt(sc.amountMinor || '0');
        if (amt > 0n) expectedMinor += amt;
        else billsDueMinor += -amt;
      }
      if (sc.frequency === 'once') break;
      due = stepScheduleDue(due, sc.frequency, sc.anchorDay);
      guard += 1;
    }
  }

  const freeMinor = receivedMinor + expectedMinor - spentMinor - billsDueMinor;
  const perDayMinor = freeMinor > 0n && daysLeft > 0 ? freeMinor / BigInt(daysLeft) : null;

  return {
    currency,
    freeMinor,
    receivedMinor,
    expectedMinor,
    spentMinor,
    billsDueMinor,
    daysLeft,
    perDayMinor,
    hasRecurringData: series.length > 0 || schedules.length > 0,
  };
}

function FreeToSpendCard({
  richTxns,
  series,
  schedules,
}: {
  richTxns: RichTransactionRow[];
  series: RecurringSeriesRow[];
  schedules: ScheduleRow[];
}) {
  const fts = computeFreeToSpend(richTxns, series, schedules);
  if (!fts) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Free to spend · this month
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Money
            amountMinor={fts.freeMinor.toString()}
            currency={fts.currency}
            className="text-3xl font-semibold"
            muteZero={false}
          />
          {fts.perDayMinor !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatMoney(fts.perDayMinor.toString(), { currency: fts.currency })} / day for the{' '}
              {fts.daysLeft} day{fts.daysLeft === 1 ? '' : 's'} left this month
            </p>
          ) : null}
        </div>
        <div className={`grid grid-cols-2 gap-3 ${fts.hasRecurringData ? 'sm:grid-cols-4' : ''}`}>
          <div>
            <p className="text-xs text-muted-foreground">In so far</p>
            <Money
              amountMinor={fts.receivedMinor.toString()}
              currency={fts.currency}
              className="text-sm"
            />
          </div>
          {fts.hasRecurringData ? (
            <div>
              <p className="text-xs text-muted-foreground">Still expected</p>
              <Money
                amountMinor={fts.expectedMinor.toString()}
                currency={fts.currency}
                className="text-sm"
              />
            </div>
          ) : null}
          <div>
            <p className="text-xs text-muted-foreground">Spent so far</p>
            <Money
              amountMinor={`-${fts.spentMinor.toString()}`}
              currency={fts.currency}
              signed
              className="text-sm"
            />
          </div>
          {fts.hasRecurringData ? (
            <div>
              <p className="text-xs text-muted-foreground">Bills still due</p>
              <Money
                amountMinor={`-${fts.billsDueMinor.toString()}`}
                currency={fts.currency}
                signed
                className="text-sm"
              />
            </div>
          ) : null}
        </div>
        {fts.hasRecurringData ? (
          <p className="text-xs text-muted-foreground">
            Income received and spending so far, plus confirmed recurring bills/income and schedules
            still due this month (if a schedule duplicates a detected series, it counts twice —
            pause one on the Recurring page).
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HomeBody() {
  const { householdId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  // Net-worth trend now lives inside NetWorthHero (C11 fusion) — it fetches
  // the longest supported series once and subsets per range pill (C10).
  const monthlyFlow = useKeelQuerySilent<MonthlyCashFlowRow>(
    'dashboard.cash_flow_monthly',
    householdId,
  );
  const richTxns = useKeelQuerySilent<RichTransactionRow>('transactions.rich', householdId);
  const recurringSeries = useKeelQuerySilent<RecurringSeriesRow>('recurring.list', householdId);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
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

  // One connections fetch for the whole page: the Needs-attention reauth row
  // and the Accounts section's SyncStatus both read from it.
  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchConnections(householdId)
      .then((c) => {
        if (active) setConnections(c);
      })
      .catch(() => {
        if (active) setConnections([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchSchedules(householdId)
      .then((s) => {
        if (active) setSchedules(s);
      })
      .catch(() => {
        if (active) setSchedules([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  const waitingForAccounts = householdId !== null && accounts === null;
  const loading = !ready || balances.loading || waitingForAccounts;

  // Hooks must run on EVERY render — these sit ABOVE the early returns below
  // (Rules of Hooks; placing them after `if (loading) return …` crashed the
  // whole dashboard — caught by the live UI verification pass).
  const spending = useMemo(() => spendingMix(richTxns ?? []), [richTxns]);
  const insights = useMemo(() => buildInsights(richTxns ?? []), [richTxns]);

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

  const showMonthlyFlow =
    monthlyFlow !== null &&
    monthlyFlow.some((m) => m.inflowMinor !== '0' || m.outflowMinor !== '0');
  // With no confirmed recurring occurrences in the window the forecast collapses
  // to a flat band (every balance equal) that reads as a broken chart
  // (DASHBOARD-7 / GOALSFORECAST-3). Only draw the chart once the series really
  // varies; otherwise the card shows the standard empty state below.
  const forecastVaries =
    forecast !== null &&
    forecast.rows.length > 1 &&
    new Set(forecast.rows.map((r) => r.balanceMinor)).size > 1;
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <>
      {/* Unified actionable inbox (C16). Absorbs the old TransferNudgeBanner:
          suggested transfers are part of the review row's count, and Review is
          where confirming them (excluding from spending) actually happens. */}
      <NeedsAttention
        householdId={householdId}
        recurring={recurringSeries}
        bills={forecast?.bills ?? null}
        connections={connections}
        transactions={richTxns}
      />

      <FreeToSpendCard
        richTxns={richTxns ?? []}
        series={recurringSeries ?? []}
        schedules={schedules}
      />

      <NotesTasksCard householdId={householdId} compact />

      {/* Fused net-worth hero (C11): number + Δ + % + window + chart as one
          unit, with range pills (C10). Replaces the old bare Net position
          card AND the separate 90-day net-worth chart card. */}
      <NetWorthHero
        householdId={householdId}
        fallbackNetMinor={netMinor.toString()}
        fallbackAsOf={balances.asOf}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CashFlowCard householdId={householdId} />
      </div>

      {insights.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {insights.map((i) => (
            <div key={i.label} className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">{i.label}</p>
              <p className="text-lg font-semibold tabular-nums">{i.value}</p>
              <p className="truncate text-xs text-muted-foreground" title={i.rawDetail ?? i.detail}>
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
            {forecastVaries ? (
              <>
                <BalanceTrendChart points={forecast.rows} height={160} />
                {forecast.bills.length > 0 ? (
                  <div className="space-y-1">
                    {forecast.bills.slice(0, 5).map((b) => (
                      <div
                        key={`${b.seriesId}-${b.date}`}
                        className="flex items-center gap-3 text-sm"
                      >
                        <span className="w-16 shrink-0 text-xs text-muted-foreground">
                          {relativeDueLabel(b.date, todayIso) ?? b.date.slice(5)}
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
                ) : null}
                <p className="text-xs text-muted-foreground">
                  A preview from your confirmed recurring bills — not a statement of record.
                </p>
              </>
            ) : (
              <EmptyState
                icon={<TrendingUp className="size-6" />}
                title="No projection yet"
                description="Confirm your recurring bills and income and KEEL will roll your balance forward here."
                action={
                  <Link
                    href="/dashboard/recurring"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    Review recurring
                  </Link>
                }
              />
            )}
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
          <SyncStatus householdId={householdId} connections={connections ?? []} />
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
