'use client';

import { useMemo, useState } from 'react';
import { Repeat, Loader2, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import { BalanceTrendChart, type BalancePoint } from '@/components/keel/charts';
import {
  fetchAccounts,
  fetchLedgerKinds,
  type AccountRow,
  type RecurringSeriesRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import {
  RECURRING_ACTIONS,
  recurringTransition,
  nextOccurrence,
  changedToday,
  type RecurringCommand,
} from '@/lib/recurring';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useEffect } from 'react';

export default function RecurringPage() {
  return (
    <AppShell>
      <PageHeader
        title="Recurring"
        description="Subscriptions and bills KEEL has detected — confirm, pause or cancel them."
      />
      <div className="p-6">
        <RecurringBody />
      </div>
    </AppShell>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function RecurringBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const balanceRows = useKeelQuerySilent<TrialBalanceRow>('ledger.trial_balance', householdId);
  const [ledgerKinds, setLedgerKinds] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!householdId) return;
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
    void fetchLedgerKinds(householdId)
      .then(setLedgerKinds)
      .catch(() => {
        setLedgerKinds(new Map());
      });
  }, [householdId]);

  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? '';
  }, [accounts]);

  if (!ready || loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<Repeat className="size-6" />}
        title="Couldn't load recurring series"
        description={error}
      />
    );
  }

  const today = todayIso();
  const active = rows.filter((r) => r.status === 'confirmed');
  const suggested = rows.filter((r) => r.status === 'suggested');
  const paused = rows.filter((r) => r.status === 'paused');

  if (!householdId || rows.length === 0 || (active.length === 0 && suggested.length === 0 && paused.length === 0)) {
    return (
      <EmptyState
        icon={<Repeat className="size-6" />}
        title="No recurring activity yet"
        description="As transactions sync, KEEL detects subscriptions and regular bills and suggests them here for your approval. Detection runs nightly."
      />
    );
  }

  const upcoming = active
    .flatMap((s) =>
      s.occurrences
        .filter((o) => o.status === 'expected' && o.expectedDate >= today)
        .map((o) => ({ series: s, occ: o })),
    )
    .sort((a, b) => a.occ.expectedDate.localeCompare(b.occ.expectedDate))
    .slice(0, 12);

  return (
    <div className="space-y-8">
      {upcoming.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Coming up</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {upcoming.map(({ series, occ }, i) => (
              <div
                key={occ.occurrenceId}
                className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                  {occ.expectedDate.slice(5)}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm">{series.counterpartyKey}</p>
                <Money
                  amountMinor={
                    series.sign === 'outflow'
                      ? `-${occ.expectedAmountMinor}`
                      : occ.expectedAmountMinor
                  }
                  currency={occ.currency}
                  signed
                  className="shrink-0 text-sm"
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <OccurrenceCalendar rows={active} />

      <ProjectedCash
        series={active}
        balances={balanceRows ?? []}
        accounts={accounts}
        ledgerKinds={ledgerKinds}
      />

      {suggested.length > 0 ? (
        <SeriesSection
          title="Suggested"
          hint="Detected from your transaction history — nothing is tracked until you confirm."
          rows={suggested}
          accountName={accountName}
          householdId={householdId}
          userId={userId}
          onDone={() => void refetch()}
        />
      ) : null}

      {active.length > 0 ? (
        <SeriesSection
          title="Active"
          rows={active}
          accountName={accountName}
          householdId={householdId}
          userId={userId}
          onDone={() => void refetch()}
        />
      ) : null}

      {paused.length > 0 ? (
        <SeriesSection
          title="Paused"
          rows={paused}
          accountName={accountName}
          householdId={householdId}
          userId={userId}
          onDone={() => void refetch()}
        />
      ) : null}
    </div>
  );
}

function SeriesSection({
  title,
  hint,
  rows,
  accountName,
  householdId,
  userId,
  onDone,
}: {
  title: string;
  hint?: string;
  rows: RecurringSeriesRow[];
  accountName: (id: string) => string;
  householdId: string;
  userId: string | null;
  onDone: () => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="space-y-2">
        {rows.map((s) => (
          <SeriesCard
            key={s.seriesId}
            series={s}
            accountName={accountName(s.accountId)}
            householdId={householdId}
            userId={userId}
            onDone={onDone}
          />
        ))}
      </div>
    </section>
  );
}

function SeriesCard({
  series,
  accountName,
  householdId,
  userId,
  onDone,
}: {
  series: RecurringSeriesRow;
  accountName: string;
  householdId: string;
  userId: string | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<RecurringCommand | null>(null);
  const next = nextOccurrence(series, todayIso());
  const lockedToday = series.status !== 'suggested' && changedToday(series, todayIso());
  const actions = RECURRING_ACTIONS[series.status];

  async function act(command: RecurringCommand) {
    if (!userId) return;
    setBusy(command);
    try {
      await recurringTransition({ command, seriesId: series.seriesId, householdId, userId });
      toast.success('Updated.');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{series.counterpartyKey}</p>
            <Badge variant="secondary" className="capitalize">
              {series.sign}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {accountName}
            {next ? (
              <>
                {accountName ? ' · ' : ''}
                next <Money amountMinor={next.expectedAmountMinor} currency={next.currency} /> on{' '}
                <span className="font-mono">{next.expectedDate}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {lockedToday ? (
            <span className="text-xs text-muted-foreground">
              Changed today — next change available tomorrow.
            </span>
          ) : (
            actions.map(({ command, label }, i) => (
              <Button
                key={command}
                variant={i === 0 ? 'default' : 'outline'}
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  void act(command);
                }}
              >
                {busy === command ? <Loader2 className="size-4 animate-spin" /> : null}
                {label}
              </Button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Month calendar of expected occurrences (confirmed series only). Pure
// layout over data the page already has; amounts stay minor-unit strings.
// ---------------------------------------------------------------------------
function OccurrenceCalendar({ rows }: { rows: RecurringSeriesRow[] }) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = first.getUTCDay(); // 0 = Sunday
  const nowIso = now.toISOString().slice(0, 10);
  const monthKey = nowIso.slice(0, 7);

  const byDay = new Map<
    number,
    { name: string; signedMinor: string; currency: string; paid: boolean }[]
  >();
  for (const s of rows) {
    if (s.status !== 'confirmed') continue;
    for (const o of s.occurrences) {
      // Upcoming (expected) and already-paid (matched) only; a missed
      // occurrence at its expected amount would read as a bill still due.
      if (o.status !== 'expected' && o.status !== 'matched') continue;
      if (!o.expectedDate.startsWith(monthKey)) continue;
      const day = Number(o.expectedDate.slice(8, 10));
      const list = byDay.get(day) ?? [];
      list.push({
        name: s.counterpartyKey,
        signedMinor:
          s.sign === 'outflow' ? `-${o.expectedAmountMinor}` : o.expectedAmountMinor,
        currency: o.currency,
        paid: o.status === 'matched',
      });
      byDay.set(day, list);
    }
  }
  if (byDay.size === 0) return null;

  const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][month];

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {monthName} {String(year)}
      </h2>
      <div className="overflow-x-auto">
        <div className="min-w-[560px] overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-7 border-b border-border bg-secondary/30 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: lead }).map((_, i) => (
              <div key={`lead-${String(i)}`} className="min-h-16 border-b border-r border-border/60" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const iso = `${monthKey}-${String(day).padStart(2, '0')}`;
              const items = byDay.get(day) ?? [];
              const isToday = iso === nowIso;
              return (
                <div
                  key={day}
                  className={`min-h-16 space-y-0.5 border-b border-r border-border/60 p-1 ${
                    isToday ? 'bg-secondary/40' : ''
                  }`}
                >
                  <p
                    className={`text-right text-[11px] ${
                      isToday ? 'font-semibold' : 'text-muted-foreground'
                    }`}
                  >
                    {String(day)}
                  </p>
                  {items.slice(0, 2).map((item, idx) => (
                    <p
                      key={`${item.name}-${String(idx)}`}
                      className={`truncate text-[11px] leading-tight ${
                        item.paid ? 'text-muted-foreground/70 line-through decoration-border' : ''
                      }`}
                      title={item.paid ? `${item.name} — paid` : item.name}
                    >
                      {item.name}
                      <span className="text-muted-foreground">
                        {' '}
                        <Money amountMinor={item.signedMinor} currency={item.currency} signed className="text-[11px]" />
                      </span>
                    </p>
                  ))}
                  {items.length > 2 ? (
                    <p className="text-[10px] text-muted-foreground">+{String(items.length - 2)}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Projected cash: today's asset balances rolled forward through the expected
// occurrences of confirmed series (Quicken's "Projected Balances", household
// level). Pure BigInt arithmetic over data already on the page — Law 1.
// Approximation, stated in the caption: card-charged subscriptions reduce the
// projection when charged, not when the card is paid.
// ---------------------------------------------------------------------------
const PROJECTION_DAYS = 60;

function ProjectedCash({
  series,
  balances,
  accounts,
  ledgerKinds,
}: {
  series: RecurringSeriesRow[];
  balances: TrialBalanceRow[];
  accounts: AccountRow[];
  ledgerKinds: Map<string, string>;
}) {
  const projection = useMemo(() => {
    if (balances.length === 0 || ledgerKinds.size === 0) return null;
    const assetLedgerIds = new Set(
      accounts
        .filter((a) => ledgerKinds.get(a.ledgerAccountId) === 'asset')
        .map((a) => a.ledgerAccountId),
    );
    if (assetLedgerIds.size === 0) return null;
    const assetRows = balances.filter((b) => assetLedgerIds.has(b.ledgerAccountId));
    if (assetRows.length === 0) return null;
    // Single-currency projection: the dominant currency across asset accounts.
    const counts = new Map<string, number>();
    for (const b of assetRows) counts.set(b.currency, (counts.get(b.currency) ?? 0) + 1);
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
    let base = 0n;
    for (const b of assetRows) {
      if (b.currency === currency) base += BigInt(b.balanceMinor || '0');
    }

    const start = new Date();
    const startIso = start.toISOString().slice(0, 10);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + PROJECTION_DAYS);
    const endIso = end.toISOString().slice(0, 10);

    const deltaByDate = new Map<string, bigint>();
    for (const s of series) {
      if (s.status !== 'confirmed') continue;
      for (const o of s.occurrences) {
        if (o.status !== 'expected') continue;
        if (o.currency !== currency) continue;
        if (o.expectedDate <= startIso || o.expectedDate > endIso) continue;
        const amt = BigInt(o.expectedAmountMinor || '0');
        const delta = s.sign === 'outflow' ? -amt : amt;
        deltaByDate.set(o.expectedDate, (deltaByDate.get(o.expectedDate) ?? 0n) + delta);
      }
    }
    if (deltaByDate.size === 0) return null;

    const points: BalancePoint[] = [{ date: startIso, balanceMinor: base.toString(), currency }];
    let running = base;
    let low = base;
    let lowDate = startIso;
    for (const [date, delta] of [...deltaByDate.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      running += delta;
      points.push({ date, balanceMinor: running.toString(), currency });
      if (running < low) {
        low = running;
        lowDate = date;
      }
    }
    points.push({ date: endIso, balanceMinor: running.toString(), currency });
    return { points, low, lowDate, currency };
  }, [series, balances, accounts, ledgerKinds]);

  if (!projection) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Projected cash · next {PROJECTION_DAYS} days
      </h2>
      <div className="rounded-lg border border-border p-4">
        <BalanceTrendChart points={projection.points} height={180} />
        <p className="mt-2 text-xs text-muted-foreground">
          Today&apos;s asset balances rolled forward through confirmed recurring bills and
          income. Lowest point:{' '}
          <Money
            amountMinor={projection.low.toString()}
            currency={projection.currency}
            className="text-xs"
          />{' '}
          around {projection.lowDate}. Card-charged subscriptions are counted when they
          charge, not when the card is paid.
        </p>
      </div>
    </section>
  );
}
