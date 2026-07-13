'use client';

import { useMemo, useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { setBudget, type BudgetRow, type RichTransactionRow } from '@/lib/keel-api';
import { useKeelQuerySilent } from '@/lib/use-keel-query';
import { Money } from '@/components/keel/money';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Month keys ("YYYY-MM") for the `n` full calendar months strictly before `monthIso`. */
function monthsBefore(monthIso: string, n: number): string[] {
  const [yStr = '', mStr = ''] = monthIso.slice(0, 7).split('-');
  const y = Number(yStr);
  const m = Number(mStr); // 1-based
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * Sum of net expense spend per category over the given months — same
 * split-aware, confirmed-transfer-excluding, net-signed convention as
 * `buildMatrix` in reports/page.tsx (and the same sign convention the
 * `budgets.list` RPC uses for `spentMinor`): debit-positive, refunds net out.
 */
function threeMonthActuals(rows: RichTransactionRow[], months: string[]): Map<string, bigint> {
  const monthSet = new Set(months);
  const totals = new Map<string, bigint>();
  const add = (id: string, amt: bigint) => {
    totals.set(id, (totals.get(id) ?? 0n) + amt);
  };
  for (const t of rows) {
    if (t.transferStatus === 'confirmed') continue;
    const mk = t.effectiveDate.slice(0, 7);
    if (!monthSet.has(mk)) continue;
    if (t.splits && t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.kind !== 'expense') continue;
        add(s.categoryLedgerAccountId, BigInt(s.amountMinor || '0'));
      }
      continue;
    }
    if (t.categoryKind !== 'expense' || !t.categoryLedgerAccountId) continue;
    // Cash convention: negative = money out, so spend = -amount.
    add(t.categoryLedgerAccountId, -BigInt(t.amountMinor || '0'));
  }
  return totals;
}

/** Average of a 3-month sum, rounded UP to the next whole dollar. Negative
 *  sums (net refunds) clamp to 0 — a budget suggestion is never negative. */
function proposeRawMinor(sumMinor: bigint): bigint {
  const clamped = sumMinor > 0n ? sumMinor : 0n;
  const avg = clamped / 3n; // BigInt division truncates toward zero == floor here (non-negative)
  return ((avg + 99n) / 100n) * 100n; // ceiling to the next whole dollar
}

type Candidate = {
  id: string;
  name: string;
  currency: string;
  current: bigint;
  raw: bigint;
};

type RebalanceResult = {
  proposed: Map<string, bigint>;
  /** Only positive when raw proposals underrun the current total (no scaling applied). */
  unallocatedMinor: bigint;
};

/**
 * Deterministic rebalance rule:
 *
 * 1. `raw_i` = ceil(3-month average actual spend) for each budgeted category.
 * 2. If Σraw_i ≤ Σcurrent_i: use raw_i as-is. The shortfall
 *    (Σcurrent_i − Σraw_i) is reported as an explicit "unallocated" amount —
 *    it is NOT redistributed into any category's budget.
 * 3. If Σraw_i > Σcurrent_i: categories whose raw proposal is a DECREASE
 *    (raw_i < current_i) are left untouched at raw_i. Categories whose raw
 *    proposal is an INCREASE (increase_i = raw_i − current_i > 0) have that
 *    increase scaled down proportionally so the grand total lands back on
 *    Σcurrent_i exactly:
 *      excess          = Σraw_i − Σcurrent_i        (= Σincrease_i − Σdecrease_i)
 *      cut_i           = floor(increase_i × excess / Σincrease_i)
 *      finalIncrease_i = increase_i − cut_i
 *    Flooring can leave a few minor units of `excess` undistributed
 *    (Σcut_i ≤ excess); that leftover is walked one minor unit at a time into
 *    the largest-increase categories first (ties broken by category id)
 *    until it is exhausted, so the total is preserved to the minor unit —
 *    never merely bounded by "≤".
 */
function rebalance(candidates: Candidate[]): RebalanceResult {
  const totalCurrent = candidates.reduce((a, c) => a + c.current, 0n);
  const totalRaw = candidates.reduce((a, c) => a + c.raw, 0n);

  if (totalRaw <= totalCurrent) {
    const proposed = new Map(candidates.map((c) => [c.id, c.raw]));
    return { proposed, unallocatedMinor: totalCurrent - totalRaw };
  }

  const excess = totalRaw - totalCurrent;
  const increases = candidates
    .filter((c) => c.raw > c.current)
    .map((c) => ({ id: c.id, increase: c.raw - c.current }));
  const totalIncrease = increases.reduce((a, c) => a + c.increase, 0n);

  const cuts = new Map<string, bigint>();
  let cutSum = 0n;
  for (const inc of increases) {
    const cut = (inc.increase * excess) / totalIncrease; // floor (both operands >= 0)
    cuts.set(inc.id, cut);
    cutSum += cut;
  }
  let remainder = excess - cutSum;
  if (remainder > 0n) {
    const order = [...increases].sort((a, b) =>
      b.increase !== a.increase ? (b.increase > a.increase ? 1 : -1) : a.id < b.id ? -1 : 1,
    );
    for (const inc of order) {
      if (remainder <= 0n) break;
      const already = cuts.get(inc.id) ?? 0n;
      if (already >= inc.increase) continue; // no more room to cut on this one
      cuts.set(inc.id, already + 1n);
      remainder -= 1n;
    }
  }

  const proposed = new Map<string, bigint>();
  for (const c of candidates) {
    if (c.raw > c.current) {
      const increase = c.raw - c.current;
      const cut = cuts.get(c.id) ?? 0n;
      proposed.set(c.id, c.current + (increase - cut));
    } else {
      proposed.set(c.id, c.raw);
    }
  }
  return { proposed, unallocatedMinor: 0n };
}

