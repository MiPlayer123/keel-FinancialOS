import type { RichTransactionRow } from '@/lib/keel-api';
import { isDebtOrTransferLike } from '@/lib/spending';

/**
 * "Where do I stand this month": month-to-date spending and income vs the SAME
 * day-of-month last month (Copilot's same-point comparison — comparing a
 * partial month to a full one fakes a "way under" reading early on).
 *
 * Spending semantics match Reports (net of refunds, split-aware, transfers &
 * debt payments excluded, account-transfer legs skipped). Pure BigInt; the
 * dominant currency only.
 */
export type PacePoint = {
  day: number;
  /** Cumulative spend through `day` this month; null for days not reached yet. */
  thisMinor: string | null;
  /** Cumulative spend through `day` last month; null past last month's length. */
  lastMinor: string | null;
};

export type MonthPace = {
  currency: string;
  month: string;
  prevMonth: string;
  dayOfMonth: number;
  spentMinor: bigint;
  incomeMinor: bigint;
  /** Last month, days 1..dayOfMonth (clamped to its length). */
  prevSpentToDateMinor: bigint;
  prevIncomeToDateMinor: bigint;
  prevSpentTotalMinor: bigint;
  prevIncomeTotalMinor: bigint;
  series: PacePoint[];
  /** Newest effective date among countable rows (any month), for empty states. */
  lastActivityDate: string | null;
};

type Bucket = { spend: bigint; income: bigint };

function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
}

function prevMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1)).toISOString().slice(0, 7);
}

/** Spend/income contribution of one row (0/0 when it doesn't count). */
function contribution(t: RichTransactionRow): Bucket {
  let spend = 0n;
  let income = 0n;
  if (t.splits && t.splits.length > 0) {
    for (const s of t.splits) {
      if (s.legType === 'account' || s.categoryLedgerAccountId === null) continue;
      const share = BigInt(s.amountMinor || '0');
      if (s.kind === 'expense') spend += share;
      else if (s.kind === 'income') income += -share;
    }
    return { spend, income };
  }
  const cash = BigInt(t.amountMinor || '0');
  if (t.categoryKind === 'expense') spend = -cash;
  else if (t.categoryKind === 'income') income = cash;
  return { spend, income };
}

export function monthPace(rows: RichTransactionRow[], todayIso: string): MonthPace {
  const month = todayIso.slice(0, 7);
  const prevMonth = prevMonthOf(month);
  const dayOfMonth = Number(todayIso.slice(8, 10));
  const prevDays = daysIn(prevMonth);
  const prevCutoff = Math.min(dayOfMonth, prevDays);

  const counted = rows.filter((t) => !isDebtOrTransferLike(t));
  const votes = new Map<string, number>();
  for (const t of counted) votes.set(t.currency, (votes.get(t.currency) ?? 0) + 1);
  const currency = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';

  const thisDaily = new Map<number, Bucket>();
  const prevDaily = new Map<number, Bucket>();
  let lastActivityDate: string | null = null;
  for (const t of counted) {
    if (t.currency !== currency) continue;
    if (t.effectiveDate > todayIso) continue;
    if (lastActivityDate === null || t.effectiveDate > lastActivityDate) {
      lastActivityDate = t.effectiveDate;
    }
    const key = t.effectiveDate.slice(0, 7);
    const target = key === month ? thisDaily : key === prevMonth ? prevDaily : null;
    if (!target) continue;
    const day = Number(t.effectiveDate.slice(8, 10));
    const c = contribution(t);
    const b = target.get(day) ?? { spend: 0n, income: 0n };
    b.spend += c.spend;
    b.income += c.income;
    target.set(day, b);
  }

  let spentMinor = 0n;
  let incomeMinor = 0n;
  let prevSpentToDateMinor = 0n;
  let prevIncomeToDateMinor = 0n;
  let prevSpentTotalMinor = 0n;
  let prevIncomeTotalMinor = 0n;
  let thisCum = 0n;
  let lastCum = 0n;
  const series: PacePoint[] = [];
  const span = Math.max(daysIn(month), prevDays);
  for (let day = 1; day <= span; day += 1) {
    const tb = thisDaily.get(day);
    const pb = prevDaily.get(day);
    if (day <= dayOfMonth && tb) {
      thisCum += tb.spend;
      spentMinor += tb.spend;
      incomeMinor += tb.income;
    }
    if (day <= prevDays && pb) {
      lastCum += pb.spend;
      prevSpentTotalMinor += pb.spend;
      prevIncomeTotalMinor += pb.income;
      if (day <= prevCutoff) {
        prevSpentToDateMinor += pb.spend;
        prevIncomeToDateMinor += pb.income;
      }
    }
    series.push({
      day,
      thisMinor: day <= dayOfMonth ? thisCum.toString() : null,
      lastMinor: day <= prevDays ? lastCum.toString() : null,
    });
  }

  return {
    currency,
    month,
    prevMonth,
    dayOfMonth,
    spentMinor,
    incomeMinor,
    prevSpentToDateMinor,
    prevIncomeToDateMinor,
    prevSpentTotalMinor,
    prevIncomeTotalMinor,
    series,
    lastActivityDate,
  };
}
