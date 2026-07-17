/**
 * Deterministic display evidence for Review-page suggestions (Law 11: reason
 * codes + evidence refs on every material suggestion; TLDR first, proof on
 * demand). Detection is rule-based, so there is deliberately NO confidence
 * percentage here — presenting one would dress inference up as calibration
 * (Law 9: explicit ownership).
 *
 * Everything in this file is calendar/date arithmetic and string comparison.
 * No ledger arithmetic, no money math, no floats touching amounts (Law 1/4);
 * amounts stay opaque minor-unit strings compared for equality via BigInt.
 */

const DAY_MS = 86_400_000;

/** Parse an ISO `YYYY-MM-DD` date as a UTC timestamp, or null if invalid. */
function parseIsoDateUtc(date: string): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Whole-day gaps between consecutive dates (ISO `YYYY-MM-DD`), order-insensitive.
 * Invalid dates are dropped rather than poisoning the series.
 */
export function dayGapsBetween(dates: readonly string[]): number[] {
  const times = dates
    .map(parseIsoDateUtc)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1];
    const curr = times[i];
    if (prev !== undefined && curr !== undefined) {
      // Both timestamps are UTC midnights, so this divides exactly — no
      // rounding needed (and the repo lint bans Math.round outright).
      gaps.push((curr - prev) / DAY_MS);
    }
  }
  return gaps;
}

/**
 * Median of a numeric list, or null when empty. For even counts this takes
 * the LOWER of the two middles (not their mean): inputs are integer day-gaps
 * and the result only feeds banded labels, so keeping integer arithmetic
 * beats a fractional midpoint that would need rounding.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid =
    sorted.length % 2 === 1 ? (sorted.length - 1) / 2 : sorted.length / 2 - 1;
  return sorted[mid] ?? null;
}

/**
 * Human cadence label inferred from the median day-gap between consecutive
 * expected dates. Bands: 7±2 weekly · 14±3 every 2 weeks · 28–31±5 monthly ·
 * 84–98 quarterly · otherwise "~every N days". Needs ≥2 valid dates.
 */
export function cadenceLabel(expectedDates: readonly string[]): string | null {
  // Duplicate dates produce zero gaps that drag the median to 0 and erase an
  // obvious cadence (review finding) — a same-day double charge is still the
  // same series. Zero gaps carry no cadence signal; drop them.
  const gaps = dayGapsBetween(expectedDates).filter((g) => g > 0);
  const gap = median(gaps);
  if (gap === null || gap < 1) return null;
  if (gap === 1) return 'daily';
  if (gap >= 5 && gap <= 9) return 'weekly';
  if (gap >= 11 && gap <= 17) return 'every 2 weeks';
  if (gap >= 23 && gap <= 36) return 'monthly';
  if (gap >= 84 && gap <= 98) return 'quarterly';
  return `~every ${String(gap)} days`;
}

/**
 * True when every expected amount (signed decimal minor-unit string) is the
 * same economic value. BigInt equality only — never parsed as a float.
 */
export function amountsConsistent(amountsMinor: readonly string[]): boolean {
  const first = amountsMinor[0];
  if (first === undefined) return true;
  // BigInt('') and BigInt('  ') are 0n, so shape-validate BEFORE converting —
  // otherwise ['', '0'] would "prove" consistency (review finding).
  if (!amountsMinor.every((a) => /^-?\d+$/.test(a))) return false;
  const ref = BigInt(first);
  return amountsMinor.every((a) => BigInt(a) === ref);
}

/**
 * Reason-code line for a recurring-series suggestion, e.g.
 * "Repeating outflow · projected monthly · consistent projected amount".
 *
 * The inputs are the detector's PROJECTED occurrences (the contract does not
 * expose the observed source transactions here), so the wording must say
 * "projected" — otherwise the line restates the detector's conclusion dressed
 * as observed history (Law 9: inference is never presented as fact; review
 * finding).
 */
export function recurringReasonLine(input: {
  sign: 'inflow' | 'outflow';
  expectedDates: readonly string[];
  amountsMinor: readonly string[];
}): string {
  const parts = [`Repeating ${input.sign}`];
  const cadence = cadenceLabel(input.expectedDates);
  if (cadence) parts.push(`projected ${cadence}`);
  if (input.amountsMinor.length > 0) {
    parts.push(
      amountsConsistent(input.amountsMinor)
        ? 'consistent projected amount'
        : 'varying projected amounts',
    );
  }
  return parts.join(' · ');
}

/**
 * Reason-code line for a transfer suggestion, e.g.
 * "Same amount · opposite directions · same day" or "… · 2 days apart".
 */
export function transferReasonLine(dayGap: number): string {
  const timing =
    dayGap === 0
      ? 'same day'
      : `${String(dayGap)} day${dayGap === 1 ? '' : 's'} apart`;
  return `Same amount · opposite directions · ${timing}`;
}
