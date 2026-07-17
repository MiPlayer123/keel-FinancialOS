'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CalendarClock,
  ChevronRight,
  Inbox,
  KeyRound,
  Tag,
  type LucideIcon,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  buildNeedsAttention,
  type AttentionRow,
  type UncategorizedLike,
} from '@/lib/needs-attention';
import {
  detectCategorySuggestions,
  detectTransfers,
  type CategorySuggestionRow,
  type ConnectionRow,
  type ForecastBill,
  type RecurringSeriesRow,
  type TransferLinkRow,
} from '@/lib/keel-api';

const ROW_ICONS: Record<AttentionRow['key'], LucideIcon> = {
  review: Inbox,
  bills: CalendarClock,
  reauth: KeyRound,
  uncategorized: Tag,
};

/**
 * Unified "Needs attention" module (teardown C16): one card near the top of
 * Home aggregating every actionable count — pending Review suggestions
 * (transfers + recurring + categorizations, the same three sources the nav
 * ReviewBadge counts, which also covers the old TransferNudgeBanner's job),
 * bills due within 7 days, connections needing reauth, and uncategorized
 * transactions. Each row deep-links to where the action happens. Hides
 * entirely at zero (calm > clutter). Counts are neutral — red stays reserved
 * for negative money (Law 8) — and sit adjacent to the label they qualify.
 *
 * Recurring series, forecast bills, connections, and rich transactions arrive
 * as props (Home already fetches them); only the two Review sources Home
 * didn't already load are fetched here.
 */
export function NeedsAttention({
  householdId,
  recurring,
  bills,
  connections,
  transactions,
}: {
  householdId: string;
  recurring: RecurringSeriesRow[] | null;
  bills: ForecastBill[] | null;
  connections: ConnectionRow[] | null;
  transactions: UncategorizedLike[] | null;
}) {
  // Run the idempotent detectors BEFORE listing (review finding: without
  // this, Home's counts are stale until the user visits Review, defeating
  // the inbox's purpose). Failures degrade to listing whatever is saved.
  const [detected, setDetected] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      detectTransfers(householdId),
      detectCategorySuggestions(householdId),
    ]).then(() => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
      if (active) setDetected(true);
    });
    return () => {
      active = false;
    };
  }, [householdId]);
  const transfers = useKeelQuerySilent<TransferLinkRow>(
    'transfers.list',
    detected ? householdId : null,
  );
  const categorizations = useKeelQuerySilent<CategorySuggestionRow>(
    'categorization.suggestions',
    detected ? householdId : null,
  );

  const rows = useMemo(
    () =>
      buildNeedsAttention({
        recurring,
        transfers,
        categorizations,
        bills,
        connections,
        transactions,
        todayIso: new Date().toISOString().slice(0, 10),
      }),
    [recurring, transfers, categorizations, bills, connections, transactions],
  );

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Needs attention
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
        {rows.map((r) => {
          const Icon = ROW_ICONS[r.key];
          return (
            <Link
              key={r.key}
              href={r.href}
              className="group flex items-center gap-3 py-2.5 text-sm transition-colors first:pt-0 last:pb-0 hover:text-foreground"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-semibold tabular-nums">{r.count}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground group-hover:text-foreground">
                {r.label}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
