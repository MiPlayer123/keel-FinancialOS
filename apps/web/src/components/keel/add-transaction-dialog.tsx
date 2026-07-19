'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Split, X } from 'lucide-react';
import { toast } from 'sonner';

import {
  createManualTransaction,
  type AccountRow,
  type CategoryRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import { entityLabel, hasMultipleEntities, scopeToEntity } from '@/lib/category-picker';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type SplitDraft = { categoryId: string | null; amount: string };

type PayeeMemory = {
  description: string;
  direction: 'expense' | 'income';
  /** Absolute minor units of the most recent occurrence. */
  amountMinor: string;
  categoryId: string | null;
  lastDate: string;
  count: number;
};

/**
 * QuickFill memory: one entry per payee (case-insensitive display name),
 * remembering the most recent direction/amount/category. Deterministic —
 * history in, suggestions out (Law 1: no model anywhere near this).
 */
function buildPayeeMemory(history: RichTransactionRow[]): PayeeMemory[] {
  const byName = new Map<string, PayeeMemory>();
  for (const t of history) {
    if (t.transferStatus === 'confirmed') continue;
    const name = t.description.trim();
    if (name.length === 0) continue;
    const cash = BigInt(t.amountMinor || '0');
    if (cash === 0n) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.count += 1;
      if (t.effectiveDate > existing.lastDate) {
        existing.lastDate = t.effectiveDate;
        existing.description = name;
        existing.direction = cash < 0n ? 'expense' : 'income';
        existing.amountMinor = (cash < 0n ? -cash : cash).toString();
        existing.categoryId =
          t.splits && t.splits.length > 1 ? null : (t.categoryLedgerAccountId ?? null);
      }
      continue;
    }
    byName.set(key, {
      description: name,
      direction: cash < 0n ? 'expense' : 'income',
      amountMinor: (cash < 0n ? -cash : cash).toString(),
      categoryId: t.splits && t.splits.length > 1 ? null : (t.categoryLedgerAccountId ?? null),
      lastDate: t.effectiveDate,
      count: 1,
    });
  }
  return [...byName.values()];
}


/**
 * Add a manual transaction: one account, signed cash amount, one category or
 * a multi-category split. Splits are REAL balanced postings server-side; this
 * dialog only assembles integer minor-unit strings (BigInt math, Law 4).
 */
