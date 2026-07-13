'use client';

import { useMemo, useState } from 'react';
import { Repeat, Loader2, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import { fetchAccounts, type AccountRow, type RecurringSeriesRow } from '@/lib/keel-api';
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

  useEffect(() => {
    if (!householdId) return;
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
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
