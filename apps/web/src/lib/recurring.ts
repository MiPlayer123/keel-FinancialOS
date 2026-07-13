import { keelCommand, newId, type RecurringSeriesRow, type ScheduleRow } from '@/lib/keel-api';

/** Valid lifecycle commands per series status (mirrors the SQL state machine). */
export const RECURRING_ACTIONS: Record<
  RecurringSeriesRow['status'],
  { command: RecurringCommand; label: string }[]
> = {
  suggested: [
    { command: 'recurring.confirm', label: 'Confirm' },
    { command: 'recurring.reject', label: 'Dismiss' },
  ],
  confirmed: [
    { command: 'recurring.pause', label: 'Pause' },
    { command: 'recurring.cancel', label: 'Cancel series' },
  ],
  paused: [
    { command: 'recurring.resume', label: 'Resume' },
    { command: 'recurring.cancel', label: 'Cancel series' },
  ],
  cancelled: [],
  rejected: [],
};

export type RecurringCommand =
  | 'recurring.confirm'
  | 'recurring.pause'
  | 'recurring.resume'
  | 'recurring.cancel'
  | 'recurring.reject';

/**
 * Run a recurring lifecycle transition. Payloads are exactly
 * {seriesId, effectiveDate(, horizonDays)} — the contracts schemas are
 * .strict(), so extra keys (e.g. candidateVersionHash) are a 400.
 */
export async function recurringTransition(input: {
  command: RecurringCommand;
  seriesId: string;
  householdId: string;
  userId: string;
}): Promise<unknown> {
  const effectiveDate = new Date().toISOString().slice(0, 10);
  const needsHorizon =
    input.command === 'recurring.confirm' || input.command === 'recurring.resume';
  return keelCommand({
    commandId: newId(),
    command: input.command,
    economicEventKey: `${input.command}:${input.seriesId}:${effectiveDate}`,
    actor: { kind: 'user', userId: input.userId },
    householdId: input.householdId,
    payload: {
      seriesId: input.seriesId,
      effectiveDate,
      ...(needsHorizon ? { horizonDays: 90 } : {}),
    },
  });
}

/** Next expected occurrence on/after today (occurrences may include the past). */
export function nextOccurrence(series: RecurringSeriesRow, todayIso: string) {
  return series.occurrences
    .filter((o) => o.status === 'expected' && o.expectedDate >= todayIso)
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))[0];
}

/**
 * The state machine requires each transition's effective date to be STRICTLY
 * later than the previous one — a second change on the same day is rejected
 * by the server (P0009). Detect it so the UI can explain instead of erroring.
 */
export function changedToday(series: RecurringSeriesRow, todayIso: string): boolean {
  return series.statusEvents.some((e) => e.effectiveDate >= todayIso);
}

/**
 * Days-in-month-safe stepping, anchored to the schedule's declared day of
 * month (mirrors keel_schedule_advance server-side): a bill due Jan 31 steps
 * to Feb 28, then recovers to Mar 31 once the target month is long enough
 * again — instead of Postgres's naive interval addition, which would clamp
 * to the 28th forever. Falls back to the source date's own day when
 * anchorDay is null (legacy rows before the anchor_day backfill).
 */
export function stepScheduleDue(
  dateIso: string,
  frequency: ScheduleRow['frequency'],
  anchorDay: number | null,
): string {
  const [y = 0, m = 0, d = 0] = dateIso.split('-').map(Number);
  const anchor = anchorDay ?? d;
  const addDays = (n: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  };
  const addMonths = (n: number) => {
    const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
    const dt = new Date(Date.UTC(y, m - 1 + n, Math.min(anchor, lastDay)));
    return dt.toISOString().slice(0, 10);
  };
  switch (frequency) {
    case 'weekly':
      return addDays(7);
    case 'biweekly':
      return addDays(14);
    case 'monthly':
      return addMonths(1);
    case 'quarterly':
      return addMonths(3);
    case 'semiannual':
      return addMonths(6);
    case 'annual':
      return addMonths(12);
    case 'once':
      return dateIso;
  }
}
