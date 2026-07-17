/**
 * Net-worth window math for the fused hero (teardown C11 + C10).
 *
 * All money stays BIGINT minor-unit strings end-to-end (Law 4) — the delta is
 * BigInt subtraction, and the percent label is produced by SCALED INTEGER
 * math (tenths of a percent via `* 1000n` then integer division), never a
 * float. Division truncates toward zero, so the displayed one-decimal figure
 * is the exact leading digits of the true ratio — no rounding step exists to
 * get wrong. No ledger arithmetic happens here beyond subtraction of two
 * points of the same deterministic series (Law 1: this is display math over
 * read-model output, not posting math).
 */

export type TrendPoint = { date: string; balanceMinor: string };

/** A selectable window over the fetched daily series. */
export type TrendRange = { key: string; label: string; windowLabel: string; days: number };

/** Ranges the hero offers. Longest must stay ≤ the fetched window AND ≤ the
 * server's 366-day span cap (`keel_net_worth_daily` raises on longer). */
export const TREND_RANGES: readonly TrendRange[] = [
  { key: '30d', label: '30d', windowLabel: 'past 30 days', days: 30 },
  { key: '90d', label: '90d', windowLabel: 'past 90 days', days: 90 },
  { key: '1y', label: '1y', windowLabel: 'past year', days: 365 },
] as const;

/** How many days of series to request (server cap is 366-day span). */
export const TREND_FETCH_DAYS = 365;

function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * The trailing `days`-day slice of an ascending daily series, anchored on the
 * LAST point's date (the series' own "today"), inclusive of the boundary day.
 * Subsetting client-side from one long fetch — never a second guess at data.
 */
export function sliceWindow<T extends TrendPoint>(points: T[], days: number): T[] {
  const last = points[points.length - 1];
  if (!last) return [];
  const cutoff = shiftIsoDate(last.date, -days);
  return points.filter((p) => p.date >= cutoff);
}

/**
 * Days of REAL history in the series: the stretch from the first point whose
 * balance is nonzero through the end. `keel_net_worth_daily` zero-pads days
 * before the household's first posting, so a leading run of "0" balances is
 * "no data yet", not "net worth was genuinely zero" — a range pill whose
 * window is mostly padding would fabricate growth from 0 (teardown C10:
 * never invent data; disable instead).
 *
 * A series that starts nonzero means history extends at least as far back as
 * the fetch itself, so the whole fetched window counts.
 */
export function availableHistoryDays(points: TrendPoint[]): number {
  const first = points.findIndex((p) => BigInt(p.balanceMinor || '0') !== 0n);
  if (first === -1) return 0;
  return points.length - first;
}

export type WindowDelta = {
  /** Balance at the window start (minor units, signed decimal string). */
  firstMinor: string;
  /** Balance at the window end — the hero's headline number. */
  lastMinor: string;
  /** last − first, BigInt, as a signed decimal string. */
  deltaMinor: string;
  /** One-decimal percent label ("+4.2%", "−0.3%", "0.0%"); null when the
   *  baseline is zero (percent-of-nothing is meaningless, not infinite). */
  pctLabel: string | null;
};

/**
 * Percent-change label at one-decimal precision from pure integer math:
 * tenths = (Δ × 1000) ÷ |base|, truncated toward zero by BigInt division.
 * Sign comes from Δ itself so "−0.04%" renders as "−0.0%", not "+0.0%".
 * Uses U+2212 minus to match `formatMoney`.
 */
export function percentDeltaLabel(deltaMinor: bigint, baseMinor: bigint): string | null {
  if (baseMinor === 0n) return null;
  if (deltaMinor === 0n) return '0.0%';
  const base = baseMinor < 0n ? -baseMinor : baseMinor;
  const tenths = (deltaMinor * 1000n) / base;
  const abs = tenths < 0n ? -tenths : tenths;
  const sign = deltaMinor < 0n ? '−' : '+';
  return `${sign}${(abs / 10n).toString()}.${(abs % 10n).toString()}%`;
}

/** Δ and % between the first and last points of a window; null under 2 points. */
export function computeWindowDelta(points: TrendPoint[]): WindowDelta | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return null;
  const firstBig = BigInt(first.balanceMinor || '0');
  const lastBig = BigInt(last.balanceMinor || '0');
  const delta = lastBig - firstBig;
  return {
    firstMinor: first.balanceMinor,
    lastMinor: last.balanceMinor,
    deltaMinor: delta.toString(),
    pctLabel: percentDeltaLabel(delta, firstBig),
  };
}
