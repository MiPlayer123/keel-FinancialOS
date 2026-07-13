import type { RichTransactionRow } from '@/lib/keel-api';
import type { CategorySpend } from '@/components/keel/charts';

/**
 * Expense totals by category over the trailing N days. Confirmed transfers
 * are excluded (moving money isn't spending); BigInt sums (Law 4); top 6 +
 * Other so the list never sprawls.
 */
export function spendingMix(rows: RichTransactionRow[], days = 30): CategorySpend[] {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const totals = new Map<string, { total: bigint; currency: string }>();
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    if (t.categoryKind !== 'expense') continue;
    if (t.effectiveDate < cutoffIso) continue;
    const amount = BigInt(t.amountMinor || '0');
    if (amount >= 0n) continue;
    const key = t.categoryName ?? 'Uncategorized';
    const entry = totals.get(key) ?? { total: 0n, currency: t.currency };
    entry.total += -amount;
    totals.set(key, entry);
  }

  const sorted = [...totals.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1));
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const items: CategorySpend[] = top.map(([name, v]) => ({
    name,
    totalMinor: v.total.toString(),
    currency: v.currency,
  }));
  if (rest.length > 0) {
    const otherTotal = rest.reduce((acc, [, v]) => acc + v.total, 0n);
    items.push({
      name: 'Other',
      totalMinor: otherTotal.toString(),
      currency: rest[0]?.[1].currency ?? 'USD',
    });
  }
  return items;
}
