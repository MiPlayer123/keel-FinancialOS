'use client';

import { useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';

import { Money } from '@/components/keel/money';
import {
  setBudgetTotal,
  setBudgetExpectedIncome,
  type BudgetMonth,
} from '@/lib/keel-api';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
import { bpToPercentLabel as bpLabel, percentToBp } from '@/lib/budget-percent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Nullable wrapper: the plan total may have no declared percent (amount basis). */
function bpToPercentLabel(bp: number | null): string {
  return bp === null ? '' : bpLabel(bp);
}

/**
 * Plan header (SLICE B3, founder ask c): the editable plan TOTAL — a dollar
 * amount or a percent of expected income — plus the Monarch-style Left-to-budget
 * line. Left-to-budget = total − Σ resolved category targets; negative means
 * over-allocated and is flagged (Law 8: the negative number is red money, and
 * the "Over-allocated" status sits right beside it).
 */
export function BudgetPlanHeader({
  plan,
  householdId,
  userId,
  monthIso,
  onSaved,
}: {
  plan: BudgetMonth;
  householdId: string;
  userId: string;
  monthIso: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [basis, setBasis] = useState<'amount' | 'percent_of_income'>(
    plan.total.basis === 'percent_of_income' ? 'percent_of_income' : 'amount',
  );
  const [amountValue, setAmountValue] = useState('');
  const [percentValue, setPercentValue] = useState('');
  const [incomeValue, setIncomeValue] = useState('');

  const leftToBudget = BigInt(plan.leftToBudgetMinor);
  const overAllocated = leftToBudget < 0n;
  const totalIsImplicit = plan.total.basis === 'implicit_sum';

  function beginEdit() {
    setBasis(plan.total.basis === 'percent_of_income' ? 'percent_of_income' : 'amount');
    setAmountValue(
      plan.total.declaredAmountMinor ? minorToDollars(plan.total.declaredAmountMinor) : '',
    );
    setPercentValue(bpToPercentLabel(plan.total.declaredPercentBp));
    setIncomeValue(plan.expectedIncomeMinor ? minorToDollars(plan.expectedIncomeMinor) : '');
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    try {
      if (basis === 'amount') {
        const minor = parseSignedDollars(amountValue.trim());
        if (minor === null || minor.startsWith('-')) {
          toast.error('Enter a non-negative amount.');
          setBusy(false);
          return;
        }
        await setBudgetTotal({ householdId, userId, monthIso, basis: 'amount', amountMinor: minor });
      } else {
        const bp = percentToBp(percentValue);
        if (bp === null) {
          toast.error('Enter a percent between 0 and 100.');
          setBusy(false);
          return;
        }
        // Expected income is required for a percent total to resolve; set it
        // first (it's an explicit user confirmation, not a fabricated number).
        const incomeMinor = parseSignedDollars(incomeValue.trim());
        if (incomeMinor === null || incomeMinor.startsWith('-')) {
          toast.error('Enter your expected monthly income for a percent-of-income total.');
          setBusy(false);
          return;
        }
        await setBudgetExpectedIncome({ householdId, userId, monthIso, amountMinor: incomeMinor });
        await setBudgetTotal({
          householdId,
          userId,
          monthIso,
          basis: 'percent_of_income',
          percentBp: bp,
        });
      }
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the plan total.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Plan total</p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <Money
              amountMinor={plan.total.resolvedMinor}
              className="text-2xl font-semibold"
              muteZero={false}
            />
            {plan.total.basis === 'percent_of_income' && plan.total.declaredPercentBp !== null ? (
              <span className="text-xs text-muted-foreground">
                {bpToPercentLabel(plan.total.declaredPercentBp)}% of{' '}
                {plan.expectedIncomeMinor ? (
                  <Money amountMinor={plan.expectedIncomeMinor} className="text-xs" />
                ) : (
                  'income'
                )}
              </span>
            ) : totalIsImplicit ? (
              <span className="text-xs text-muted-foreground">sum of your dollar budgets</span>
            ) : null}
          </div>
        </div>
        {!editing ? (
          <Button variant="outline" size="sm" className="h-8" onClick={beginEdit}>
            <Pencil className="size-3.5" />
            {totalIsImplicit ? 'Set a total' : 'Edit total'}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                basis === 'amount' ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              }`}
              onClick={() => {
                setBasis('amount');
              }}
            >
              Dollar amount
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                basis === 'percent_of_income'
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground'
              }`}
              onClick={() => {
                setBasis('percent_of_income');
              }}
            >
              % of income
            </button>
          </div>

          {basis === 'amount' ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                className="h-9 w-40"
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
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">Percent of income</span>
                <span className="flex items-center gap-1.5">
                  <Input
                    className="h-9 w-24 text-right"
                    inputMode="decimal"
                    autoFocus
                    placeholder="50"
                    value={percentValue}
                    onChange={(e) => {
                      setPercentValue(e.target.value);
                    }}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </span>
              </label>
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">Expected monthly income</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    className="h-9 w-40"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={incomeValue}
                    onChange={(e) => {
                      setIncomeValue(e.target.value);
                    }}
                  />
                </span>
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save total
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {overAllocated ? 'Over-allocated by' : 'Left to budget'}
          </span>
          {overAllocated ? (
            <span className="rounded-full bg-keel-negative/10 px-2 py-0.5 text-xs font-medium text-keel-negative">
              Over
            </span>
          ) : null}
        </span>
        <Money
          amountMinor={leftToBudget.toString()}
          signed
          className="text-sm font-medium"
          muteZero={false}
        />
      </div>
    </div>
  );
}
