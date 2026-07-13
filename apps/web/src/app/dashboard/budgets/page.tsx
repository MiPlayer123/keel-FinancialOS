'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PiggyBank, ChevronLeft, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { fetchBudgets, setBudget, copyBudgets, type BudgetRow } from '@/lib/keel-api';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

function monthStartIso(offset: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 10);
}

function monthTitle(monthIso: string): string {
  const [y = '', m = ''] = monthIso.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

export default function BudgetsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Budgets"
        description="A monthly amount per category — spending tracked against it, transfers excluded."
      />
      <div className="p-6">
        <BudgetsBody />
      </div>
    </AppShell>
  );
}

function BudgetsBody() {
  const { householdId, ready } = useHousehold();
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<BudgetRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [copying, setCopying] = useState(false);
  const monthIso = monthStartIso(offset);

  const load = useCallback(async () => {
    if (!householdId) return;
    try {
      setRows(await fetchBudgets(householdId, monthIso));
    } catch {
      setAvailable(false);
    }
  }, [householdId, monthIso]);

  useEffect(() => {
    setRows(null);
    void load();
  }, [load]);

  if (!ready || (rows === null && available)) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (!available || !householdId) {
    return (
      <EmptyState
        icon={<PiggyBank className="size-6" />}
        title="Budgets are almost here"
        description="This feature is waiting on a backend update — it will light up automatically once it's deployed."
      />
    );
  }

  const list = rows ?? [];
  const budgeted = list.filter((r) => r.budgetMinor !== null);
  const unbudgeted = list.filter(
    (r) => r.budgetMinor === null && r.spentMinor !== '0',
  );
  const totals = budgeted.reduce(
    (acc, r) => ({
      budget: acc.budget + BigInt(r.budgetMinor ?? '0'),
      spent: acc.spent + BigInt(r.spentMinor),
    }),
    { budget: 0n, spent: 0n },
  );

  async function copyForward() {
    if (!householdId) return;
    setCopying(true);
    try {
      const copied = await copyBudgets(householdId, monthIso);
      toast.success(
        copied > 0 ? `Copied ${String(copied)} budgets from last month.` : 'Nothing to copy.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copy failed.');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => {
              setOffset((o) => o - 1);
            }}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <h2 className="min-w-40 text-center text-sm font-medium">{monthTitle(monthIso)}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            disabled={offset >= 0}
            onClick={() => {
              setOffset((o) => o + 1);
            }}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        {budgeted.length === 0 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={copying}
            onClick={() => {
              void copyForward();
            }}
          >
            {copying ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
            Copy last month
          </Button>
        ) : null}
      </div>

      {budgeted.length > 0 ? (
        <div className="rounded-lg border border-border bg-card px-5 py-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-muted-foreground">Budgeted so far</p>
            <p className="text-sm">
              <Money amountMinor={totals.spent.toString()} /> of{' '}
              <Money amountMinor={totals.budget.toString()} />
            </p>
          </div>
          <ProgressBar spent={totals.spent} budget={totals.budget} />
        </div>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">Categories</h3>
        <div className="overflow-hidden rounded-lg border border-border">
          {list.map((r, i) => (
            <BudgetLine
              key={r.categoryLedgerAccountId}
              row={r}
              first={i === 0}
              householdId={householdId}
              monthIso={monthIso}
              onSaved={() => {
                void load();
              }}
            />
          ))}
        </div>
        {unbudgeted.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Categories without a budget still show what you spent — set an amount to start
            tracking them.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ProgressBar({ spent, budget }: { spent: bigint; budget: bigint }) {
  const over = budget > 0n && spent > budget;
  const pct =
    budget <= 0n ? 0 : Math.min(100, Number((spent * 100n) / (budget === 0n ? 1n : budget)));
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className="h-full rounded-full"
        style={{
          width: `${String(Math.max(pct, spent > 0n ? 2 : 0))}%`,
          background: over ? 'var(--keel-negative)' : 'var(--chart-1)',
        }}
      />
    </div>
  );
}

function BudgetLine({
  row,
  first,
  householdId,
  monthIso,
  onSaved,
}: {
  row: BudgetRow;
  first: boolean;
  householdId: string;
  monthIso: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const spent = useMemo(() => BigInt(row.spentMinor), [row.spentMinor]);
  const budget = row.budgetMinor !== null ? BigInt(row.budgetMinor) : null;
  const remaining = budget !== null ? budget - spent : null;

  async function save() {
    const trimmed = value.trim();
    let amountMinor: string | null = null;
    if (trimmed.length > 0) {
      const minor = parseSignedDollars(trimmed);
      if (minor === null || minor.startsWith('-')) {
        toast.error('Enter a non-negative amount.');
        return;
      }
      amountMinor = minor === '0' ? null : minor;
    }
    setBusy(true);
    try {
      await setBudget({
        householdId,
        categoryLedgerAccountId: row.categoryLedgerAccountId,
        monthIso,
        amountMinor,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the budget.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-border'}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{row.categoryName}</p>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            <Money amountMinor={row.spentMinor} className="text-foreground" /> spent
          </span>
          {editing ? (
            <span className="flex items-center gap-1.5">
              <Input
                className="h-8 w-24 text-right"
                inputMode="decimal"
                autoFocus
                value={value}
                placeholder="0.00"
                onChange={(e) => {
                  setValue(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={busy}
                onClick={() => {
                  void save();
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
              </Button>
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-24 justify-end font-mono tabular-nums"
              onClick={() => {
                setValue(budget !== null ? minorToDollars(row.budgetMinor ?? '0') : '');
                setEditing(true);
              }}
            >
              {budget !== null ? (
                <Money amountMinor={row.budgetMinor ?? '0'} className="text-sm" muteZero={false} />
              ) : (
                <span className="text-xs text-muted-foreground">Set budget</span>
              )}
            </Button>
          )}
        </div>
      </div>
      {budget !== null ? (
        <>
          <ProgressBar spent={spent} budget={budget} />
          {remaining !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {remaining < 0n ? (
                <>
                  Over by{' '}
                  <Money
                    amountMinor={remaining.toString()}
                    className="text-xs"
                  />
                </>
              ) : (
                <>
                  <Money amountMinor={remaining.toString()} className="text-xs text-foreground" />{' '}
                  left
                </>
              )}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
