/**
 * Client-side preview of a holding's value, mirroring the server's exact
 * decimal arithmetic (Law 4: no floats) — `keel_holding_upsert` computes
 * value_minor itself with Postgres `numeric` math and never trusts this
 * number for storage; this is display-only, so a preview and the saved
 * value never silently disagree.
 */

/** Parses a decimal quantity string ("1.5", "0.001") into a scaled BigInt
 *  numerator and its decimal-place count, or null if not a valid positive
 *  decimal with at most 8 fractional digits (sane bound for fractional
 *  shares). */
function parseDecimal(input: string): { scaled: bigint; scale: number } | null {
  const cleaned = input.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  const scale = frac.length;
  const scaled = BigInt(whole + frac);
  if (scaled <= 0n) return null;
  return { scaled, scale };
}

/**
 * value_minor = round(qty × price_minor), computed in exact integer
 * arithmetic. Returns null when either input isn't a valid positive
 * decimal / non-negative integer string, matching the server's validation.
 */
export function computeHoldingValueMinor(qty: string, priceMinor: string): string | null {
  const q = parseDecimal(qty);
  if (!q) return null;
  const cleanedPrice = priceMinor.trim();
  if (!/^\d+$/.test(cleanedPrice)) return null;
  const price = BigInt(cleanedPrice);
  const divisor = 10n ** BigInt(q.scale);
  const numerator = q.scaled * price;
  // Round half up — same convention as the rest of the app's decimal↔minor
  // conversions (e.g. dollarsToMinorString in add-account-dialog.tsx).
  const value = (numerator + divisor / 2n) / divisor;
  return value.toString();
}
