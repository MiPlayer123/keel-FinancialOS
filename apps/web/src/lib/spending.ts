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
  const add = (name: string, spend: bigint, currency: string) => {
    const entry = totals.get(name) ?? { total: 0n, currency };
    entry.total += spend;
    totals.set(name, entry);
  };
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    if (t.effectiveDate < cutoffIso) continue;
    // Split transactions carry their categories on the splits (categoryKind
    // is null at the top level) — attribute each expense share directly.
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== 'expense') continue;
        const share = BigInt(s.amountMinor || '0');
        if (share <= 0n) continue; // debit-positive: positive = spend
        add(s.name, share, t.currency);
      }
      continue;
    }
    if (t.categoryKind !== 'expense') continue;
    const amount = BigInt(t.amountMinor || '0');
    if (amount >= 0n) continue;
    add(t.categoryName ?? 'Uncategorized', -amount, t.currency);
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
