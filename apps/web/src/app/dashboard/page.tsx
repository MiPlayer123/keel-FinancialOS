'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';

import { PageHeader, EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useEntityLens, lensAccountIdSet } from '@/components/keel/entity-lens-context';
import { useKeelInvalidate, useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchBudgetMonth,
  fetchCashFlowForecast,
  fetchConnections,
  fetchLedgerKinds,
  fetchSchedules,
  syncConnection,
  type AccountRow,
  type BudgetMonth,
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
import { buildInsights, type Insight } from '@/lib/dashboard-insights';
import { relativeDueLabel } from '@/lib/relative-date';
import { Badge } from '@/components/ui/badge';
import {
  BalanceTrendChart,
  CashFlowMonthlyChart,
  CategoryBarList,
  MonthPaceChart,
} from '@/components/keel/charts';
import { monthPace, type MonthPace } from '@/lib/month-pace';
import { spendingMix } from '@/lib/spending';
import { NetWorthHero } from '@/components/keel/net-worth-hero';
import { InfoNote } from '@/components/keel/info-note';
import { HomeBudgetCard } from '@/components/keel/budget-cards';
import { NotesTasksCard } from '@/components/keel/notes-tasks-card';
import { NeedsAttention } from '@/components/keel/needs-attention';
import { formatMoney } from '@/lib/money';
import { currencyTotals, primaryCurrencyTotal } from '@/lib/currency-totals';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  RefreshCw,
  Loader2,
  TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { Separator } from '@/components/ui/separator';

export default function HomePage() {
  return (
    <>
      <PageHeader title="Home" />
      <div className="flex flex-col gap-6 p-4 sm:p-6">
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
  // Oldest successful sync among connections that HAVE synced — a connection
  // still awaiting its first sync shouldn't hide real freshness info.
  const lastSync = syncTimestamps.sort((a, b) => a.localeCompare(b))[0] ?? null;
  const firstSyncPending = syncTimestamps.length < syncableConnections.length;

  if (syncableConnections.length === 0) return null;

  const ago = lastSync ? agoLabel(lastSync) : null;

  async function syncNow() {
    setBusy(true);
    try {
      // allSettled: one connection failing to kick off must not abort or
      // misreport the ones that did start (review P2-1).
      const results = await Promise.allSettled(
        syncableConnections.map((connection) =>
          syncConnection({ householdId, connectionId: connection.id }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      if (fulfilled === results.length) {
        toast.success('Sync started — new transactions land within a minute or two.');
      } else if (fulfilled > 0) {
        toast.warning(
          `Synced ${String(fulfilled)} of ${String(results.length)} connections — retry for the rest.`,
        );
      } else {
        const firstRejection: unknown = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        )?.reason;
        toast.error(
          firstRejection instanceof Error ? firstRejection.message : 'Sync failed to start.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {ago
        ? `Updated ${ago}${firstSyncPending ? ' · first sync pending' : ''}`
        : 'Syncs automatically'}
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


const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortMonth(key: string): string {
  return MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? key;
}

/**
 * "Where do I stand this month" — the first thing on Home. Month-to-date
 * spend vs the SAME day last month (never vs a full month, which would read
 * "way under" every early-month visit), with last month's curve as the pace
 * line. Lens-scoped like every transaction-derived card.
 */
function MonthPaceCard({ pace }: { pace: MonthPace }) {
  const thisName = shortMonth(pace.month);
  const prevName = shortMonth(pace.prevMonth);
  const delta = pace.spentMinor - pace.prevSpentToDateMinor;
  const netMinor = pace.incomeMinor - pace.spentMinor;
  const empty = pace.spentMinor === 0n && pace.incomeMinor === 0n;
  const prevHasData = pace.prevSpentTotalMinor !== 0n;
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          This month
          <InfoNote>
            <p>Spending so far vs the same day last month.</p>
            <p>Net of refunds. Excludes transfers and card payments. {pace.currency} only.</p>
          </InfoNote>
        </CardTitle>
        <CardAction>
          <Link
            href="/dashboard/reports?range=this_month"
            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
          >
            Reports
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {empty ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Nothing posted yet in {thisName}.
              {pace.lastActivityDate && pace.lastActivityDate.slice(0, 7) < pace.prevMonth
                ? ` Latest activity was ${pace.lastActivityDate}.`
                : ''}
            </p>
            {prevHasData ? (
              // Early-month fallback: last month's result, so the card still
              // answers "how did I do" before anything posts.
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="text-xs text-muted-foreground">{prevName} result</span>
                <span className="flex items-baseline gap-1.5 text-sm">
                  <span className="text-muted-foreground">Spent</span>
                  <Money
                    amountMinor={pace.prevSpentTotalMinor.toString()}
                    currency={pace.currency}
                    className="text-lg font-semibold"
                  />
                </span>
                <span className="flex items-baseline gap-1.5 text-sm">
                  <span className="text-muted-foreground">Earned</span>
                  <Money
                    amountMinor={pace.prevIncomeTotalMinor.toString()}
                    currency={pace.currency}
                    className="font-medium"
                  />
                </span>
                <span className="flex items-baseline gap-1.5 text-sm">
                  <span className="text-muted-foreground">Net</span>
                  <Money
                    amountMinor={(pace.prevIncomeTotalMinor - pace.prevSpentTotalMinor).toString()}
                    currency={pace.currency}
                    signed
                    className="font-medium"
                  />
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
            <div>
              <p className="text-xs text-muted-foreground">Spent so far</p>
              <Money
                amountMinor={pace.spentMinor.toString()}
                currency={pace.currency}
                className="text-3xl font-semibold"
                muteZero={false}
              />
              {prevHasData ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  {delta === 0n ? (
                    <span>Same as this point in {prevName}</span>
                  ) : (
                    <>
                      {delta > 0n ? (
                        <ArrowUpRight className="size-3.5" />
                      ) : (
                        <ArrowDownRight className="size-3.5" />
                      )}
                      <Money
                        amountMinor={(delta < 0n ? -delta : delta).toString()}
                        currency={pace.currency}
                        className="text-xs text-muted-foreground"
                      />
                      <span>
                        {delta > 0n ? 'more' : 'less'} than this point in {prevName}
                      </span>
                    </>
                  )}
                </p>
              ) : null}
            </div>
            <div className="flex gap-6 pb-1">
              <div>
                <p className="text-xs text-muted-foreground">Earned</p>
                <Money
                  amountMinor={pace.incomeMinor.toString()}
                  currency={pace.currency}
                  className="text-sm font-medium"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Net</p>
                <Money
                  amountMinor={netMinor.toString()}
                  currency={pace.currency}
                  signed
                  className="text-sm font-medium"
                />
              </div>
            </div>
          </div>
        )}
        {!empty || prevHasData ? (
          <>
            <MonthPaceChart
              points={pace.series}
              currency={pace.currency}
              thisLabel={thisName}
              lastLabel={prevName}
              height={140}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 rounded" style={{ background: 'var(--chart-1)' }} />
                {thisName} cumulative spend
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t border-dashed border-muted-foreground" />
                {prevName}
                {prevHasData
                  ? ` (total ${formatMoney(pace.prevSpentTotalMinor.toString(), { currency: pace.currency })})`
                  : null}
              </span>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One upcoming money event: a confirmed series' expected occurrence or an
 *  active schedule's next due date (overdue schedules included — they're
 *  still ahead of you until entered). */
type UpcomingItem = {
  key: string;
  name: string;
  date: string;
  /** Signed: negative = money out. */
  amountMinor: string;
  currency: string;
  href: string;
  scheduled: boolean;
};

function RecentTransactionsCard({ rows }: { rows: RichTransactionRow[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Recent transactions</CardTitle>
        <CardAction>
          <Link
            href="/dashboard/ledger"
            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
          >
            View all
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Transactions appear here after they sync.</p>
        ) : (
          rows.map((transaction, index) => (
            <Fragment key={transaction.transactionId}>
              <Link
                href={`/dashboard/ledger?q=${encodeURIComponent(transaction.description)}`}
                className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {merchantDisplayName(transaction.description)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    <time dateTime={transaction.effectiveDate}>
                      {transaction.effectiveDate.slice(5)}
                    </time>{' '}
                    · {transaction.accountName}
                  </p>
                </div>
                <Money
                  amountMinor={transaction.amountMinor}
                  currency={transaction.currency}
                  signed
                  className="shrink-0 text-sm"
                />
              </Link>
              {index < rows.length - 1 ? <Separator /> : null}
            </Fragment>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function UpcomingRecurringCard({
  rows,
  todayIso,
  confirmedCount,
}: {
  rows: UpcomingItem[];
  todayIso: string;
  confirmedCount: number;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Upcoming recurring</CardTitle>
        <CardAction>
          <Link
            href="/dashboard/recurring"
            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
          >
            View recurring
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {confirmedCount > 0
              ? `Nothing scheduled yet from your ${String(confirmedCount)} confirmed recurring series — upcoming dates appear after the next sync projects them.`
              : 'Confirm recurring bills and income to see what is coming up.'}
          </p>
        ) : (
          rows.map((item, index) => (
            <Fragment key={item.key}>
              <Link
                href={item.href}
                className="-mx-2 flex min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors first:pt-0 last:pb-0 hover:bg-accent"
              >
                <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.date < todayIso ? 'Overdue · ' : ''}
                    {relativeDueLabel(item.date, todayIso) ?? item.date.slice(5)}
                    {item.scheduled ? ' · scheduled' : ''}
                  </p>
                </div>
                <Money
                  amountMinor={item.amountMinor}
                  currency={item.currency}
                  signed
                  className="shrink-0 text-sm"
                />
              </Link>
              {index < rows.length - 1 ? <Separator /> : null}
            </Fragment>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SpendingCard({
  spending,
  insights,
}: {
  spending: ReturnType<typeof spendingMix>;
  insights: Insight[];
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Spending · last 30 days</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {spending.length > 0 ? (
          <CategoryBarList items={spending} />
        ) : (
          <p className="text-sm text-muted-foreground">No spending to summarize yet.</p>
        )}
        {insights.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              {insights.map((insight) => {
                const body = (
                  <>
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{insight.label}</p>
                      <p
                        className="truncate text-xs text-muted-foreground"
                        title={insight.rawDetail ?? insight.detail}
                      >
                        {insight.detail}
                      </p>
                    </div>
                    <p className="shrink-0 font-medium tabular-nums">{insight.value}</p>
                  </>
                );
                // Each insight number stands for a set of underlying
                // transactions — when it carries a drill-in href, make the whole
                // row a link into the ledger filtered to exactly those rows
                // (same drill pattern the cash-flow chart and report rows use;
                // proof on demand, Law 9).
                return insight.href ? (
                  <Link
                    key={insight.label}
                    href={insight.href}
                    className="-mx-2 flex items-start justify-between gap-4 rounded-md px-2 py-0.5 transition-colors hover:bg-accent"
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={insight.label} className="flex items-start justify-between gap-4">
                    {body}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProjectedCashCard({
  forecast,
  varies,
  todayIso,
}: {
  forecast: { rows: DailyBalanceRow[]; bills: ForecastBill[] };
  varies: boolean;
  todayIso: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Projected cash · next 30 days</CardTitle>
        <CardAction>
          <Badge variant="outline" className="text-[10px] uppercase">
            Projection
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {varies ? (
          <>
            <BalanceTrendChart points={forecast.rows} height={160} />
            {forecast.bills.length > 0 ? (
              <div className="flex flex-col gap-1">
                {forecast.bills.slice(0, 5).map((bill) => (
                  <div
                    key={`${bill.seriesId}-${bill.date}`}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                      {relativeDueLabel(bill.date, todayIso) ?? bill.date.slice(5)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{bill.name}</span>
                    <Money
                      amountMinor={
                        bill.sign === 'outflow' ? `-${bill.amountMinor}` : bill.amountMinor
                      }
                      currency={bill.currency}
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
  );
}

function HomeBody() {
  const { householdId, ready } = useHousehold();
  const invalidate = useKeelInvalidate(householdId);
  // Global entity lens (persona theme #2). null = "All entities" (blended,
  // pre-lens dashboard). A concrete id scopes every widget that can be
  // decomposed client-side by account→entity (net worth, spending mix,
  // insights, recent transactions, accounts summary). Widgets backed by a
  // household-wide PRE-AGGREGATED read model (Cash flow, Cash-flow-by-month,
  // Needs-attention, Free-to-spend) can't be split per entity here without a
  // backend scope param — those are HIDDEN under an active lens rather than
  // shown with a household number that contradicts the scoped hero (Law 9).
  const { entityId: entityLens, entity: lensEntity } = useEntityLens();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  // Net-worth trend now lives inside NetWorthHero (C11 fusion) — it fetches
  // the longest supported series once and subsets per range pill (C10).
  const monthlyFlow = useKeelQuery<MonthlyCashFlowRow>(
    'dashboard.cash_flow_monthly',
    householdId,
  );
  const richTxns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const recurringSeries = useKeelQuery<RecurringSeriesRow>('recurring.list', householdId);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [ledgerKinds, setLedgerKinds] = useState<Map<string, string> | null>(null);
  const [budgetPlan, setBudgetPlan] = useState<BudgetMonth | null>(null);
  const [forecast, setForecast] = useState<{
    rows: DailyBalanceRow[];
    bills: ForecastBill[];
  } | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [forecastAttempt, setForecastAttempt] = useState(0);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    setForecast(null);
    setForecastError(null);
    void fetchCashFlowForecast(householdId, 30)
      .then((f) => {
        if (active) setForecast(f);
      })
      .catch((error: unknown) => {
        if (active) {
          setForecast(null);
          setForecastError(error instanceof Error ? error.message : 'Could not load forecast.');
        }
      });
    return () => {
      active = false;
    };
  }, [householdId, forecastAttempt]);

  // This month's plan (same read as the Budgets page) for the Budget card.
  useEffect(() => {
    if (!householdId) return;
    let active = true;
    const now = new Date();
    const monthIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    void fetchBudgetMonth(householdId, monthIso)
      .then((plan) => {
        if (active) setBudgetPlan(plan);
      })
      .catch(() => {
        if (active) setBudgetPlan(null);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    setAccountsError(null);
    void fetchAccounts(householdId)
      .then((a) => {
        if (active) setAccounts(a);
      })
      .catch((error: unknown) => {
        if (active) {
          setAccounts([]);
          setAccountsError(error instanceof Error ? error.message : 'Could not load accounts.');
        }
      });
    return () => {
      active = false;
    };
  }, [householdId, accountsAttempt]);

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

  // Ledger-account kinds for the assets / liabilities line under net worth
  // (the same split the sidebar's account rail and Accounts page use).
  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchLedgerKinds(householdId)
      .then((k) => {
        if (active) setLedgerKinds(k);
      })
      .catch(() => {
        if (active) setLedgerKinds(null);
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
  const loading =
    !ready ||
    balances.loading ||
    richTxns.loading ||
    recurringSeries.loading ||
    waitingForAccounts;

  // The account ids inside the current lens (null = blended, no restriction) —
  // the one mapping every decomposable widget below narrows through.
  const lensAccountIds = useMemo(
    () => lensAccountIdSet(entityLens, accounts ?? []),
    [entityLens, accounts],
  );
  // richTxns scoped to the lens before any spending/insight/recent derivation,
  // so every transaction-derived card reflects exactly the lensed accounts.
  const lensTxns = useMemo(
    () =>
      lensAccountIds === null
        ? richTxns.rows
        : richTxns.rows.filter((t) => lensAccountIds.has(t.accountId)),
    [richTxns.rows, lensAccountIds],
  );

  // Hooks must run on EVERY render — these sit ABOVE the early returns below
  // (Rules of Hooks; placing them after `if (loading) return …` crashed the
  // whole dashboard — caught by the live UI verification pass).
  const spending = useMemo(() => spendingMix(lensTxns), [lensTxns]);
  const insights = useMemo(() => buildInsights(lensTxns), [lensTxns]);
  const recentTransactions = useMemo(
    () =>
      [...lensTxns]
        .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
        .slice(0, 8),
    [lensTxns],
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  const pace = useMemo(() => monthPace(lensTxns, todayIso), [lensTxns, todayIso]);
  const upcomingRecurring = useMemo<UpcomingItem[]>(() => {
    const horizon = new Date(`${todayIso}T00:00:00Z`);
    horizon.setUTCDate(horizon.getUTCDate() + 30);
    const horizonIso = horizon.toISOString().slice(0, 10);
    const fromSeries: UpcomingItem[] = recurringSeries.rows
      .filter((series) => series.status === 'confirmed')
      .flatMap((series) =>
        series.occurrences
          .filter(
            (occurrence) =>
              occurrence.status === 'expected' && occurrence.expectedDate >= todayIso,
          )
          .map((occurrence) => ({
            key: occurrence.occurrenceId,
            name: merchantDisplayName(series.counterpartyKey),
            date: occurrence.expectedDate,
            amountMinor:
              series.sign === 'outflow'
                ? `-${occurrence.expectedAmountMinor}`
                : occurrence.expectedAmountMinor,
            currency: occurrence.currency,
            // Still EXPECTED (no posted txn yet): drill into this
            // counterparty's past postings behind the recurring figure.
            href: `/dashboard/ledger?q=${encodeURIComponent(series.counterpartyKey)}`,
            scheduled: false,
          })),
      );
    const fromSchedules: UpcomingItem[] = schedules
      .filter((sc) => sc.status === 'active' && sc.nextDueDate <= horizonIso)
      .map((sc) => ({
        key: `schedule-${sc.scheduleId}`,
        name: merchantDisplayName(sc.description),
        date: sc.nextDueDate,
        amountMinor: sc.amountMinor,
        currency: sc.currency,
        href: '/dashboard/recurring',
        scheduled: true,
      }));
    return [...fromSeries, ...fromSchedules]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 6);
  }, [recurringSeries.rows, schedules, todayIso]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full max-w-sm" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!householdId) {
    // A failed setup is explained, with a retry, by HouseholdSetupNotice in
    // the app shell on every page; repeating it here would show two prompts.
    return (
      <EmptyState
        icon={<Wallet className="size-6" />}
        title="No household yet"
        description="Once your account is set up with a household, balances and accounts appear here."
      />
    );
  }

  const coreError = balances.error ?? accountsError;
  if (coreError) {
    return (
      <QueryErrorState
        onRetry={() => {
          setAccounts(null);
          setAccountsAttempt((attempt) => attempt + 1);
          void invalidate(['ledger.trial_balance']);
        }}
      />
    );
  }

  // Under an active lens the accounts summary + net worth count only the
  // lensed entity's accounts (a VIEW filter — the others aren't gone, just out
  // of scope). Blended keeps every account, unchanged.
  const lensActive = entityLens !== null;
  const accountList =
    lensAccountIds === null
      ? (accounts ?? [])
      : (accounts ?? []).filter((a) => lensAccountIds.has(a.id));

  const balanceByLedger = new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor]));
  const accountBalances = accountList.map((account) => ({
    amountMinor: balanceByLedger.get(account.ledgerAccountId) ?? '0',
    currency: account.currency,
  }));
  const netTotals = currencyTotals(accountBalances);
  const primaryNet = primaryCurrencyTotal(accountBalances) ?? {
    amountMinor: '0',
    currency: 'USD',
    rowCount: 0,
  };

  // Assets / liabilities in the primary currency, summed exactly as the
  // sidebar subtotals are (same balances, same kinds) so the three reconcile.
  let assetsMinor = 0n;
  let liabilitiesMinor = 0n;
  let hasLiabilities = false;
  if (ledgerKinds) {
    for (const account of accountList) {
      if (account.currency !== primaryNet.currency) continue;
      const bal = BigInt(balanceByLedger.get(account.ledgerAccountId) ?? '0');
      const kind = ledgerKinds.get(account.ledgerAccountId);
      if (kind === 'asset') assetsMinor += bal;
      else if (kind === 'liability') {
        liabilitiesMinor += bal;
        hasLiabilities = true;
      }
    }
  }
  const netBreakdown = ledgerKinds ? (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      <span>
        Assets{' '}
        <Money
          amountMinor={assetsMinor.toString()}
          currency={primaryNet.currency}
          className="text-xs text-foreground"
        />
      </span>
      {hasLiabilities ? (
        <span>
          Liabilities{' '}
          <Money
            amountMinor={liabilitiesMinor.toString()}
            currency={primaryNet.currency}
            className="text-xs text-foreground"
          />
        </span>
      ) : null}
    </p>
  ) : null;

  const monthlyFlowGroups = [...new Set(monthlyFlow.rows.map((row) => row.currency))]
    .map((currency) => ({
      currency,
      rows: monthlyFlow.rows.filter((row) => row.currency === currency),
    }))
    .filter((group) =>
      group.rows.some((row) => row.inflowMinor !== '0' || row.outflowMinor !== '0'),
    );
  // With no confirmed recurring occurrences in the window the forecast collapses
  // to a flat band (every balance equal) that reads as a broken chart
  // (DASHBOARD-7 / GOALSFORECAST-3). Only draw the chart once the series really
  // varies; otherwise the card shows the standard empty state below.
  const forecastVaries =
    forecast !== null &&
    forecast.rows.length > 1 &&
    new Set(forecast.rows.map((r) => r.balanceMinor)).size > 1;

  // Budget is household-wide: hidden under an entity lens, and when this
  // month has no budget.
  const showBudget = !lensActive && budgetPlan !== null && budgetPlan.rows.length > 0;
  // Fused net-worth hero (C11). Under an active entity lens it's
  // entity-scoped — the household-wide trend is suppressed.
  const netWorthHero = (
    <NetWorthHero
      householdId={householdId}
      fallbackNetMinor={primaryNet.amountMinor}
      fallbackCurrency={primaryNet.currency}
      fallbackMultiCurrency={netTotals.length > 1}
      fallbackAsOf={balances.asOf}
      entityScoped={lensActive}
      chartHeight={120}
      breakdown={netBreakdown}
      actions={<SyncStatus householdId={householdId} connections={connections ?? []} />}
      {...(lensActive && lensEntity ? { scopeLabel: `${lensEntity.name} only` } : {})}
    />
  );

  return (
    <>
      {/* Top row: "this month" (the action number) beside the budget — both
          are this-month numbers, so they read together. Net worth (the slow
          number) drops into the left column below. When the budget card is
          hidden (entity lens / no budget this month) net worth keeps the
          top-right slot so the row never has a hole. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          {richTxns.error ? null : <MonthPaceCard pace={pace} />}
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-5">
          {showBudget ? (
            <HomeBudgetCard plan={budgetPlan} todayIso={todayIso} className="flex-1" />
          ) : (
            netWorthHero
          )}
        </div>
      </div>

      {/* Unified actionable inbox (C16) — household-wide state, so blended
          view only (an entity lens would imply scoped counts). */}
      {richTxns.error || recurringSeries.error ? (
        <QueryErrorState
          onRetry={() => {
            void richTxns.refetch();
          }}
        />
      ) : lensActive ? null : (
        <NeedsAttention
          householdId={householdId}
          recurring={recurringSeries.rows}
          bills={forecast?.bills ?? null}
          connections={connections}
          transactions={richTxns.rows}
        />
      )}

      {/* Two independent columns (not a row grid) so cards of different
          heights stack without leaving holes. Mobile order follows source:
          spending → net worth (when budget holds the top row) → recent → upcoming → trend → projection → notes. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-7">
          {richTxns.error ? null : <SpendingCard spending={spending} insights={insights} />}
          {showBudget ? netWorthHero : null}
          {richTxns.error ? null : <RecentTransactionsCard rows={recentTransactions} />}
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-5">
          {lensActive || recurringSeries.error ? null : (
            <UpcomingRecurringCard
              rows={upcomingRecurring}
              todayIso={todayIso}
              confirmedCount={recurringSeries.rows.filter((r) => r.status === 'confirmed').length}
            />
          )}
          {/* Pre-aggregated household read model — hidden under a lens. */}
          {lensActive ? null : monthlyFlow.error ? (
            <QueryErrorState
              onRetry={() => {
                void monthlyFlow.refetch();
              }}
            />
          ) : (
            monthlyFlowGroups.map((group) => (
              <Card key={group.currency} size="sm">
                <CardHeader>
                  <CardTitle>
                    Cash flow by month
                    {monthlyFlowGroups.length > 1 ? ` · ${group.currency}` : ''}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CashFlowMonthlyChart rows={group.rows.slice(-6)} height={160} />
                </CardContent>
              </Card>
            ))
          )}
          {!lensActive && forecastError ? (
            <QueryErrorState
              onRetry={() => {
                setForecastAttempt((attempt) => attempt + 1);
              }}
            />
          ) : !lensActive && forecast !== null && forecastVaries ? (
            <ProjectedCashCard forecast={forecast} varies={forecastVaries} todayIso={todayIso} />
          ) : null}
          <NotesTasksCard householdId={householdId} compact />
        </div>
      </div>
    </>
  );
}
