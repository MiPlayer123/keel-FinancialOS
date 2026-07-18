'use client';

import { useEffect, useState } from 'react';

import { useKeelQuery } from '@/lib/use-keel-query';
import type {
  CategorySuggestionRow,
  RecurringSeriesRow,
  TransferLinkRow,
} from '@/lib/keel-api';

/**
 * Pending-review count for the nav (suggested transfers + recurring +
 * categorizations). Reads the saved household id directly so it works outside
 * HouseholdProvider; silent on any failure — a badge must never break
 * navigation (`useKeelQuery` degrades to empty rows on error).
 *
 * F-004: the three reads share the Review page's react-query cache keys
 * (['keel-query', <query>, householdId]), so a decision on Review — the
 * optimistic removal and the post-decision invalidation both write that same
 * cache — moves this count in lockstep instead of leaving a stale
 * fetch-once snapshot. The badge never triggers detection; that stays an
 * explicit Review-page-mount concern.
 *
 * `variant="dot"` (C17 bottom tab bar) renders a small absolutely-positioned
 * corner badge for a square icon button instead of the inline pill the
 * sidebar row uses — same count, same source, different chrome for a
 * different host layout. Default stays exactly the original inline pill so
 * the existing sidebar call site is unaffected.
 */
function countSuggested(rows: { status: string }[]): number {
  return rows.filter((r) => r.status === 'suggested').length;
}

export function ReviewBadge({ variant = 'inline' }: { variant?: 'inline' | 'dot' }) {
  // localStorage is browser-only; read it post-mount so SSR renders nothing.
  const [householdId, setHouseholdId] = useState<string | null>(null);
  useEffect(() => {
    setHouseholdId(window.localStorage.getItem('keel-household-id'));
  }, []);

  const recurring = useKeelQuery<RecurringSeriesRow>('recurring.list', householdId);
  const transfers = useKeelQuery<TransferLinkRow>('transfers.list', householdId);
  const categorizations = useKeelQuery<CategorySuggestionRow>(
    'categorization.suggestions',
    householdId,
  );
  const count =
    countSuggested(recurring.rows) +
    countSuggested(transfers.rows) +
    countSuggested(categorizations.rows);

  if (count === 0) return null;
  if (variant === 'dot') {
    return (
      <span className="absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-4 text-primary-foreground">
        {count > 9 ? '9+' : String(count)}
      </span>
    );
  }
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium leading-5 text-primary-foreground">
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}
