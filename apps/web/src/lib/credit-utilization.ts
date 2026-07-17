/**
 * Credit utilization (teardown C9): what share of a provider-reported credit
 * limit is currently used. Display-only, deterministic, and honest about
 * absence — a null limit yields null, and the caller renders nothing (exactly
 * today's UI). Scaled-integer BigInt math throughout (Law 4: no floats near
 * money); the percentage floor-divides, which is fine for a display badge.
 */

/**
 * Integer percent of the limit in use, or null when it can't be stated:
 * missing/unparseable inputs or a non-positive limit. A negative owed amount
 * (credit balance — the bank owes the user) clamps to 0%, and owing more than
 * the limit reads honestly as >100%.
 *
 * @param owedMinor provider-reported current balance for the liability, in
 *   minor units (positive = amount owed, as balance_snapshots stores it).
 * @param limitMinor provider-reported limit in minor units, null when the
 *   institution reports none.
 */
export function utilizationPercent(
  owedMinor: string,
  limitMinor: string | null | undefined,
): number | null {
  if (limitMinor === null || limitMinor === undefined || limitMinor === '') return null;
  let owed: bigint;
  let limit: bigint;
  try {
    owed = BigInt(owedMinor);
    limit = BigInt(limitMinor);
  } catch {
    return null;
  }
  if (limit <= 0n) return null;
  if (owed < 0n) owed = 0n;
  return Number((owed * 100n) / limit);
}
