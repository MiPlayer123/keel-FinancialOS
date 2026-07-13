'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tags, Plus, Loader2, Pencil, Archive, CornerDownRight, Check, X, Landmark } from 'lucide-react';
import { toast } from 'sonner';

import { useHousehold } from '@/components/keel/household-context';
import {
  archiveCategory,
  createCategory,
  fetchCategories,
  renameCategory,
  reparentCategory,
  setCategoryTaxLine,
  type CategoryRow,
} from '@/lib/keel-api';
import { TAX_LINES, taxLineLabel } from '@/lib/tax-lines';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Category manager: create (optionally nested), rename, archive (with
 * optional reassignment), and one-level nesting — Quicken-style
 * categories-within-categories. System categories are renameable because
 * every backend join uses their stable pfc_key, never the name; the two
 * Uncategorized landing pads refuse archive server-side.
 */
export function CategoriesCard() {
  const { householdId } = useHousehold();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);

  const load = useCallback(async () => {
    if (!householdId) return;
    try {
      setCategories(await fetchCategories(householdId));
    } catch {
      setCategories([]);
    }
  }, [householdId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parents = useMemo(
    () => categories.filter((c) => c.kind === kind && !c.parentLedgerAccountId),
    [categories, kind],
  );

  if (!householdId) return null;

  async function add() {
    if (!householdId || name.trim().length === 0) return;
    setBusy(true);
    try {
      await createCategory({
        householdId,
        name: name.trim(),
        kind,
        parentLedgerAccountId: parentId,
      });
      toast.success(`Added ${name.trim()}. It's available in every picker now.`);
      setName('');
      setParentId(null);
      setAdding(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the category.');
    } finally {
      setBusy(false);
    }
  }

  const expense = categories.filter((c) => c.kind === 'expense');
  const income = categories.filter((c) => c.kind === 'income');
  const existingNames = new Set(categories.map((c) => c.name.toLowerCase()));
  const suggestions = SUGGESTED_CATEGORIES.filter(
    (s) => !existingNames.has(s.name.toLowerCase()),
  ).slice(0, 6);

  async function quickAdd(s: { name: string; kind: 'expense' | 'income' }) {
    if (!householdId) return;
    setBusy(true);
    try {
      await createCategory({ householdId, name: s.name, kind: s.kind });
      toast.success(`Added ${s.name}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the category.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="categories" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Tags className="size-4" />
            Categories
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setManaging((m) => !m);
            }}
          >
            {managing ? 'Done' : 'Manage'}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {managing ? (
          <div className="space-y-4">
            {expense.length > 0 ? (
              <CategoryManageList
                title="Spending"
                categories={expense}
                householdId={householdId}
                onChanged={() => {
                  void load();
                }}
              />
            ) : null}
            {income.length > 0 ? (
              <CategoryManageList
                title="Income"
                categories={income}
                householdId={householdId}
                onChanged={() => {
                  void load();
                }}
              />
            ) : null}
          </div>
        ) : categories.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {expense.map((c) => (
                <Badge key={c.ledgerAccountId} variant="secondary">
                  {c.parentLedgerAccountId ? (
                    <CornerDownRight className="size-3 opacity-60" />
                  ) : null}
                  {c.name}
                </Badge>
              ))}
            </div>
            {income.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {income.map((c) => (
                  <Badge key={c.ledgerAccountId} variant="outline">
                    {c.parentLedgerAccountId ? (
                      <CornerDownRight className="size-3 opacity-60" />
                    ) : null}
                    {c.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {adding ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="cat-name">Name</Label>
                <Input
                  id="cat-name"
                  value={name}
                  maxLength={80}
                  placeholder="e.g. Climbing, Pets, Side income"
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add();
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={kind}
                  items={{ expense: 'Spending', income: 'Income' }}
                  onValueChange={(v) => {
                    if (v) {
                      setKind(v);
                      setParentId(null);
                    }
                  }}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="expense">Spending</SelectItem>
                    <SelectItem value="income">Income</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Nest under</Label>
                <Select
                  value={parentId ?? 'none'}
                  items={{
                    none: 'Top level',
                    ...Object.fromEntries(parents.map((p) => [p.ledgerAccountId, p.name])),
                  }}
                  onValueChange={(v) => {
                    setParentId(v === 'none' ? null : v);
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Top level</SelectItem>
                    {parents.map((p) => (
                      <SelectItem key={p.ledgerAccountId} value={p.ledgerAccountId}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || name.trim().length === 0}
                onClick={() => {
                  void add();
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAdding(true);
              }}
            >
              <Plus className="size-4" />
              New category
            </Button>
            {suggestions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Ideas:</span>
                {suggestions.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    disabled={busy}
                    className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                    onClick={() => {
                      void quickAdd(s);
                    }}
                  >
                    + {s.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One-tap starters people actually use (taxes explicitly requested). */
const SUGGESTED_CATEGORIES: { name: string; kind: 'expense' | 'income' }[] = [
  { name: 'Taxes', kind: 'expense' },
  { name: 'Rent', kind: 'expense' },
  { name: 'Subscriptions', kind: 'expense' },
  { name: 'Gifts & Charity', kind: 'expense' },
  { name: 'Pets', kind: 'expense' },
  { name: 'Interest', kind: 'income' },
  { name: 'Tax Refund', kind: 'income' },
];

function CategoryManageList({
  title,
  categories,
  householdId,
  onChanged,
}: {
  title: string;
  categories: CategoryRow[];
  householdId: string;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="overflow-hidden rounded-md border border-border">
        {categories.map((c, i) => (
          <CategoryManageRow
            key={c.ledgerAccountId}
            category={c}
            siblings={categories}
            householdId={householdId}
            first={i === 0}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryManageRow({
  category,
  siblings,
  householdId,
  first,
  onChanged,
}: {
  category: CategoryRow;
  siblings: CategoryRow[];
  householdId: string;
  first: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'archive' | 'nest' | 'tax'>('idle');
  const [value, setValue] = useState(category.name);
  const [taxLine, setTaxLine] = useState<string | null>(category.taxLine ?? null);
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [nestUnder, setNestUnder] = useState<string | null>(
    category.parentLedgerAccountId ?? null,
  );
  const [busy, setBusy] = useState(false);

  const isLandingPad =
    category.pfcKey === 'uncategorized_expense' || category.pfcKey === 'uncategorized_income';
  const hasChildren = siblings.some(
    (s) => s.parentLedgerAccountId === category.ledgerAccountId,
  );
  const parentOptions = siblings.filter(
    (s) => !s.parentLedgerAccountId && s.ledgerAccountId !== category.ledgerAccountId,
  );
  const reassignOptions = siblings.filter(
    (s) => s.ledgerAccountId !== category.ledgerAccountId,
  );

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      setMode('idle');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'That change did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-2 px-3 py-2 ${first ? '' : 'border-t border-border'}`}
    >
      <span
        className={`flex min-w-0 flex-1 items-center gap-1.5 text-sm ${
          category.parentLedgerAccountId ? 'pl-4' : ''
        }`}
      >
        {category.parentLedgerAccountId ? (
          <CornerDownRight className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        {mode === 'rename' ? (
          <Input
            value={value}
            maxLength={80}
            className="h-7"
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) {
                void run(
                  () =>
                    renameCategory({
                      householdId,
                      categoryLedgerAccountId: category.ledgerAccountId,
                      name: value.trim(),
                    }),
                  'Renamed.',
                );
              }
              if (e.key === 'Escape') setMode('idle');
            }}
          />
        ) : (
          <span className="truncate">{category.name}</span>
        )}
        {category.isSystem && mode === 'idle' ? (
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            System
          </Badge>
        ) : null}
        {category.taxLine && mode === 'idle' ? (
          <Badge variant="outline" className="shrink-0 text-[10px]" title="Tax line">
            {taxLineLabel(category.taxLine)}
          </Badge>
        ) : null}
      </span>

      {mode === 'idle' ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${category.name}`}
            onClick={() => {
              setValue(category.name);
              setMode('rename');
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
          {!hasChildren ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Nest ${category.name}`}
              onClick={() => {
                setNestUnder(category.parentLedgerAccountId ?? null);
                setMode('nest');
              }}
            >
              <CornerDownRight className="size-3.5" />
            </Button>
          ) : null}
          {!isLandingPad ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Tax line for ${category.name}`}
              title="Tax line"
              onClick={() => {
                setTaxLine(category.taxLine ?? null);
                setMode('tax');
              }}
            >
              <Landmark className="size-3.5" />
            </Button>
          ) : null}
          {!isLandingPad && !hasChildren ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${category.name}`}
              onClick={() => {
                setReassignTo(null);
                setMode('archive');
              }}
            >
              <Archive className="size-3.5" />
            </Button>
          ) : null}
        </span>
      ) : mode === 'rename' ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Save name"
            disabled={busy || value.trim().length === 0}
            onClick={() => {
              void run(
                () =>
                  renameCategory({
                    householdId,
                    categoryLedgerAccountId: category.ledgerAccountId,
                    name: value.trim(),
                  }),
                'Renamed.',
              );
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel rename"
            disabled={busy}
            onClick={() => {
              setMode('idle');
            }}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : mode === 'nest' ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Select
            value={nestUnder ?? 'none'}
            items={{
              none: 'Top level',
              ...Object.fromEntries(parentOptions.map((p) => [p.ledgerAccountId, p.name])),
            }}
            onValueChange={(v) => {
              setNestUnder(v === 'none' ? null : v);
            }}
          >
            <SelectTrigger className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Top level</SelectItem>
              {parentOptions.map((p) => (
                <SelectItem key={p.ledgerAccountId} value={p.ledgerAccountId}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Save nesting"
            disabled={busy}
            onClick={() => {
              void run(
                () =>
                  reparentCategory({
                    householdId,
                    categoryLedgerAccountId: category.ledgerAccountId,
                    parentLedgerAccountId: nestUnder,
                  }),
                'Moved.',
              );
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel nesting"
            disabled={busy}
            onClick={() => {
              setMode('idle');
            }}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : mode === 'tax' ? (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Tax line</span>
          <Select
            value={taxLine ?? 'none'}
            items={{
              none: 'Not tax-related',
              ...Object.fromEntries(TAX_LINES.map((t) => [t.value, t.label])),
            }}
            onValueChange={(v) => {
              setTaxLine(v === 'none' ? null : v);
            }}
          >
            <SelectTrigger className="h-7 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not tax-related</SelectItem>
              {TAX_LINES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Save tax line"
            disabled={busy}
            onClick={() => {
              void run(
                () =>
                  setCategoryTaxLine({
                    householdId,
                    categoryLedgerAccountId: category.ledgerAccountId,
                    taxLine,
                  }),
                taxLine
                  ? 'Mapped — it shows on the tax schedule now.'
                  : 'Cleared from the tax schedule.',
              );
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel tax line"
            disabled={busy}
            onClick={() => {
              setMode('idle');
            }}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : (
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Move existing to</span>
          <Select
            value={reassignTo ?? 'none'}
            items={{
              none: 'Leave in place',
              ...Object.fromEntries(reassignOptions.map((p) => [p.ledgerAccountId, p.name])),
            }}
            onValueChange={(v) => {
              setReassignTo(v === 'none' ? null : v);
            }}
          >
            <SelectTrigger className="h-7 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Leave in place</SelectItem>
              {reassignOptions.map((p) => (
                <SelectItem key={p.ledgerAccountId} value={p.ledgerAccountId}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Confirm archive"
            disabled={busy}
            onClick={() => {
              void run(
                () =>
                  archiveCategory({
                    householdId,
                    categoryLedgerAccountId: category.ledgerAccountId,
                    reassignTo,
                  }),
                'Archived — history is untouched, the name just leaves the pickers.',
              );
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel archive"
            disabled={busy}
            onClick={() => {
              setMode('idle');
            }}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      )}
    </div>
  );
}