export function AddTransactionDialog({
  open,
  householdId,
  userId,
  accounts,
  categories,
  defaultAccountId,
  history = [],
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string | null;
  userId: string | null;
  accounts: AccountRow[];
  categories: CategoryRow[];
  defaultAccountId?: string;
  /** Recent transactions powering QuickFill payee suggestions (optional). */
  history?: RichTransactionRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [accountId, setAccountId] = useState<string | null>(defaultAccountId ?? null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [splits, setSplits] = useState<SplitDraft[]>([{ categoryId: null, amount: '' }]);
  const [busy, setBusy] = useState(false);
  // One idempotency key per dialog open: a retry after a timeout REPLAYS the
  // same economic event instead of posting a duplicate (invariant 3).
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open) setAttemptKey(crypto.randomUUID());
  }, [open]);

  // Entity-scope to the chosen account's entity (D-060): a manual transaction
  // posts into that account's entity, and the split/category must belong to
  // the same entity (the set-splits proc rejects a cross-entity category).
  // Scoping here removes the identical-name Personal/Business duplication and
  // can only hide options the server would reject. Falls through unscoped
  // until an account is picked (and label-disambiguates if multi-entity).
  const accountEntityId = useMemo(
    () => accounts.find((a) => a.id === accountId)?.entityId ?? null,
    [accounts, accountId],
  );
  const options = useMemo(
    () =>
      scopeToEntity(categories, accountEntityId).filter((c) => c.kind === direction),
    [categories, direction, accountEntityId],
  );
  const showEntity = useMemo(() => hasMultipleEntities(options), [options]);
  const catLabel = useCallback(
    (c: CategoryRow) => entityLabel(c.name, c.entityName, showEntity),
    [showEntity],
  );
  const payeeMemory = useMemo(() => buildPayeeMemory(history), [history]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestions = useMemo(() => {
    const q = description.trim().toLowerCase();
    if (q.length < 2) return [];
    const starts: PayeeMemory[] = [];
    const contains: PayeeMemory[] = [];
    for (const p of payeeMemory) {
      const name = p.description.toLowerCase();
      if (name === q) continue; // already typed in full
      if (name.startsWith(q)) starts.push(p);
      else if (name.includes(q)) contains.push(p);
    }
    const byRecency = (a: PayeeMemory, b: PayeeMemory) => b.lastDate.localeCompare(a.lastDate);
    return [...starts.sort(byRecency), ...contains.sort(byRecency)].slice(0, 5);
  }, [description, payeeMemory]);

  function applySuggestion(p: PayeeMemory) {
    setDescription(p.description);
    setDirection(p.direction);
    setAmount(minorToDollars(p.amountMinor));
    // Only fill the category when it still exists for that direction.
    const valid =
      p.categoryId !== null &&
      categories.some((c) => c.ledgerAccountId === p.categoryId && c.kind === p.direction);
    setSplits([{ categoryId: valid ? p.categoryId : null, amount: '' }]);
    setSuggestOpen(false);
  }
  const optionItems = useMemo(
    () => Object.fromEntries(options.map((c) => [c.ledgerAccountId, catLabel(c)])),
    [options, catLabel],
  );
  const isSplit = splits.length > 1;

  function reset() {
    setDirection('expense');
    setAccountId(defaultAccountId ?? null);
    setDescription('');
    setAmount('');
    setSplits([{ categoryId: null, amount: '' }]);
  }

  function setSplitAt(i: number, patch: Partial<SplitDraft>) {
    setSplits((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  async function save() {
    if (!householdId || !userId || !accountId) return;
    const totalMinor = parseSignedDollars(amount);
    if (totalMinor === null || totalMinor.startsWith('-') || totalMinor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    // Cash side is signed: expense = money out (negative), income = in.
    const cashMinor = direction === 'expense' ? `-${totalMinor}` : totalMinor;
    // Splits offset the cash side exactly: expense splits positive, income negative.
    const splitSign = direction === 'expense' ? 1n : -1n;
    const payloadSplits: { categoryLedgerAccountId: string; amountMinor: string }[] = [];
    if (isSplit) {
      let sum = 0n;
      for (const s of splits) {
        if (!s.categoryId) {
          toast.error('Pick a category for every split.');
          return;
        }
        const minor = parseSignedDollars(s.amount);
        if (minor === null || minor.startsWith('-') || minor === '0') {
          toast.error('Every split needs a positive amount.');
          return;
        }
        sum += BigInt(minor);
        payloadSplits.push({
          categoryLedgerAccountId: s.categoryId,
          amountMinor: (splitSign * BigInt(minor)).toString(),
        });
      }
      if (sum !== BigInt(totalMinor)) {
        const delta = BigInt(totalMinor) - sum;
        toast.error(
          `Splits must add up to the total — ${delta > 0n ? 'add' : 'remove'} ${(delta < 0n
            ? -delta
            : delta
          ).toString()} cents.`,
        );
        return;
      }
    } else {
      const only = splits[0];
      if (!only?.categoryId) {
        toast.error('Pick a category.');
        return;
      }
      payloadSplits.push({
        categoryLedgerAccountId: only.categoryId,
        amountMinor: (splitSign * BigInt(totalMinor)).toString(),
      });
    }
    if (description.trim().length === 0) {
      toast.error('Give it a description.');
      return;
    }
    setBusy(true);
    try {
      await createManualTransaction({
        householdId,
        userId,
        accountId,
        description: description.trim(),
        effectiveDate: date,
        amountMinor: cashMinor,
        status: 'posted',
        splits: payloadSplits,
        attemptKey,
      });
      toast.success('Transaction added.');
      reset();
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the transaction.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add transaction</DialogTitle>
          <DialogDescription>
            Record cash, checks, or anything the bank feed doesn&apos;t carry. Split it
            across categories if one label doesn&apos;t fit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            {(['expense', 'income'] as const).map((d) => (
              <Button
                key={d}
                type="button"
                variant={direction === d ? 'secondary' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setDirection(d);
                  setSplits((prev) => prev.map((s) => ({ ...s, categoryId: null })));
                }}
              >
                {d === 'expense' ? 'Money out' : 'Money in'}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Account</Label>
              <Select
                value={accountId ?? undefined}
                items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
                onValueChange={(v) => {
                  setAccountId(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-date">Date</Label>
              <Input
                id="add-date"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="relative space-y-1.5">
              <Label htmlFor="add-desc">Description</Label>
              <Input
                id="add-desc"
                value={description}
                maxLength={500}
                placeholder="e.g. Farmers market"
                autoComplete="off"
                role="combobox"
                aria-expanded={suggestOpen && suggestions.length > 0}
                aria-controls="add-desc-suggestions"
                onChange={(e) => {
                  setDescription(e.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => {
                  setSuggestOpen(true);
                }}
                onBlur={() => {
                  // Let a mousedown on a suggestion land first.
                  window.setTimeout(() => {
                    setSuggestOpen(false);
                  }, 150);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSuggestOpen(false);
                  // Enter applies the top suggestion; Tab keeps normal focus
                  // movement (hijacking Tab clobbers a half-typed description).
                  if (e.key === 'Enter' && suggestOpen && suggestions[0]) {
                    e.preventDefault();
                    applySuggestion(suggestions[0]);
                  }
                }}
              />
              {suggestOpen && suggestions.length > 0 ? (
                <ul
                  id="add-desc-suggestions"
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md"
                >
                  {suggestions.map((p) => (
                    <li key={p.description.toLowerCase()} role="option" aria-selected={false}>
                      <button
                        type="button"
                        className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-secondary"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          applySuggestion(p);
                        }}
                      >
                        <span className="min-w-0 truncate">{p.description}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {p.direction === 'expense' ? '−' : '+'}
                          {minorToDollars(p.amountMinor)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-amount">Amount</Label>
              <Input
                id="add-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{isSplit ? 'Splits' : 'Category'}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setSplits((prev) =>
                    prev.length === 1
                      ? [
                          { categoryId: prev[0]?.categoryId ?? null, amount: '' },
                          { categoryId: null, amount: '' },
                        ]
                      : [...prev, { categoryId: null, amount: '' }],
                  );
                }}
              >
                <Split className="size-3.5" />
                {isSplit ? 'Add split' : 'Split'}
              </Button>
            </div>
            {splits.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={s.categoryId ?? undefined}
                  items={optionItems}
                  onValueChange={(v) => {
                    setSplitAt(i, { categoryId: v });
                  }}
                >
                  <SelectTrigger className="min-w-0 flex-1">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((c) => (
                      <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                        {c.parentLedgerAccountId ? (
                          <span className="pl-3">{catLabel(c)}</span>
                        ) : (
                          catLabel(c)
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isSplit ? (
                  <>
                    <Input
                      inputMode="decimal"
                      placeholder="0.00"
                      className="w-24"
                      aria-label={`Split ${String(i + 1)} amount`}
                      value={s.amount}
                      onChange={(e) => {
                        setSplitAt(i, { amount: e.target.value });
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove split"
                      onClick={() => {
                        setSplits((prev) =>
                          prev.length <= 2
                            ? [{ categoryId: prev[0]?.categoryId ?? null, amount: '' }]
                            : prev.filter((_, idx) => idx !== i),
                        );
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
            {isSplit ? (
              <p className="text-xs text-muted-foreground">
                Split amounts must add up to the total.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !accountId ||
              !amount.trim() ||
              !date ||
              description.trim().length === 0 ||
              splits.some((s) => !s.categoryId)
            }
            onClick={() => {
              void save();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
