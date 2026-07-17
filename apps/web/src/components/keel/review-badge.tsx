'use client';

import { useEffect, useState } from 'react';

import {
  keelQuery,
  type CategorySuggestionRow,
  type RecurringSeriesRow,
  type TransferLinkRow,
} from '@/lib/keel-api';

/**
 * Pending-review count for the nav (suggested transfers + recurring +
 * categorizations). Reads the saved household id directly so it works outside
 * HouseholdProvider; silent on any failure — a badge must never break
 * navigation.
 *
 * `variant="dot"` (C17 bottom tab bar) renders a small absolutely-positioned
 * corner badge for a square icon button instead of the inline pill the
 * sidebar row uses — same count, same source, different chrome for a
 * different host layout. Default stays exactly the original inline pill so
 * the existing sidebar call site is unaffected.
 */
export function ReviewBadge({ variant = 'inline' }: { variant?: 'inline' | 'dot' }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const householdId = window.localStorage.getItem('keel-household-id');
    if (!householdId) return;
    let active = true;
    void Promise.allSettled([
      keelQuery<RecurringSeriesRow>('recurring.list', householdId),
      keelQuery<TransferLinkRow>('transfers.list', householdId),
      keelQuery<CategorySuggestionRow>('categorization.suggestions', householdId),
    ]).then(([recurring, transfers, categorizations]) => {
      if (!active) return;
      let n = 0;
      if (recurring.status === 'fulfilled') {
        n += recurring.value.rows.filter((r) => r.status === 'suggested').length;
      }
      if (transfers.status === 'fulfilled') {
        n += transfers.value.rows.filter((t) => t.status === 'suggested').length;
      }
      if (categorizations.status === 'fulfilled') {
        n += categorizations.value.rows.filter((c) => c.status === 'suggested').length;
      }
      setCount(n);
    });
    return () => {
      active = false;
    };
  }, []);

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
