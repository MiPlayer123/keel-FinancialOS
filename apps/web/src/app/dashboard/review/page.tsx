'use client';

import { useState } from 'react';
import { BadgeCheck, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import { keelCommand, newId, type RecurringSeriesRow } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReviewPage() {
  return (
    <AppShell>
      <PageHeader title="Review" description="Approve or dismiss what the AI suggests." />
      <div className="p-6">
        <ReviewBody />
      </div>
    </AppShell>
  );
}

function ReviewBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );

  const suggested = rows.filter((r) => r.status === 'suggested');

  if (!ready || loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Couldn't load suggestions"
        description={error}
      />
    );
  }

  if (!householdId || suggested.length === 0) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Nothing to review"
        description="Recurring series, transfer matches and categorizations will surface here as suggestions — each waiting for your approval."
      />
    );
  }

  return (
    <div className="space-y-3">
      {suggested.map((series) => (
        <SuggestionCard
          key={series.seriesId}
          series={series}
          householdId={householdId}
          userId={userId}
          onDone={() => {
            void refetch();
          }}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  series,
  householdId,
  userId,
  onDone,
}: {
  series: RecurringSeriesRow;
  householdId: string;
  userId: string | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const first = series.occurrences[0];

  async function act(command: 'recurring.confirm' | 'recurring.reject') {
    if (!userId) return;
    const kind = command === 'recurring.confirm' ? 'confirm' : 'reject';
    setBusy(kind);
    const effectiveDate = today();
    try {
      await keelCommand({
        commandId: newId(),
        command,
        economicEventKey: `${command}:${series.seriesId}:${effectiveDate}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          seriesId: series.seriesId,
          candidateVersionHash: series.candidateVersionHash,
          effectiveDate,
          ...(command === 'recurring.confirm' ? { horizonDays: 90 } : {}),
        },
      });
      toast.success(kind === 'confirm' ? 'Recurring series confirmed.' : 'Suggestion dismissed.');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{series.counterpartyKey}</p>
            <Badge variant="secondary" className="capitalize">
              {series.sign}
            </Badge>
          </div>
          {first ? (
            <p className="text-sm text-muted-foreground">
              Next <Money amountMinor={first.expectedAmountMinor} currency={first.currency} /> on{' '}
              <span className="font-mono text-xs">{first.expectedDate}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Detected recurring series</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act('recurring.reject');
            }}
          >
            {busy === 'reject' ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
            Dismiss
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act('recurring.confirm');
            }}
          >
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Confirm
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
