'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { InfoNote } from '@/components/keel/info-note';
import { Money } from '@/components/keel/money';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  budgetLines,
  budgetTotals,
  daysLeftInMonth,
  monthPacePct,
  overBudgetLines,
  usedPct,
  type BudgetLine,
} from '@/lib/budget-progress';
import { fetchBudgetMonth, type BudgetMonth } from '@/lib/keel-api';
import { cn } from '@/lib/utils';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthName(monthIso: string, long = false): string {
  const name = MONTHS[Number(monthIso.slice(5, 7)) - 1] ?? monthIso;
  return long ? `${name} ${monthIso.slice(0, 4)}` : name;
}

/**
 * Budget progress bar. Only an over-budget line changes: it fills completely
 * in strong ink (not red — over budget is not negative money, Law 8). The
 * optional tick marks today's point in the month.
 */
export function BudgetBar({
  spentMinor,
  availableMinor,
  pacePct,
}: {
  spentMinor: bigint;
  availableMinor: bigint;
  pacePct?: number | undefined;
}) {
  const over = spentMinor > availableMinor;
  const pct = over ? 100 : Math.min(100, usedPct(spentMinor, availableMinor));
  return (
    <div className="relative h-1.5 w-full rounded-full bg-secondary">
      <div
        className={cn('absolute inset-y-0 left-0 rounded-full', over ? 'bg-foreground' : 'bg-primary')}
        style={{ width: `${String(spentMinor > 0n ? Math.max(pct, 2) : 0)}%` }}
      />
      {pacePct !== undefined && pacePct > 0 && pacePct < 100 ? (
        <span
          aria-hidden
          className="absolute -inset-y-1 w-0.5 rounded bg-foreground/40"
          style={{ left: `${String(pacePct)}%` }}
        />
      ) : null}
    </div>
  );
}

/** "$449 over" / "$35 left" — the over line reads in strong ink, the rest muted. */
function RemainingText({ line, past }: { line: BudgetLine; past: boolean }) {
  const r = line.remainingMinor;
  if (r < 0n) {
    return (
      <span className="font-medium text-foreground">
        <Money amountMinor={(-r).toString()} currency={line.row.currency} className="text-xs text-foreground" /> over
      </span>
    );
  }
  return (
    <span>
      <Money amountMinor={r.toString()} currency={line.row.currency} className="text-xs" /> {past ? 'under' : 'left'}
    </span>
  );
}

const STATUS_LABEL = {
  over: 'Over budget',
  ahead: 'Ahead of pace',
  on_track: 'On track',
  not_started: 'Nothing spent yet',
} as const;

// ---------------------------------------------------------------------------
// Home: the simple card
// ---------------------------------------------------------------------------

/**
 * Home Budget card: one line, one overall bar with the pace tick, and only the
 * categories that are over. The full picture lives on Reports and Budgets.
 */
