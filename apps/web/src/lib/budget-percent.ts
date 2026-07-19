/**
 * Budgeting v2 client-side percent helpers (SLICE B3). ONE definition shared by
 * the plan header and the category row so they never drift. `resolvePercentMinor`
 * mirrors keel_budget_month / packages/ledger budget.ts EXACTLY (floor of
 * base × bp / 10000 in BigInt), so the live preview equals what the server stores.
 */

/** floor(base × bp / 10000). base non-negative, bp integer in [0, 10000]. */
export function resolvePercentMinor(baseMinor: bigint, bp: number): bigint {
  return (baseMinor * BigInt(bp)) / 10_000n;
}

/** Basis points (0..10000) to a display percent, e.g. 5000 -> "50", 1250 -> "12.5". */
export function bpToPercentLabel(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  // Trim a trailing zero on the hundredths (1250 bp -> "12.5", not "12.50").
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${String(whole)}.${fracStr}`;
}

/** Parse a percent string ("50", "12.5", "12.75") to integer basis points, or null. */
export function percentToBp(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', frac = ''] = trimmed.split('.');
  const bp = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (bp < 0 || bp > 10_000) return null;
  return bp;
}
