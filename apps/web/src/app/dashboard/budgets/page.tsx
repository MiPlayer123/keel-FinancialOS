'use client';

import { useCallback, useEffect, useState } from 'react';
import { PiggyBank, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';

import { PageHeader, EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { RebalanceBudgetsDialog } from '@/components/keel/rebalance-budgets-dialog';
import { AddBudgetCategoryPicker } from '@/components/keel/add-budget-category-picker';
import { BudgetPlanHeader } from '@/components/keel/budget-plan-header';
import { BudgetCategoryRow } from '@/components/keel/budget-category-row';
import { useHousehold } from '@/components/keel/household-context';
import { useEntityLens } from '@/components/keel/entity-lens-context';
import { scopeToEntity } from '@/lib/category-picker';
import {
  fetchBudgetMonth,
  fetchCategories,
  type BudgetMonth,
  type BudgetMonthRow,
  type CategoryRow,
} from '@/lib/keel-api';
import { isMoneyMovementCategoryName } from '@/lib/spending';
import { Button } from '@/components/ui/button';
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
    <>
      <PageHeader
        title="Budgets"
        description="A plan total you steer, the categories you choose, and everything else in one line."
      />
      <div className="p-6">
        <BudgetsBody />
      </div>
    </>
  );
}

function BudgetsBody() {
  const { householdId, userId, ready } = useHousehold();
  // "The global version we have" (founder ask): budgeting must honour the same
  // household-wide entity lens the Dashboard/Ledger/Accounts use. Categories are
  // ledger_accounts scoped per entity, so the SAME name ("Restaurants") exists
  // once per entity — with no scope the Add-category picker listed every name
  // TWICE (Personal + Business), which read as double-counting. Scoping the
  // addable list to the active lens collapses the apparent duplicate to the one
  // entity the user is actually looking at; blended (null lens) keeps the full
  // list and relies on the picker's entity-label disambiguation (D-060).
  const { entityId: lensEntityId, multiEntity } = useEntityLens();
  const [offset, setOffset] = useState(0);
  const [plan, setPlan] = useState<BudgetMonth | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const monthIso = monthStartIso(offset);

  const load = useCallback(async () => {
    if (!householdId) return;
    setLoadError(null);
    try {
      const [p, cats] = await Promise.all([
        fetchBudgetMonth(householdId, monthIso),
        fetchCategories(householdId).catch(() => [] as CategoryRow[]),
      ]);
      setPlan(p);
      setCategories(cats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/unknown query|does not exist|not_found/i.test(msg)) {
        setAvailable(false);
      } else {
        setPlan(null);
        setLoadError(msg || 'Could not load budgets.');
      }
    }
  }, [householdId, monthIso]);

  useEffect(() => {
    setPlan(null);
    void load();
  }, [load]);

  if (!ready || (plan === null && available && loadError === null)) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (loadError) {
    return (
      <QueryErrorState
        onRetry={() => {
          void load();
        }}
      />
    );
  }

  if (!available || !householdId || !userId || !plan) {
    return (
      <EmptyState
        icon={<PiggyBank className="size-6" />}
        title="Budgets are almost here"
        description="This feature is waiting on a backend update — it will light up automatically once it's deployed."
      />
    );
  }

  const rows = plan.rows;
  const budgetedIds = new Set(rows.map((r) => r.categoryLedgerAccountId));

  // Categories the picker can still add: live EXPENSE categories not already
  // targeted and not money-movement buckets. Fed from categories.list (the
  // authoritative taxonomy), shaped into the picker's BudgetRow contract.
  // Entity-scoped to the active lens first (see the lens comment above): with a
  // lens set, only that entity's categories are offered, so identically-named
  // categories from another entity no longer appear as duplicates. A blended
  // lens (null), or a single-entity household, passes the full list through.
  const scopedCategories =
    multiEntity && lensEntityId !== null
      ? scopeToEntity(categories, lensEntityId)
      : categories;
  const addable = scopedCategories
    .filter(
      (c) =>
        c.kind === 'expense' &&
        !budgetedIds.has(c.ledgerAccountId) &&
        !isMoneyMovementCategoryName(c.name),
    )
    .map((c) => ({
      categoryLedgerAccountId: c.ledgerAccountId,
      categoryName: c.name,
      currency: 'USD',
      // Carry the entity so the (cross-entity) budgeting picker can label
      // identically-named categories from Personal vs Business (D-060).
      entityName: c.entityName ?? null,
      parentLedgerAccountId: c.parentLedgerAccountId ?? null,
      budgetMinor: null,
      spentMinor: '0',
    }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));

  // Children sort under their parent (one-level tree), like the v1 view.
  const nameById = new Map(rows.map((r) => [r.categoryLedgerAccountId, r.categoryName]));
  const groupOf = (r: BudgetMonthRow) =>
    r.parentLedgerAccountId ? (nameById.get(r.parentLedgerAccountId) ?? '') : r.categoryName;
  const depthOf = (r: BudgetMonthRow) => (r.parentLedgerAccountId ? 1 : 0);
  const sorted = [...rows].sort(
    (a, b) =>
      groupOf(a).localeCompare(groupOf(b)) ||
      depthOf(a) - depthOf(b) ||
      a.categoryName.localeCompare(b.categoryName),
  );

  // Rebalance operates on amount targets (it proposes dollar figures). Percent
  // targets are steered by the total, so they are excluded from the dialog's
  // candidate set — passed as v1-shaped BudgetRows for its existing contract.
  const rebalanceRows = sorted
    .filter((r) => r.kind === 'amount')
    .map((r) => ({
      categoryLedgerAccountId: r.categoryLedgerAccountId,
      categoryName: r.categoryName,
      currency: r.currency,
      parentLedgerAccountId: r.parentLedgerAccountId,
      budgetMinor: r.resolvedMinor,
      rollover: r.rollover,
      spentMinor: r.spentMinor,
    }));

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
        <div className="flex items-center gap-2">
          {rebalanceRows.length > 0 ? (
            <RebalanceBudgetsDialog
              householdId={householdId}
              userId={userId}
              monthIso={monthIso}
              rows={rebalanceRows}
              totalMinor={plan.total.resolvedMinor}
              onDone={() => {
                void load();
              }}
            />
          ) : null}
          <AddBudgetCategoryPicker
            categories={addable}
            householdId={householdId}
            monthIso={monthIso}
            userId={userId}
            onAdded={() => {
              void load();
            }}
          />
        </div>
      </div>

      <BudgetPlanHeader
        plan={plan}
        householdId={householdId}
        userId={userId}
        monthIso={monthIso}
        onSaved={() => {
          void load();
        }}
      />

      {sorted.length === 0 ? (
        <EmptyState
          icon={<PiggyBank className="size-6" />}
          title="No budgets yet"
          description="Add a category to start budgeting — only the categories you pick appear here."
        />
      ) : (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Budgeted categories</h3>
          <div className="overflow-hidden rounded-lg border border-border">
            {sorted.map((r, i) => (
              <BudgetCategoryRow
                key={r.categoryLedgerAccountId}
                row={r}
                totalMinor={plan.total.resolvedMinor}
                first={i === 0}
                householdId={householdId}
                userId={userId}
                monthIso={monthIso}
                onSaved={() => {
                  void load();
                }}
              />
            ))}
          </div>
        </section>
      )}

      <EverythingElseLine spentMinor={BigInt(plan.everythingElseSpentMinor)} />
    </div>
  );
}

/**
 * Collapsed read-only summary of spend outside the budget (Monarch flex pattern).
 * Spent-only: no budget line, so no red is used (Law 8). The v4 read model gives
 * a single everythingElseSpentMinor total; the per-category breakdown lives in
 * the transactions view, so this line stays a calm one-liner.
 */
function EverythingElseLine({ spentMinor }: { spentMinor: bigint }) {
  const [open, setOpen] = useState(false);
  if (spentMinor === 0n) return null;
  return (
    <section className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-dashed border-border">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChevronDown
              className={`size-4 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
            />
            Everything else
          </span>
          <span className="text-sm text-muted-foreground">
            <Money amountMinor={spentMinor.toString()} className="text-foreground" /> spent
          </span>
        </button>
        {open ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Spend in categories you haven&apos;t budgeted. Add one above to start tracking it — or
            open Transactions to see the detail.
          </p>
        ) : null}
      </div>
    </section>
  );
}
