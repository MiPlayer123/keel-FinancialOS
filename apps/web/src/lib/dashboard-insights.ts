import type { RichTransactionRow } from '@/lib/keel-api';
import { merchantDisplayName } from '@/lib/merchant-name';
import { formatMoney } from '@/lib/money';
import { isDebtOrTransferLike } from '@/lib/spending';

// rawDetail: unabbreviated source string (e.g. the raw bank memo behind a
// cleaned merchant name) — surfaces in the tooltip so the inference never
// hides the source (Law 9; review finding).
export type Insight = {
  label: string;
  value: string;
  detail: string;
  rawDetail?: string;
  /** Deep-link into the ledger for the transactions behind this figure (Law 9:
   *  proof on demand). Omitted when the tile doesn't map to a filterable set. */
  href?: string;
};

/**
 * Deterministic pocket insights from data already on the page (Law 1 — no
 * model anywhere near this). BigInt sums; labels format minor strings.
 *
 * `now` is injectable so the day-of-month arithmetic is deterministically
 * testable (same pattern as report-scope's `presetRange(preset, now)`).
 */
export function buildInsights(rows: RichTransactionRow[], now: Date = new Date()): Insight[] {
  const out: Insight[] = [];
  const today = now;
  const todayIso = today.toISOString().slice(0, 10);
  const month = todayIso.slice(0, 7);
  const dayOfMonth = Number(todayIso.slice(8, 10));
  const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevMonth = prev.toISOString().slice(0, 7);
  // Both spend windows below run start-of-month → this exact day (month-to-date
  // vs same-period-last-month), so a partial month is never compared to a full
  // one. monthStartIso anchors the current-month drill-in range.
  const monthStartIso = `${month}-01`;
  const weekAgo = new Date(today);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoIso = weekAgo.toISOString().slice(0, 10);

  // BigInt sums are only meaningful within one currency; aggregate the
  // household's dominant currency and format with it.
  const currencyCounts = new Map<string, number>();
  for (const t of rows) {
    currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
  }
  const domCurrency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  let biggest: RichTransactionRow | null = null;
  let mtd = 0n;
  let prevToSameDay = 0n;
  const merchants = new Map<string, bigint>();

  for (const t of rows) {
    if (isDebtOrTransferLike(t)) continue;
    if (t.currency !== domCurrency) continue;
    const cash = BigInt(t.amountMinor || '0');
    if (cash >= 0n) continue; // outflows only
    if (t.effectiveDate >= weekAgoIso) {
      if (!biggest || cash < BigInt(biggest.amountMinor)) biggest = t;
    }
    // Month-to-date spend: this month, up to and INCLUDING today. The upper
    // bound (`<= todayIso`) mirrors the prior-month cutoff below so a
    // future-dated row (manual entry, projected/scheduled posting) can never
    // push the current side past the same day-of-month the comparison side
    // stops at — the pace figure compares equal-length windows (founder ask
    // 2026-07-20).
    if (t.effectiveDate.startsWith(month) && t.effectiveDate <= todayIso) {
      mtd += -cash;
      merchants.set(t.description, (merchants.get(t.description) ?? 0n) + -cash);
    }
    if (
      t.effectiveDate.startsWith(prevMonth) &&
      Number(t.effectiveDate.slice(8, 10)) <= dayOfMonth
    ) {
      prevToSameDay += -cash;
    }
  }

  if (biggest) {
    out.push({
      label: 'Biggest purchase · 7 days',
      value: formatMoney(biggest.amountMinor.replace('-', ''), { currency: biggest.currency }),
      detail: merchantDisplayName(biggest.description).slice(0, 40),
      rawDetail: biggest.description,
      href: `/dashboard/ledger?q=${encodeURIComponent(biggest.description)}`,
    });
  }
  if (mtd > 0n && prevToSameDay > 0n) {
    const deltaPct = Number(((mtd - prevToSameDay) * 100n) / prevToSameDay);
    out.push({
      label: 'Spending pace vs last month',
      value: `${deltaPct >= 0 ? '+' : ''}${String(deltaPct)}%`,
      detail: `${formatMoney(mtd.toString(), { currency: domCurrency })} so far vs ${formatMoney(prevToSameDay.toString(), { currency: domCurrency })} by day ${String(dayOfMonth)}`,
      // Drill into exactly the current-month spend behind the left-hand number.
      href: `/dashboard/ledger?from=${monthStartIso}&to=${todayIso}`,
    });
  }
  const rankedMerchants = [...merchants.entries()].sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  );
  // The true top merchant, always — even when it also owns the biggest 7-day
  // purchase. Skipping to rank 2 would mislabel the tile (review finding);
  // with money-movement excluded upstream, an honest overlap is fine.
  const topMerchant = rankedMerchants[0];
  if (topMerchant && topMerchant[1] > 0n) {
    out.push({
      label: 'Top merchant this month',
      value: formatMoney(topMerchant[1].toString(), { currency: domCurrency }),
      // Display-only cleanup; aggregation stays keyed on the raw memo.
      detail: merchantDisplayName(topMerchant[0]).slice(0, 40),
      rawDetail: topMerchant[0],
      href: `/dashboard/ledger?q=${encodeURIComponent(topMerchant[0])}&from=${monthStartIso}&to=${todayIso}`,
    });
  }
  return out;
}
