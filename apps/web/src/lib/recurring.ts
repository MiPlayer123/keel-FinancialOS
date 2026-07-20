import {
  keelCommand,
  newId,
  type RecurringOccurrence,
  type RecurringSeriesRow,
  type ScheduleRow,
} from '@/lib/keel-api';
import { dayGapsBetween } from '@/lib/recurring-evidence';

/**
 * Valid lifecycle commands per series status (mirrors the SQL state
 * machine). Labels read "Stop tracking" rather than "Cancel": `recurring.
 * cancel` only stops KEEL from tracking/forecasting a series — it never
 * touches the real-world subscription or bill (KEEL has no concierge /
 * act-on-your-behalf capability here; money movement and provider-directed
 * actions stay Class D, disabled — Law 10). "Cancel series" reads as KEEL
 * cancelling the subscription for you, which it cannot do — a copy
 * contradiction flagged by the teardown (design/COMPETITIVE-TEARDOWN-
 * 2026-07-16.md: "'cancel' verb collides with Rocket's concierge meaning —
 * rename 'Stop tracking'"; design/TEARDOWN-STATUS-2026-07-17.md tension #3).
 * Only the display label changes here — the `recurring.cancel` command/enum
 * value and state-machine transition are untouched.
 */
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
    { command: 'recurring.cancel', label: 'Stop tracking' },
  ],
  paused: [
    { command: 'recurring.resume', label: 'Resume' },
    { command: 'recurring.cancel', label: 'Stop tracking' },
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
 *
 * Semi-monthly ('semimonthly') carries TWO anchor days (anchorDay <
 * anchorDay2, normalized at save time — default 15th & 30th). Stepping targets
 * the NEXT of the two: this month's LARGER anchor when we're strictly before
 * it (clamped to month length), else next month's SMALLER anchor. The same
 * Math.min(anchor, lastDay) clamp the monthly branch uses means a "30th"
 * anchor lands on Feb 28/29 and recovers to Mar 30 (Jan 15/30 -> Feb 15/28 ->
 * Mar 15/30). MUST stay in lockstep with the SQL keel_schedule_advance
 * semimonthly branch.
 */
export function stepScheduleDue(
  dateIso: string,
  frequency: ScheduleRow['frequency'],
  anchorDay: number | null,
  anchorDay2: number | null = null,
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
  // Day-of-month `dayOfMonth`, clamped to `monthOffset` months from the source
  // month's start, as an ISO date string.
  const dayInMonth = (monthOffset: number, dayOfMonth: number) => {
    const lastDay = new Date(Date.UTC(y, m - 1 + monthOffset + 1, 0)).getUTCDate();
    const dt = new Date(Date.UTC(y, m - 1 + monthOffset, Math.min(dayOfMonth, lastDay)));
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
    case 'semimonthly': {
      const a1 = Math.min(anchorDay ?? d, anchorDay2 ?? d);
      const a2 = Math.max(anchorDay ?? d, anchorDay2 ?? d);
      const thisLarger = dayInMonth(0, a2);
      // Strictly before this month's larger anchor -> that's next; else roll to
      // next month's smaller anchor. Compares clamped dates, so a 30-anchor
      // sitting on Feb 28 counts as "at" its larger anchor and rolls forward.
      return dateIso < thisLarger ? thisLarger : dayInMonth(1, a1);
    }
    case 'once':
      return dateIso;
  }
}

// ---------------------------------------------------------------------------
// Annualized $/yr estimate (teardown C13: "$X/mo · ~$Y/yr" per series).
//
// This is a DISPLAY figure, not a ledger number — it never touches posted
// amounts, only the series' own PROJECTED occurrences (mirrors the honesty
// rule already applied to recurringReasonLine in recurring-evidence.ts: the
// contract exposes projected occurrences, never observed history, so the
// wording and the confidence bar both have to match that). Cadence is
// inferred independently from the fuzzy, display-only `cadenceLabel` in
// recurring-evidence.ts (which intentionally has wide bands and a
// "~every N days" catch-all for descriptive text): annualizing multiplies a
// REAL dollar figure out to a year, so this uses narrower bands and refuses
// (returns null) rather than guess a multiplier for anything that doesn't
// land confidently on weekly/biweekly/monthly/annual — Law 9 (reproducible
// numbers) says a number with no confident basis must not be shown at all,
// not shown with invented provenance.
// ---------------------------------------------------------------------------

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'annual';

/** Occurrences-per-year multiplier for each supported cadence. */
const CADENCE_MULTIPLIER: Record<RecurringCadence, bigint> = {
  weekly: 52n,
  biweekly: 26n,
  monthly: 12n,
  annual: 1n,
};

/** Short unit suffix for the per-occurrence figure, e.g. "$45.00" + "/mo". */
export const CADENCE_SUFFIX: Record<RecurringCadence, string> = {
  weekly: '/wk',
  biweekly: '/2wk',
  monthly: '/mo',
  annual: '/yr',
};

/** Inclusive [min, max] whole-day-gap window each supported cadence accepts. */
const CADENCE_BANDS: [RecurringCadence, number, number][] = [
  ['weekly', 6, 8],
  ['biweekly', 13, 15],
  // Covers every calendar month length (28–31) plus a one-day weekend/holiday
  // posting shift either side.
  ['monthly', 27, 31],
  // Covers 365 (common year) and 366 (leap year), plus a few days of
  // anchor-day drift.
  ['annual', 360, 372],
];

function bandFor(gapDays: number): RecurringCadence | null {
  for (const [cadence, min, max] of CADENCE_BANDS) {
    if (gapDays >= min && gapDays <= max) return cadence;
  }
  return null;
}

/**
 * Infers a strict billing cadence from the whole-day gaps between
 * consecutive expected dates. Unlike the fuzzy, display-only `cadenceLabel`
 * in recurring-evidence.ts (which takes the MEDIAN gap so one skipped or
 * doubled occurrence can't flip a purely descriptive label), this feeds an
 * annualization MULTIPLIER applied to a real dollar figure — a higher bar
 * than descriptive text, so EVERY individual gap must independently land in
 * the same band, not just the median. One outlier gap (an irregular series,
 * a detector artifact, a skipped/doubled occurrence) degrades the whole
 * series to null rather than silently picking the majority cadence — Law 9
 * (reproducible numbers / explicit ownership): a number with no confident
 * basis must not be shown at all, never shown with invented provenance.
 * Fewer than two dated occurrences (no gap to measure) also returns null.
 */
export function inferCadence(expectedDates: readonly string[]): RecurringCadence | null {
  const gaps = dayGapsBetween(expectedDates).filter((g) => g > 0);
  if (gaps.length === 0) return null;
  const bands = gaps.map(bandFor);
  const first = bands[0] ?? null;
  if (first === null) return null;
  return bands.every((b) => b === first) ? first : null;
}

/**
 * Multiplies a single occurrence's minor-unit amount out to an annual total.
 * Pure BigInt — no floats touch the figure (Law 4). `amountMinor` is a
 * SIGNED decimal integer string (real outflow occurrences — rent, bills,
 * subscriptions — are stored negative, same convention `<Money>` already
 * renders for `estimate.amountMinor`; review r3604386188 caught an
 * unsigned-only guard here that silently dropped every real outflow
 * series). The sign passes straight through the multiplication so the
 * annualized figure keeps the same direction (and red/neutral rendering)
 * as the per-occurrence amount; malformed input throws rather than
 * silently coercing to 0 (mirrors the validate-before-BigInt rule in
 * `amountsConsistent`).
 */
export function annualizedMinor(amountMinor: string, cadence: RecurringCadence): bigint {
  if (!/^-?\d+$/.test(amountMinor)) {
    throw new Error(`annualizedMinor: not a signed integer string: ${amountMinor}`);
  }
  return BigInt(amountMinor) * CADENCE_MULTIPLIER[cadence];
}

export type RecurringAnnualEstimate = {
  cadence: RecurringCadence;
  /** The representative (most recent) occurrence's own signed amount. */
  amountMinor: string;
  currency: string;
  /** amountMinor × the cadence's occurrences-per-year, as an unsigned BigInt. */
  annualMinor: bigint;
};

/**
 * Full annualized estimate for a recurring series, or null when the cadence
 * can't be confidently inferred (single occurrence, irregular gaps, or a
 * cadence outside weekly/biweekly/monthly/annual) — never a fabricated
 * number (Law 9: explicit ownership + reproducible numbers). Uses the
 * chronologically LATEST occurrence's amount as the representative figure
 * (a price change should show the new price, not an average across history)
 * and its currency; malformed amount strings degrade to null rather than
 * throwing, since this is a passive display helper, not a validating write
 * path.
 */
export function annualizedEstimate(
  occurrences: readonly Pick<RecurringOccurrence, 'expectedDate' | 'expectedAmountMinor' | 'currency'>[],
): RecurringAnnualEstimate | null {
  if (occurrences.length === 0) return null;
  const cadence = inferCadence(occurrences.map((o) => o.expectedDate));
  if (cadence === null) return null;
  const latest = [...occurrences].sort((a, b) => a.expectedDate.localeCompare(b.expectedDate)).at(-1);
  if (!latest || !/^-?\d+$/.test(latest.expectedAmountMinor)) return null;
  return {
    cadence,
    amountMinor: latest.expectedAmountMinor,
    currency: latest.currency,
    annualMinor: annualizedMinor(latest.expectedAmountMinor, cadence),
  };
}
