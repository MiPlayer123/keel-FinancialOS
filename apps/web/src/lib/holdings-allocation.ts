import type { CategorySpend } from '@/components/keel/charts';
import type { HoldingRow } from '@/lib/keel-api';

/**
 * Coarse-buckets Plaid's finer-grained security type into the four groups
 * the plan calls for (S-inv-1c, docs/harness/plans/investments-v1.md):
 * equity, fixed income, cash, other. Bucketing lives here (read time), not
 * in storage, so the policy can be refined without a migration. Manual
 * holdings (securityType always null) and any type this doesn't recognize
 * fall into "Unclassified" rather than being silently mis-bucketed.
 */
function bucketFor(securityType: string | null): string {
  switch (securityType) {
    case 'equity':
    case 'etf':
    case 'mutual fund':
      return 'Equity';
    case 'fixed income':
      return 'Fixed income';
    case 'cash':
      return 'Cash';
    case 'cryptocurrency':
    case 'derivative':
    case 'loan':
    case 'other':
      return 'Other';
    default:
      return 'Unclassified';
  }
}

/**
 * Sums holding values into coarse asset-class buckets, largest first, for
 * a household-wide (or account-scoped, if pre-filtered) allocation view.
 * Reuses CategoryBarList's existing shape — no new chart component.
 *
 * USD-only, matching the convention `mapAccountsGetToKeel`/
 * `mapHoldingsGetToKeel` already use: summing bars across currencies
 * without conversion would produce a number that LOOKS right but isn't
 * (a €100 and a $100 holding are not the same size). Non-USD holdings are
 * dropped rather than silently mixed in — full multi-currency allocation
 * is a bigger feature than this slice.
 */
export function allocationMix(rows: HoldingRow[]): CategorySpend[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (row.currency !== 'USD') continue;
    const bucket = bucketFor(row.securityType);
    totals.set(bucket, (totals.get(bucket) ?? 0n) + BigInt(row.valueMinor || '0'));
  }
  return [...totals.entries()]
    .filter(([, totalMinor]) => totalMinor > 0n)
    .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
    .map(([name, totalMinor]) => ({ name, totalMinor: totalMinor.toString(), currency: 'USD' }));
}