export function HomeBudgetCard({ plan, todayIso }: { plan: BudgetMonth; todayIso: string }) {
  const monthIso = `${plan.scope.month}-01`;
  const totals = budgetTotals(plan.rows);
  const pace = monthPacePct(monthIso, todayIso);
  const daysLeft = daysLeftInMonth(monthIso, todayIso);
  const overs = overBudgetLines(plan.rows);
  const currency = plan.rows[0]?.currency ?? 'USD';
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          Budget · {monthName(monthIso)}
          <InfoNote>
            <p>Spending in your budgeted categories this month. A parent includes its subcategories that don&apos;t have their own budget.</p>
            <p>The tick marks today&apos;s point in the month. Unbudgeted spending isn&apos;t included.</p>
          </InfoNote>
        </CardTitle>
        <CardAction>
          <Link href="/dashboard/budgets" className={buttonVariants({ variant: 'ghost', size: 'xs' })}>
            View budget
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
          <Money amountMinor={totals.spentMinor.toString()} currency={currency} className="text-lg font-semibold" />
          <span className="text-muted-foreground">
            of <Money amountMinor={totals.budgetedMinor.toString()} currency={currency} className="text-muted-foreground" /> budgeted
            {daysLeft > 0 ? ` · ${String(daysLeft)} day${daysLeft === 1 ? '' : 's'} left` : ''}
          </span>
        </p>
        <BudgetBar spentMinor={totals.spentMinor} availableMinor={totals.budgetedMinor} pacePct={pace} />
        {overs.length === 0 ? (
          <p className="text-sm text-muted-foreground">All {totals.categoryCount} categories on track.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {overs.map((l) => (
              <div key={l.row.categoryLedgerAccountId} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{l.row.categoryName}</span>
                <span className="shrink-0 text-xs">
                  <RemainingText line={l} past={false} />
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reports: Budget vs actual
// ---------------------------------------------------------------------------

function CategoryLine({
  line,
  child,
  pacePct,
  past,
}: {
  line: BudgetLine;
  child: boolean;
  pacePct: number | undefined;
  past: boolean;
}) {
  const rolled = line.row.rolledUpCategoryNames ?? [];
  const showGroup =
    line.children.length > 0 &&
    line.row.groupResolvedMinor != null &&
    line.row.groupSpentMinor != null &&
    (line.row.groupResolvedMinor !== line.row.resolvedMinor || line.row.groupSpentMinor !== line.row.spentMinor);
  const notes: string[] = [];
  if (rolled.length > 0) notes.push(`Includes ${rolled.join(', ')}`);
  return (
    <div className={cn('flex flex-col gap-1.5 py-2.5', child && 'pl-5')}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{line.row.categoryName}</span>
        <span className="shrink-0 font-mono tabular-nums">
          <Money amountMinor={line.spentMinor.toString()} currency={line.row.currency} className="text-sm" />
          <span className="text-muted-foreground">
            {' '}
            of <Money amountMinor={line.availableMinor.toString()} currency={line.row.currency} className="text-sm text-muted-foreground" />
          </span>
        </span>
      </div>
      <BudgetBar spentMinor={line.spentMinor} availableMinor={line.availableMinor} pacePct={pacePct} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <span className="min-w-0">
          {[...notes, past ? null : line.status === 'over' ? null : STATUS_LABEL[line.status]]
            .filter(Boolean)
            .join(' · ')}
          {showGroup && line.row.groupSpentMinor != null && line.row.groupResolvedMinor != null ? (
            <>
              {notes.length > 0 || !past ? ' · ' : ''}overall{' '}
              <Money amountMinor={line.row.groupSpentMinor} currency={line.row.currency} className="text-xs" /> of{' '}
              <Money amountMinor={line.row.groupResolvedMinor} currency={line.row.currency} className="text-xs" />
            </>
          ) : null}
        </span>
        <span className="shrink-0">
          <RemainingText line={line} past={past} />
        </span>
      </div>
    </div>
  );
}

function MonthView({ plan, todayIso }: { plan: BudgetMonth; todayIso: string }) {
  const monthIso = `${plan.scope.month}-01`;
  const current = todayIso.slice(0, 7) === plan.scope.month;
  const pace = current ? monthPacePct(monthIso, todayIso) : undefined;
  const lines = budgetLines(plan.rows, pace ?? 100);
  const totals = budgetTotals(plan.rows);
  const currency = plan.rows[0]?.currency ?? 'USD';
  const diff = totals.budgetedMinor - totals.spentMinor;
  return (
    <div className="flex flex-col">
      <div className="divide-y divide-border">
        {lines.map((l) => (
          <Fragment key={l.row.categoryLedgerAccountId}>
            <CategoryLine line={l} child={false} pacePct={pace} past={!current} />
            {l.children.map((c) => (
              <CategoryLine key={c.row.categoryLedgerAccountId} line={c} child pacePct={pace} past={!current} />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2.5 text-sm font-medium">
        <span>Budgeted total</span>
        <span className="font-mono tabular-nums">
          <Money amountMinor={totals.spentMinor.toString()} currency={currency} className="text-sm" />
          <span className="text-muted-foreground">
            {' '}
            of <Money amountMinor={totals.budgetedMinor.toString()} currency={currency} className="text-sm text-muted-foreground" />
          </span>
        </span>
      </div>
      <p className="pt-1 text-right text-xs text-muted-foreground">
        {diff < 0n ? (
          <span className="font-medium text-foreground">
            <Money amountMinor={(-diff).toString()} currency={currency} className="text-xs text-foreground" /> over
          </span>
        ) : (
          <>
            <Money amountMinor={diff.toString()} currency={currency} className="text-xs" /> {current ? 'left' : 'under'}
          </>
        )}
        {totals.overCount > 0 ? ` · ${String(totals.overCount)} over` : ''}
      </p>
      {plan.everythingElseSpentMinor !== '0' ? (
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-dashed border-border pt-2.5 text-sm text-muted-foreground">
          <span>Everything else (not budgeted)</span>
          <Money amountMinor={plan.everythingElseSpentMinor} currency={currency} className="text-sm text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}

type RangeRow = {
  id: string;
  name: string;
  parentId: string | null;
  currency: string;
  byMonth: Map<string, { spent: bigint; available: bigint }>;
};

function DiffCell({
  cell,
  currency,
  current,
}: {
  cell: { spent: bigint; available: bigint } | undefined;
  currency: string;
  current: boolean;
}) {
  if (!cell) return <span className="text-muted-foreground">—</span>;
  const d = cell.available - cell.spent;
  return d < 0n ? (
    <span className="font-medium text-foreground">
      <Money amountMinor={(-d).toString()} currency={currency} className="text-xs text-foreground" /> over
    </span>
  ) : (
    <span className="text-muted-foreground">
      <Money amountMinor={d.toString()} currency={currency} className="text-xs text-muted-foreground" />{' '}
      {current ? 'left' : 'under'}
    </span>
  );
}

function RangeView({ plans, todayIso }: { plans: BudgetMonth[]; todayIso: string }) {
  const months = plans.map((p) => p.scope.month);
  const rows = useMemo(() => {
    const byId = new Map<string, RangeRow>();
    for (const p of plans) {
      for (const r of p.rows) {
        const fresh: RangeRow = {
          id: r.categoryLedgerAccountId,
          name: r.categoryName,
          parentId: r.parentLedgerAccountId,
          currency: r.currency,
          byMonth: new Map(),
        };
        const e = byId.get(r.categoryLedgerAccountId) ?? fresh;
        e.name = r.categoryName;
        // Each month against its OWN target (no rollover carry): carry is
        // last month's leftover, so adding months with it would count the
        // same dollars twice.
        e.byMonth.set(p.scope.month, {
          spent: BigInt(r.spentMinor || '0'),
          available: BigInt(r.resolvedMinor || '0'),
        });
        byId.set(r.categoryLedgerAccountId, e);
      }
    }
    const all = [...byId.values()];
    const tops = all.filter((r) => !r.parentId || !byId.has(r.parentId)).sort((a, b) => a.name.localeCompare(b.name));
    return tops.flatMap((t) => [
      { r: t, child: false },
      ...all.filter((c) => c.parentId === t.id).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ r: c, child: true })),
    ]);
  }, [plans]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Category</th>
            {months.map((m) => (
              <th key={m} className="px-2 py-2 text-right font-medium">{monthName(`${m}-01`)}</th>
            ))}
            <th className="px-2 py-2 text-right font-medium">Over in</th>
            <th className="py-2 pl-2 text-right font-medium">Range</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, child }) => {
            const cells = [...r.byMonth.values()];
            const overIn = cells.filter((c) => c.spent > c.available).length;
            const total = cells.reduce((acc, c) => acc + (c.available - c.spent), 0n);
            return (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className={cn('py-2 pr-3', child && 'pl-5')}>{r.name}</td>
                {months.map((m) => (
                  <td key={m} className="px-2 py-2 text-right font-mono text-xs tabular-nums">
                    <DiffCell cell={r.byMonth.get(m)} currency={r.currency} current={m === todayIso.slice(0, 7)} />
                  </td>
                ))}
                <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {String(overIn)} of {String(cells.length)}
                </td>
                <td className="py-2 pl-2 text-right font-mono text-xs tabular-nums">
                  {total < 0n ? (
                    <span className="font-medium text-foreground">
                      <Money amountMinor={(-total).toString()} currency={r.currency} className="text-xs text-foreground" /> over
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      <Money amountMinor={total.toString()} currency={r.currency} className="text-xs text-muted-foreground" /> under
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Reports Budget vs actual. One month: every budgeted category grouped under
 * its parent, with bars (pace tick for the current month). Several months:
 * over/under per month. Budgets are household-wide, so a filtered scope gets
 * a note instead of numbers that don't match the filter (Law 9).
 */
export function ReportsBudgetCard({
  householdId,
  months,
  scoped,
  todayIso,
  from,
  to,
  includeTaxes,
}: {
  householdId: string;
  /** YYYY-MM keys the report range covers (oldest first). */
  months: string[];
  /** True when an account or entity filter is active. */
  scoped: boolean;
  todayIso: string;
  /** The report's inclusive day range, to disclose full-month comparisons. */
  from: string;
  to: string;
  /** The report's tax toggle; budgets always count every expense. */
  includeTaxes: boolean;
}) {
  const wanted = useMemo(() => months.slice(-12), [months]);
  const key = wanted.join(',');
  const [state, setState] = useState<{ key: string; plans: BudgetMonth[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (scoped || wanted.length === 0) return;
    let active = true;
    setFailed(false);
    void Promise.all(wanted.map((m) => fetchBudgetMonth(householdId, `${m}-01`)))
      .then((plans) => {
        if (active) setState({ key, plans });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [householdId, key, scoped, wanted]);

  const plans = state?.key === key ? state.plans.filter((p) => p.rows.length > 0) : null;
  const single = wanted.length === 1;
  const title = single ? `Budget vs actual · ${monthName(`${wanted[0] ?? ''}-01`, true)}` : 'Budget vs actual';

  // Budgets are whole calendar months. Disclose when the report's range cuts
  // a month short (a range ending today in the current month is fine: that
  // month's budget is month-to-date too), and when taxes are off (Law 9).
  const firstMonth = wanted[0] ?? '';
  const lastMonth = wanted[wanted.length - 1] ?? '';
  const [ly, lm] = lastMonth.split('-').map(Number);
  const lastDay = `${lastMonth}-${String(new Date(Date.UTC(ly ?? 1970, lm ?? 1, 0)).getUTCDate()).padStart(2, '0')}`;
  const partial =
    from !== `${firstMonth}-01` || (to !== lastDay && !(lastMonth === todayIso.slice(0, 7) && to >= todayIso));
  const notes: string[] = [];
  const endDay = lastMonth === todayIso.slice(0, 7) ? todayIso.slice(8) : lastDay.slice(8);
  if (partial) {
    notes.push(
      `Compares full months (${monthName(`${firstMonth}-01`)} 1 – ${monthName(`${lastMonth}-01`)} ${String(Number(endDay))}), not just the selected days.`,
    );
  }
  if (!includeTaxes) notes.push('Includes taxes: budgets count every expense.');

  if (!scoped && plans !== null && plans.length === 0) return null; // no budget in range
  if (failed) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium text-muted-foreground">
          <span>{title}</span>
          <InfoNote>
            <p>Your budget compared with actual spending, from the same numbers as the Budgets page.</p>
            <p>A parent includes its subcategories that don&apos;t have their own budget. Budgets cover all accounts, so this card ignores the account filter.</p>
          </InfoNote>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!scoped && notes.length > 0 ? (
          <p className="mb-2 text-xs text-muted-foreground">{notes.join(' ')}</p>
        ) : null}
        {scoped ? (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            Budgets cover all accounts. Clear the account and entity filters to compare.
          </p>
        ) : plans === null ? (
          <Skeleton className="h-40 w-full" />
        ) : single && plans[0] ? (
          <MonthView plan={plans[0]} todayIso={todayIso} />
        ) : (
          <RangeView plans={plans} todayIso={todayIso} />
        )}
        {!scoped ? (
          <Link
            href="/dashboard/budgets"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Edit budget <ChevronRight className="size-3" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

