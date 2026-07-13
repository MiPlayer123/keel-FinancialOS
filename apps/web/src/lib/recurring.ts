import { keelCommand, newId, type RecurringSeriesRow } from '@/lib/keel-api';

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
