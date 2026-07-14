'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, Check, X, Loader2, ArrowRight, ArrowLeftRight } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  keelCommand,
  newId,
  keelQuery,
  detectTransfers,
  decideTransfer,
  type RecurringSeriesRow,
  type TransferLinkRow,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReviewPage() {
  return (
    <>
      <PageHeader title="Review" description="Approve or dismiss what the AI suggests." />
      <div className="p-6">
        <ReviewBody />
      </div>
    </>
  );
}

function ReviewBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );
  const transfers = useTransferSuggestions(householdId);

  const suggested = rows.filter((r) => r.status === 'suggested');

  if (!ready || (loading && transfers.loading)) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const nothingRecurring = Boolean(error) || suggested.length === 0;
  const nothingTransfers = transfers.suggested.length === 0;

  if (error && nothingTransfers) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Couldn't load suggestions"
        description={error}
      />
    );
  }

  if (!householdId || (nothingRecurring && nothingTransfers)) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Nothing to review"
        description="Recurring series, transfer matches and categorizations will surface here as suggestions — each waiting for your approval."
      />
    );
  }

  return (
    <div className="space-y-8">
      {transfers.suggested.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Possible transfers</h2>
          <p className="text-xs text-muted-foreground">
            These pairs look like money moving between your own accounts. Confirming keeps
            both sides in the ledger but stops them counting as income and spending.
          </p>
          {transfers.suggested.map((link) => (
            <TransferCard
              key={link.linkId}
              link={link}
              householdId={householdId}
              onDone={() => {
                void transfers.refetch();
              }}
            />
          ))}
        </section>
      ) : null}

      {suggested.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Recurring series</h2>
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
        </section>
      ) : null}
    </div>
  );
}

/**
 * Detect (deterministic, idempotent) then list transfer suggestions.
 * Detection failures degrade to an empty list — the section simply hides
 * until the backend supports it.
 */
function useTransferSuggestions(householdId: string | null) {
  const [rows, setRows] = useState<TransferLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!householdId) {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await detectTransfers(householdId).catch(() => 0);
        const res = await keelQuery<TransferLinkRow>('transfers.list', householdId);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows(res.rows);
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows([]);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [householdId, reload]);

  return {
    suggested: rows.filter((r) => r.status === 'suggested'),
    loading,
    refetch: () => {
      setReload((n) => n + 1);
      return Promise.resolve();
    },
  };
}

function TransferCard({
  link,
  householdId,
  onDone,
}: {
  link: TransferLinkRow;
  householdId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);

  async function act(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'reject');
    try {
      await decideTransfer({ householdId, linkId: link.linkId, confirm });
      toast.success(confirm ? 'Marked as a transfer.' : 'Kept as regular transactions.');
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
            <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">
              {link.outAccountName}
              <ArrowRight className="mx-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />
              {link.inAccountName}
            </p>
          </div>
          <p className="truncate text-xs text-muted-foreground" title={link.outDescription}>
            {link.outDescription}
          </p>
          <p className="text-sm text-muted-foreground">
            <Money amountMinor={link.amountMinor} currency={link.currency} /> on{' '}
            <span className="font-mono text-xs">{link.effectiveDate}</span>
            {link.dayGap > 0 ? (
              <span className="text-xs"> · sides {link.dayGap}d apart</span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act(false);
            }}
          >
            {busy === 'reject' ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
            Not a transfer
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act(true);
            }}
          >
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Confirm transfer
          </Button>
        </div>
      </CardContent>
    </Card>
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
      // Payload is exactly {seriesId, effectiveDate(, horizonDays)} — the
      // contracts schemas are .strict(); the candidateVersionHash we used to
      // send made every confirm/reject a 400.
      await keelCommand({
        commandId: newId(),
        command,
        economicEventKey: `${command}:${series.seriesId}:${effectiveDate}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          seriesId: series.seriesId,
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
