'use client';

import { useEffect, useState } from 'react';

import { keelQuery, type RecurringSeriesRow, type TransferLinkRow } from '@/lib/keel-api';

/**
 * Pending-review count for the nav (suggested transfers + recurring). Reads
 * the saved household id directly so it works outside HouseholdProvider;
 * silent on any failure — a badge must never break navigation.
 */
export function ReviewBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const householdId = window.localStorage.getItem('keel-household-id');
    if (!householdId) return;
    let active = true;
    void Promise.allSettled([
      keelQuery<RecurringSeriesRow>('recurring.list', householdId),
      keelQuery<TransferLinkRow>('transfers.list', householdId),
    ]).then(([recurring, transfers]) => {
      if (!active) return;
      let n = 0;
      if (recurring.status === 'fulfilled') {
        n += recurring.value.rows.filter((r) => r.status === 'suggested').length;
      }
      if (transfers.status === 'fulfilled') {
        n += transfers.value.rows.filter((t) => t.status === 'suggested').length;
      }
      setCount(n);
    });
    return () => {
      active = false;
    };
  }, []);

  if (count === 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-medium leading-5 text-primary-foreground">
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}
