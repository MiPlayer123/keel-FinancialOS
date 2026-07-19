'use client';

import { useMemo, useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { setBudgetTarget, type BudgetRow } from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * "Add category" picker for the opt-in budgets view (SLICE B1, founder ask a).
 * Lists live expense categories that are NOT yet budgeted (the caller already
 * filtered out money-movement buckets). Picking one opens a budget row by
 * setting a $0 budget — the row then appears in the budgeted list where the
 * user types the real amount inline. $0 is a deliberate, valid opt-in marker
 * (non-negative per the existing set-budget contract), not a hidden default:
 * the user immediately sees and edits it.
 */
export function AddBudgetCategoryPicker({
  categories,
  householdId,
  userId,
  monthIso,
  onAdded,
}: {
  /** Addable rows: live expense categories, not yet budgeted, not movement. */
  categories: BudgetRow[];
  householdId: string;
  userId: string;
  monthIso: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const nameById = useMemo(
    () => new Map(categories.map((c) => [c.categoryLedgerAccountId, c.categoryName])),
    [categories],
  );

  // Label children with their parent so "Groceries" under "Food" reads clearly.
  const options = useMemo(
    () =>
      [...categories]
        .map((c) => ({
          row: c,
          label: c.parentLedgerAccountId
            ? `${nameById.get(c.parentLedgerAccountId) ?? ''} › ${c.categoryName}`
            : c.categoryName,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [categories, nameById],
  );

  async function pick(row: BudgetRow) {
    if (busyId) return;
    setBusyId(row.categoryLedgerAccountId);
    try {
      // Opt in with an explicit, immediately-editable $0 amount target (valid
      // per the non-negative set_target contract — not a hidden default).
      await setBudgetTarget({
        householdId,
        userId,
        monthIso,
        categoryLedgerAccountId: row.categoryLedgerAccountId,
        kind: 'amount',
        amountMinor: '0',
      });
      toast.success(`Added ${row.categoryName} — set an amount to start tracking it.`);
      setOpen(false);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the category.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="default" size="sm" disabled={options.length === 0} />}
      >
        <Plus className="size-4" />
        Add category
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Find a category…" />
          <CommandList>
            <CommandEmpty>No categories left to budget.</CommandEmpty>
            <CommandGroup>
              {options.map(({ row, label }) => (
                <CommandItem
                  key={row.categoryLedgerAccountId}
                  value={label}
                  disabled={busyId !== null}
                  onSelect={() => {
                    void pick(row);
                  }}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 truncate">{label}</span>
                  {busyId === row.categoryLedgerAccountId ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : row.spentMinor !== '0' ? (
                    <Money
                      amountMinor={row.spentMinor}
                      className="shrink-0 text-xs text-muted-foreground"
                    />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