export function RebalanceBudgetsDialog({
  householdId,
  monthIso,
  rows,
  onDone,
}: {
  householdId: string;
  monthIso: string;
  /** Currently-budgeted categories only (budgetMinor !== null). */
  rows: BudgetRow[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Fetched only while the dialog is open, so the wand doesn't cost anything
  // for people who never click it.
  const txns = useKeelQuerySilent<RichTransactionRow>(
    'transactions.rich',
    open ? householdId : null,
  );

  const candidates: Omit<Candidate, 'raw'>[] = useMemo(
    () =>
      rows.map((r) => ({
        id: r.categoryLedgerAccountId,
        name: r.categoryName,
        currency: r.currency,
        current: BigInt(r.budgetMinor ?? '0'),
      })),
    [rows],
  );

  const result = useMemo(() => {
    if (txns === null) return null;
    const months = monthsBefore(monthIso, 3);
    const actuals = threeMonthActuals(txns, months);
    const withRaw: Candidate[] = candidates.map((c) => ({
      ...c,
      raw: proposeRawMinor(actuals.get(c.id) ?? 0n),
    }));
    return { candidates: withRaw, ...rebalance(withRaw) };
  }, [txns, candidates, monthIso]);

  const changed = useMemo(
    () =>
      result
        ? result.candidates
            .map((c) => ({ ...c, proposed: result.proposed.get(c.id) ?? c.current }))
            .filter((c) => c.proposed !== c.current)
        : [],
    [result],
  );

  async function apply() {
    if (!result) return;
    setBusy(true);
    setProgress({ done: 0, total: changed.length });
    let applied = 0;
    let failed = 0;
    for (const c of changed) {
      try {
        await setBudget({
          householdId,
          categoryLedgerAccountId: c.id,
          monthIso,
          amountMinor: c.proposed.toString(),
        });
        applied++;
      } catch {
        failed++;
      }
      setProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
    }
    setBusy(false);
    setProgress(null);
    toast[failed > 0 ? 'error' : 'success'](
      failed > 0
        ? `Applied ${String(applied)}, ${String(failed)} failed.`
        : `Applied ${String(applied)} change${applied === 1 ? '' : 's'}.`,
    );
    setOpen(false);
    onDone();
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Wand2 className="size-4" />
        Rebalance
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Rebalance budgets</DialogTitle>
            <DialogDescription>
              A suggestion, not a write: proposed budgets are the last 3 full months&apos;
              average actual spend per category, rounded up to the dollar. Nothing changes
              until you apply it.
            </DialogDescription>
          </DialogHeader>

          {txns === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Crunching the last 3 months…
            </div>
          ) : changed.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              Every budget already matches its 3-month average — nothing to rebalance.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-md border border-border">
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  <span>Category</span>
                  <span className="text-right">Current</span>
                  <span className="text-right">Proposed</span>
                  <span className="text-right">Change</span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {changed.map((c, i) => {
                    const delta = c.proposed - c.current;
                    return (
                      <div
                        key={c.id}
                        className={cn(
                          'grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-3 py-2 text-sm',
                          i > 0 && 'border-t border-border',
                        )}
                      >
                        <span className="min-w-0 truncate">{c.name}</span>
                        <Money
                          amountMinor={c.current.toString()}
                          currency={c.currency}
                          className="text-right text-xs"
                        />
                        <Money
                          amountMinor={c.proposed.toString()}
                          currency={c.currency}
                          className="text-right text-xs"
                        />
                        <span
                          className={cn(
                            'text-right font-mono text-xs tabular-nums',
                            // Law 8: red is reserved for negative MONEY, not for a
                            // budget decrease — decreases are muted, never red.
                            delta < 0n ? 'text-muted-foreground' : 'text-foreground',
                          )}
                        >
                          {delta >= 0n ? '+' : '−'}
                          {formatMoney((delta < 0n ? -delta : delta).toString(), {
                            currency: c.currency,
                          })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {result && result.unallocatedMinor > 0n ? (
                <p className="text-xs text-muted-foreground">
                  <Money amountMinor={result.unallocatedMinor.toString()} className="text-xs" />{' '}
                  of the current total stays unallocated — proposals came in under budget and
                  headroom isn&apos;t redistributed.
                </p>
              ) : null}
              {progress ? (
                <p className="text-sm text-muted-foreground">
                  Applying {String(progress.done)} / {String(progress.total)}…
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || changed.length === 0}
              onClick={() => {
                void apply();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Apply {changed.length > 0 ? String(changed.length) : ''} change
              {changed.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
