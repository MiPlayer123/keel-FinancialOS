'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Money } from '@/components/keel/money';
import {
  setBudgetTarget,
  removeBudgetTarget,
  type BudgetMonthRow,
  type BudgetTargetKind,
} from '@/lib/keel-api';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
import { resolvePercentMinor, bpToPercentLabel, percentToBp } from '@/lib/budget-percent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function ProgressBar({ spent, budget }: { spent: bigint; budget: bigint }) {
  const over = budget > 0n ? spent > budget : budget < 0n || spent > 0n;
  const pct =
    budget <= 0n ? (over ? 100 : 0) : Math.min(100, Number((spent * 100n) / budget));
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

/**
 * One opt-in category row (SLICE B3, founder ask b): a kind toggle ($ ⇄ % of
 * total) with a LIVE resolved preview, measured against the pinned v3 spent
 * figure. Percent resolution here mirrors keel_budget_month's floor exactly, so
 * the preview equals what the server will store. Rollover + soft remove kept.
 */
export function BudgetCategoryRow({
  row,
  totalMinor,
  first,
  householdId,
  userId,
  monthIso,
  onSaved,
}: {
  row: BudgetMonthRow;
  totalMinor: string;
  first: boolean;
  householdId: string;
  userId: string;
  monthIso: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<BudgetTargetKind>(row.kind);
  const [amountValue, setAmountValue] = useState('');
  const [percentValue, setPercentValue] = useState('');

  const total = BigInt(totalMinor);
  const spent = BigInt(row.spentMinor);
  const rollover = row.rollover;
  const available = BigInt(row.availableMinor);
  const remaining = available - spent;

  // Live preview while editing a percent target.
  const previewBp = kind === 'percent_of_total' ? percentToBp(percentValue) : null;
  const previewMinor =
    kind === 'percent_of_total' && previewBp !== null ? resolvePercentMinor(total, previewBp) : null;

  function beginEdit() {
    setKind(row.kind);
    setAmountValue(row.kind === 'amount' ? minorToDollars(row.resolvedMinor) : '');
    setPercentValue(row.kind === 'percent_of_total' ? bpToPercentLabel(row.declared.percentBp ?? 0) : '');
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      if (kind === 'amount') {
        const minor = parseSignedDollars(amountValue.trim());
        if (minor === null || minor.startsWith('-')) {
          toast.error('Enter a non-negative amount.');
          setBusy(false);
          return;
        }
        await setBudgetTarget({
          householdId,
          userId,
          monthIso,
          categoryLedgerAccountId: row.categoryLedgerAccountId,
          kind: 'amount',
          amountMinor: minor,
          rollover,
        });
      } else {
        const bp = percentToBp(percentValue);
        if (bp === null) {
          toast.error('Enter a percent between 0 and 100.');
          setBusy(false);
          return;
        }
        await setBudgetTarget({
          householdId,
          userId,
          monthIso,
          categoryLedgerAccountId: row.categoryLedgerAccountId,
          kind: 'percent_of_total',
          percentBp: bp,
          rollover,
        });
      }
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the budget.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleRollover() {
    setBusy(true);
    try {
      // Re-assert the current target with the flipped rollover flag. Percent
      // targets keep their bp; amount targets keep their resolved amount.
      await setBudgetTarget({
        householdId,
        userId,
        monthIso,
        categoryLedgerAccountId: row.categoryLedgerAccountId,
        ...(row.kind === 'amount'
          ? { kind: 'amount' as const, amountMinor: row.resolvedMinor }
          : { kind: 'percent_of_total' as const, percentBp: row.declared.percentBp ?? 0 }),
        rollover: !rollover,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update rollover.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await removeBudgetTarget({
        householdId,
        userId,
        monthIso,
        categoryLedgerAccountId: row.categoryLedgerAccountId,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the budget.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`px-4 py-3 ${first ? '' : 'border-t border-border'}`}>
      <div className="flex items-center justify-between gap-3">
        <p
          className={`min-w-0 flex-1 truncate text-sm font-medium ${
            row.parentLedgerAccountId ? 'pl-4' : ''
          }`}
        >
          {row.categoryName}
        </p>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            <Money amountMinor={row.spentMinor} className="text-foreground" /> spent
          </span>
          {!editing ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-24 justify-end font-mono tabular-nums"
              onClick={beginEdit}
            >
              {row.kind === 'percent_of_total' ? (
                <span className="flex items-baseline gap-1">
                  <span className="text-xs text-muted-foreground">
                    {bpToPercentLabel(row.declared.percentBp ?? 0)}%
                  </span>
                  <Money amountMinor={row.resolvedMinor} className="text-sm" muteZero={false} />
                </span>
              ) : (
                <Money amountMinor={row.resolvedMinor} className="text-sm" muteZero={false} />
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                kind === 'amount' ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              }`}
              onClick={() => {
                setKind('amount');
              }}
            >
              $
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                kind === 'percent_of_total' ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              }`}
              onClick={() => {
                setKind('percent_of_total');
              }}
            >
              % of total
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {kind === 'amount' ? (
              <>
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  className="h-9 w-32 text-right"
                  inputMode="decimal"
                  autoFocus
                  placeholder="0.00"
                  value={amountValue}
                  onChange={(e) => {
                    setAmountValue(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                />
              </>
            ) : (
              <>
                <Input
                  className="h-9 w-24 text-right"
                  inputMode="decimal"
                  autoFocus
                  placeholder="25"
                  value={percentValue}
                  onChange={(e) => {
                    setPercentValue(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save();
                    if (e.key === 'Escape') setEditing(false);
                  }}
                />
                <span className="text-sm text-muted-foreground">% of total</span>
                {previewMinor !== null ? (
                  <span className="text-xs text-muted-foreground">
                    = <Money amountMinor={previewMinor.toString()} className="text-xs" />
                  </span>
                ) : null}
              </>
            )}
            <Button
              size="sm"
              className="h-9"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              disabled={busy}
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ProgressBar spent={spent} budget={available} />
          <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <p>
              {remaining < 0n ? (
                <>
                  Over by <Money amountMinor={remaining.toString()} className="text-xs" />
                </>
              ) : (
                <>
                  <Money amountMinor={remaining.toString()} className="text-xs text-foreground" />{' '}
                  left
                  {rollover && row.carryMinor != null && row.carryMinor !== '0' ? (
                    <>
                      {' '}
                      (incl. <Money amountMinor={row.carryMinor} signed className="text-xs" />{' '}
                      carried)
                    </>
                  ) : null}
                </>
              )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={busy}
                className={`rounded-full border px-2 py-0.5 transition-colors ${
                  rollover
                    ? 'border-foreground/30 text-foreground'
                    : 'border-dashed border-border hover:text-foreground'
                }`}
                title="Carry unspent budget (or overspend) into next month"
                onClick={() => {
                  void toggleRollover();
                }}
              >
                {rollover ? 'Rollover on' : 'Rollover'}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-full border border-dashed border-border px-2 py-0.5 transition-colors hover:text-foreground"
                title="Remove this budget — the category moves to Everything else"
                onClick={() => {
                  void remove();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
