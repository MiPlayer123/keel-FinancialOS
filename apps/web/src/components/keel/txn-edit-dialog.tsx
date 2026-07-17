'use client';

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from 'react';
import {
  ArrowLeftRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Split,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  assignTag,
  createCategory,
  saveTag,
  overrideTransaction,
  setTransactionSplits,
  voidManualTransaction,
  type CategoryRow,
  type RichTransactionRow,
  type TagRow,
} from '@/lib/keel-api';
import {
  buildSplitsPayload,
  hasDuplicateCategories,
  seedRowsForNewSplit,
  seedRowsFromSplits,
  splitRemainderMinor,
  splitsReady,
  type SplitDraftRow,
} from '@/lib/split-editor';
import {
  groupForPicker,
  hasExactName,
  inferKindFromAmount,
  parseRecents,
  pushRecent,
  recentCategoriesKey,
} from '@/lib/category-picker';
import { maskAccountLabel } from '@/lib/account-label';
import { merchantDisplayName } from '@/lib/merchant-name';
import { shortDateWithYear } from '@/lib/relative-date';
import { isUncategorized } from '@/lib/needs-attention';
import { isAutoCategorized } from '@/lib/review-state';
import { useHousehold } from '@/components/keel/household-context';
import { Money } from '@/components/keel/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';

// Single definition now lives in lib (Home's "Needs attention" module counts
// with it too); re-exported here so existing consumers keep their import path.
export { isUncategorized } from '@/lib/needs-attention';

export type ListCallbacks = {
  onRecategorize: (txnId: string, categoryId: string) => void;
  onEdit: (row: RichTransactionRow) => void;
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
};

export function TxnList({
  rows,
  categories,
  bordered,
  running,
  onRecategorize,
  onEdit,
  selecting,
  selected,
  onToggle,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  bordered?: boolean;
  /** Optional Quicken-style running balance per transactionId (register view). */
  running?: Map<string, string>;
} & ListCallbacks) {
  return (
    <div
      className={
        bordered
          ? 'border-t border-border'
          : 'overflow-hidden rounded-lg border border-border'
      }
    >
      {rows.map((t, i) => (
        <div
          // Index suffix: category-grouped split fanning can place two shares
          // of one transaction (or same-named categories) in one list.
          key={`${t.transactionId}:${String(i)}`}
          className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
        >
          {selecting ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected.has(t.transactionId)}
              aria-label="Select transaction"
              className={`flex size-5 shrink-0 items-center justify-center rounded border ${
                selected.has(t.transactionId)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border'
              }`}
              onClick={() => {
                onToggle(t.transactionId);
              }}
            >
              {selected.has(t.transactionId) ? <Check className="size-3.5" /> : null}
            </button>
          ) : null}
          <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
            {shortDateWithYear(t.effectiveDate)}
          </span>
          {/* min-w-0 + truncate: the description can never push into the
              category picker or the amount, no matter how long the memo is. */}
          <button
            type="button"
            className="min-w-0 flex-1 rounded-sm text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              if (selecting) onToggle(t.transactionId);
              else onEdit(t);
            }}
          >
            {/* Cleaned name for display only; the raw memo stays one hover
                away (Law 9 explicit ownership — inference never silently
                replaces the source string). */}
            <p className="truncate text-sm font-medium" title={t.description}>
              {merchantDisplayName(t.description)}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {maskAccountLabel(t.accountName, t.accountMask)}
              {/* The picker is hidden below sm — keep the category (and its
                  reviewed state) visible without it. */}
              {t.categoryName ? (
                <span className="sm:hidden">
                  {' '}
                  · {t.categoryName}
                  {isAutoCategorized(t) ? ' · Auto' : ''}
                </span>
              ) : null}
            </p>
            {/* Note/tags get their OWN line rather than trailing the account
                line above: that line already truncates as a single unit, so a
                long account/category combo silently swallowed the note+tag
                content behind the ellipsis with nothing ever visible
                (review feedback: "even a little overflow" should still show
                something). A dedicated line means these only compete with
                each other, never with the account name. */}
            {t.note || (t.tags?.length ?? 0) > 0 ? (
              <p className="flex items-center gap-1.5 overflow-hidden text-xs text-muted-foreground/80">
                {/* Review r3605876939: neither group is allowed a fixed/natural
                    width anymore — both can shrink and clip on their own, and
                    the row itself clips as a backstop, so a long note AND long
                    tag names can never bleed into the amount/category columns
                    on narrow rows (mobile, or the account page with the 22rem
                    detail panel open). */}
                {t.note ? (
                  <span className="flex min-w-0 shrink items-center gap-1">
                    <StickyNote className="size-3 shrink-0 align-[-1px]" aria-label="Note" />
                    <span className="truncate">
                      {t.note.length > 40 ? `${t.note.slice(0, 40)}…` : t.note}
                    </span>
                  </span>
                ) : null}
                {(t.tags ?? []).length > 0 ? (
                  <span className="flex min-w-0 shrink items-center gap-1 truncate">
                    {(t.tags ?? []).slice(0, 2).map((x) => (
                      <span key={x.tagId} className="shrink-0">#{x.name}</span>
                    ))}
                    {(t.tags?.length ?? 0) > 2 ? (
                      <span className="shrink-0 text-muted-foreground/60">
                        +{String((t.tags?.length ?? 0) - 2)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </p>
            ) : null}
          </button>
          {t.transferStatus === 'confirmed' ? (
            <Badge
              variant="secondary"
              className="hidden max-w-40 shrink-0 gap-1 sm:inline-flex"
              title={
                t.counterpartyAccountName
                  ? `Transfer ${BigInt(t.amountMinor) < 0n ? 'to' : 'from'} ${t.counterpartyAccountName}`
                  : 'Transfer'
              }
            >
              <ArrowLeftRight className="size-3 shrink-0" />
              <span className="truncate">
                Transfer
                {t.counterpartyAccountName
                  ? ` ${BigInt(t.amountMinor) < 0n ? '→' : '←'} ${t.counterpartyAccountName}`
                  : ''}
              </span>
            </Badge>
          ) : t.splits && t.splits.length > 0 ? (
            <Badge
              variant="secondary"
              className="hidden shrink-0 gap-1 sm:inline-flex"
              title={t.splits.map((s) => s.name).join(' · ')}
            >
              <Split className="size-3" />
              Split · {t.splits.length}
            </Badge>
          ) : (
            <CategoryPicker
              row={t}
              categories={categories}
              auto={isAutoCategorized(t)}
              onPick={(catId) => {
                onRecategorize(t.transactionId, catId);
              }}
            />
          )}
          <div className="flex shrink-0 items-center justify-end gap-2">
            {t.status === 'pending' ? (
              <Badge variant="outline" className="hidden text-[10px] uppercase sm:inline-flex">
                Pending
              </Badge>
            ) : null}
            {/* Reconciled chip (D-047, "Statements moat"): adjacent to the
                amount it qualifies (Law 8). Absence is the common case and
                carries no chip — only the positive "matched a statement"
                fact renders, same hides-at-absence convention as Needs
                attention. Neutral outline, no color semantics: reconciled
                is a provenance fact, not a judgment on the money itself. */}
            {t.reconciled ? (
              <Badge
                variant="outline"
                className="hidden gap-1 text-[10px] uppercase sm:inline-flex"
                title="Matched to a bank statement during reconciliation"
              >
                <CheckCircle2 className="size-3" />
                Reconciled
              </Badge>
            ) : null}
            <Money
              amountMinor={t.amountMinor}
              currency={t.currency}
              signed
              className="min-w-24 text-right text-sm tabular-nums"
            />
            {running?.has(t.transactionId) ? (
              <Money
                amountMinor={running.get(t.transactionId) ?? '0'}
                currency={t.currency}
                className="hidden min-w-24 text-right text-xs text-muted-foreground lg:inline"
              />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${t.description}`}
              title="Edit — rename, note, tags"
              className="hidden text-muted-foreground/60 hover:text-foreground sm:inline-flex"
              onClick={() => {
                if (selecting) onToggle(t.transactionId);
                else onEdit(t);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Category picker (teardown C4): cmdk typeahead over a popover — Recent
 * group, Income/Expense groups with one-level parent>child indentation, and
 * inline create when the query matches nothing. Commit on select only: the
 * trigger always shows the CURRENT category; arrowing over options changes
 * nothing until Enter/click. Inline create is a user-initiated direct action
 * (class-none — suggest→approve does not apply; Law 2 governs AI writes).
 */
export function CategoryPicker({
  row,
  categories,
  onPick,
  wide,
  createEntityId,
  auto,
}: {
  row: RichTransactionRow;
  categories: CategoryRow[];
  onPick: (categoryLedgerAccountId: string, categoryName?: string) => void;
  /** Full-width dialog variant; default is the compact ledger-row trigger. */
  wide?: boolean;
  /**
   * Pin inline-create to THIS entity. Split rows must pass the transaction's
   * entity (code review r3603509625): a blank row has no current category to
   * infer from, and the options[0] fallback can land on the WRONG entity in a
   * multi-entity household — the server would then reject the save against
   * the category the user just created.
   */
  createEntityId?: string | null;
  /**
   * P0-B follow-up: a small neutral "Auto" pill inside the SAME trigger a
   * click already opens — the badge is reversible by construction (picking
   * any category here, even the one already showing, re-files it with
   * source='user' via keel_categorize_transaction). Never red/green (Law 8):
   * this is provenance, not a verdict.
   */
  auto?: boolean;
}) {
  const { householdId } = useHousehold();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [createKind, setCreateKind] = useState<'income' | 'expense'>('expense');
  const [creating, setCreating] = useState(false);
  // Categories created inline, merged in so a new one is pickable (and its
  // name resolvable) immediately, before the parent refetches categories.
  const [created, setCreated] = useState<CategoryRow[]>([]);

  const merged = useMemo(() => {
    const known = new Set(categories.map((c) => c.ledgerAccountId));
    return [...categories, ...created.filter((c) => !known.has(c.ledgerAccountId))];
  }, [categories, created]);

  // Only offer categories matching the transaction's direction (income/expense).
  const options = useMemo(
    () => merged.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true)),
    [merged, row.categoryKind],
  );
  const groups = useMemo(
    () => groupForPicker(merged, query, row.categoryKind ?? null),
    [merged, query, row.categoryKind],
  );
  const recentOptions = useMemo(
    () =>
      recents
        .map((id) => options.find((c) => c.ledgerAccountId === id))
        .filter((c): c is CategoryRow => c !== undefined),
    [recents, options],
  );

  const label = row.categoryName ?? 'Uncategorized';
  const isDefault = isUncategorized(row);
  const currentId = row.categoryLedgerAccountId;
  const trimmed = query.trim();
  // Duplicate check spans both kinds — a same-named category in the other
  // kind would collide on the household-unique name anyway.
  const canCreate =
    householdId !== null &&
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !hasExactName(merged, trimmed, null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    setQuery('');
    // Kind for inline create: the transaction's sign (explicit toggle below).
    setCreateKind(row.categoryKind ?? inferKindFromAmount(row.amountMinor));
    setRecents(
      householdId
        ? parseRecents(window.localStorage.getItem(recentCategoriesKey(householdId)))
        : [],
    );
  }

  // The ONLY commit path: close, remember, notify. Highlight never commits.
  function commit(c: CategoryRow) {
    setOpen(false);
    if (householdId) {
      const key = recentCategoriesKey(householdId);
      window.localStorage.setItem(
        key,
        JSON.stringify(
          pushRecent(parseRecents(window.localStorage.getItem(key)), c.ledgerAccountId),
        ),
      );
    }
    // `auto` rows must fire onPick even when the picked category IS the
    // currently-displayed one (review r3604432435): confirming an
    // auto-categorized row is exactly "pick the same category" from the
    // user's perspective, and that has to actually re-file it with
    // source='user' (clearing the Auto badge) — the no-op suppression below
    // exists for the ordinary trigger, where re-picking the current value is
    // truly a no-op with nothing to confirm.
    if (auto || c.ledgerAccountId !== currentId) onPick(c.ledgerAccountId, c.name);
  }

  async function createAndPick() {
    if (!householdId || creating) return;
    const name = trimmed;
    if (name.length === 0) return;
    setCreating(true);
    try {
      // Same-entity scope: an explicit caller pin wins (split rows pass the
      // transaction's entity); else the current category pins the entity;
      // else the eligible list's entity; null lets the server use its default.
      const entityId =
        createEntityId ??
        merged.find((c) => c.ledgerAccountId === currentId)?.entityId ??
        options[0]?.entityId ??
        null;
      const res = await createCategory({ householdId, name, kind: createKind, entityId });
      if (typeof res.ledgerAccountId === 'string') {
        const newCat: CategoryRow = {
          ledgerAccountId: res.ledgerAccountId,
          name,
          kind: createKind,
          entityId: entityId ?? '',
          parentLedgerAccountId: null,
        };
        setCreated((prev) => [...prev, newCat]);
        toast.success(`Added ${name}. It's available in every picker now.`);
        commit(newCat);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the category.');
    } finally {
      setCreating(false);
    }
  }

  // Degraded pre-migration state: nothing to pick and no household to create
  // under — show the label, same as the old read-only fallback.
  if (options.length === 0 && !householdId) {
    return (
      <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
        {label}
      </Badge>
    );
  }

  const triggerBase =
    'items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50';

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal="trap-focus">
      <PopoverTrigger
        title={`Category: ${label}`}
        className={
          wide
            ? `flex h-8 w-full ${triggerBase} ${isDefault ? 'text-muted-foreground' : ''}`
            : `hidden h-7 w-40 shrink-0 border-dashed sm:flex ${triggerBase} ${
                isDefault ? 'text-muted-foreground' : ''
              }`
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {auto ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[10px] uppercase"
              title="Auto-categorized — a rule or the bank's own category, not yet confirmed by you. Click to confirm or change."
            >
              Auto
            </Badge>
          ) : null}
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align={wide ? 'start' : 'end'}
        className={`p-0 ${wide ? 'w-(--anchor-width) min-w-56' : 'w-72 max-w-[calc(100vw-2rem)]'}`}
      >
        {/* Manual filtering (shouldFilter=false): matching is the tested
            case/diacritic-insensitive helper, not cmdk's fuzzy scorer. */}
        <Command shouldFilter={false} className="rounded-lg!">
          <CommandInput
            placeholder="Search or create…"
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
          <CommandList>
            {groups.length === 0 && !canCreate ? (
              <CommandEmpty>No matching category.</CommandEmpty>
            ) : null}
            {trimmed.length === 0 && recentOptions.length > 0 ? (
              <CommandGroup heading="Recent">
                {recentOptions.map((c) => (
                  <CommandItem
                    key={`recent-${c.ledgerAccountId}`}
                    value={`recent:${c.ledgerAccountId}`}
                    data-checked={c.ledgerAccountId === currentId}
                    onSelect={() => {
                      commit(c);
                    }}
                  >
                    <span className="truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {groups.map((g) => (
              <CommandGroup key={g.kind} heading={g.label}>
                {g.entries.map(({ row: c, depth }) => (
                  <CommandItem
                    key={c.ledgerAccountId}
                    value={`cat:${c.ledgerAccountId}`}
                    data-checked={c.ledgerAccountId === currentId}
                    onSelect={() => {
                      commit(c);
                    }}
                  >
                    <span className={depth === 1 ? 'truncate pl-3' : 'truncate'}>
                      {c.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {canCreate ? (
              <CommandGroup heading="New category">
                <CommandItem
                  value={`create:${trimmed}`}
                  disabled={creating}
                  onSelect={() => {
                    void createAndPick();
                  }}
                >
                  {creating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  {/* Raw query rendered verbatim as text — data-tier (Law 5). */}
                  <span className="truncate">Create &ldquo;{trimmed}&rdquo;</span>
                </CommandItem>
                <div className="flex items-center gap-1.5 px-2 pt-0.5 pb-1.5">
                  <span className="text-xs text-muted-foreground">as</span>
                  {(['expense', 'income'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={createKind === k}
                      className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        createKind === k
                          ? 'border-foreground/40 bg-secondary text-foreground'
                          : 'border-dashed border-border text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() => {
                        setCreateKind(k);
                      }}
                    >
                      {k === 'expense' ? 'Expense' : 'Income'}
                    </button>
                  ))}
                </div>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Edit the user-facing name + note for a transaction. Presentation overlay
 * only: the provider's original description is immutable and stays visible.
 * Also hosts the category picker (on mobile it's the only recategorize path).
 */
export type TxnEditFormHandle = {
  /**
   * Flushes any pending tag write to the parent (list refetch) and then
   * calls onClose. Every dismiss path funnels here: the Cancel button, the
   * "See everything from this merchant" link, TxnEditDialog's own Escape/
   * overlay/× (via its formRef), and — new in the master-detail slice
   * (teardown C6) — the ledger page's "select a different transaction while
   * the desktop panel is already open" path, so switching rows without an
   * intermediate close can never strand a stale tag list behind.
   */
  requestClose: () => void;
};

type TxnEditFormProps = {
  row: RichTransactionRow;
  householdId: string | null;
  userId: string | null;
  categories: CategoryRow[];
  allTags: TagRow[];
  onTagsMutated: () => void;
  onClose: () => void;
  /**
   * Called with the transactionId that just saved/voided/split — NOT a bare
   * signal — so a caller hosting more than one row over this form's lifetime
   * (the master-detail panel; teardown C6 review finding) can tell a stale
   * completion from row A apart from the row currently open, and ignore it
   * instead of yanking the panel out from under row B's in-progress draft.
   */
  onSaved: (txnId: string) => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
  onMerchantSearch: (description: string) => void;
  ref?: Ref<TxnEditFormHandle>;
};

/**
 * All the field-rendering + editing logic for one transaction — name,
 * splits, transfer info, category picker, tags, note, void — factored out
 * of the modal (teardown C6 residual: the master-detail panel) so the exact
 * same logic can be hosted by two shells: TxnEditDialog's existing mobile/
 * narrow modal (behavior unchanged) and the new desktop TxnDetailPanel
 * below. Neither shell reimplements any editing behavior; they only supply
 * chrome (header/footer container) around this one component.
 */
function TxnEditForm({
  row,
  householdId,
  userId,
  categories,
  allTags,
  onTagsMutated,
  onClose,
  onSaved,
  onRecategorize,
  onMerchantSearch,
  ref,
}: TxnEditFormProps) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
  // Category picked in THIS dialog session. The row prop keeps the pre-change
  // category until close, so old→new stays visible (teardown C4: the change
  // you just made is legible, not silent).
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  // Split editor rows (teardown C7): null = not splitting (single-category
  // picker shown); non-null = editable rows whose "Left to split" remainder
  // must reach exactly 0 before Save splits enables (Law 3 made visible).
  const [splitRows, setSplitRows] = useState<SplitDraftRow[] | null>(null);
  const [splitBusy, setSplitBusy] = useState(false);
  // One idempotency key per dialog session: a retry after a timeout REPLAYS
  // the same revision instead of double-revising (invariant 3).
  const [splitAttemptKey, setSplitAttemptKey] = useState(() => crypto.randomUUID());
  // Optimistic tag state for THIS row; parent data refreshes on close.
  const [rowTags, setRowTags] = useState<{ tagId: string; name: string }[]>([]);
  const [createdTags, setCreatedTags] = useState<TagRow[]>([]);
  const [newTag, setNewTag] = useState('');
  const [tagsDirty, setTagsDirty] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  // Latest in-flight tag write; the close-flush waits on it so a refetch can't
  // race a write that hasn't committed yet. tagBusy serializes writes, so one
  // slot is enough.
  const pendingTagWrite = useRef<Promise<unknown> | null>(null);

  // Every close path funnels here: tag writes commit immediately, so the parent
  // must refresh even on "Cancel" — nothing is discarded.
  function flushTagsAndClose() {
    if (tagsDirty) {
      const pending = pendingTagWrite.current;
      if (pending) {
        void pending.finally(() => {
          onTagsMutated();
        });
      } else {
        onTagsMutated();
      }
    }
    onClose();
  }

  // Recomputed every render (no deps array) so it always closes over the
  // latest flushTagsAndClose — the only thing external callers ever need.
  useImperativeHandle(ref, () => ({ requestClose: flushTagsAndClose }));

  useEffect(() => {
    setName(row.description);
    setNote(row.note ?? '');
    setVoiding(false);
    setPicked(null);
    // Multi-split rows open straight into the editor, seeded from the real
    // postings; single-category rows start in picker mode with a "Split…"
    // affordance.
    setSplitRows(row.splits && row.splits.length > 0 ? seedRowsFromSplits(row.splits) : null);
    setSplitBusy(false);
    setSplitAttemptKey(crypto.randomUUID());
    setRowTags(row.tags ?? []);
    setCreatedTags([]);
    setNewTag('');
    setTagsDirty(false);
  }, [row]);

  async function toggleTag(tag: { tagId: string; name: string }) {
    if (!householdId) return;
    const assigned = !rowTags.some((x) => x.tagId === tag.tagId);
    const prev = rowTags;
    setRowTags(assigned ? [...prev, tag] : prev.filter((x) => x.tagId !== tag.tagId));
    setTagsDirty(true);
    setTagBusy(true);
    try {
      const write = assignTag({
        householdId,
        transactionId: row.transactionId,
        tagId: tag.tagId,
        assigned,
      });
      pendingTagWrite.current = write;
      await write;
    } catch (err) {
      setRowTags(prev);
      toast.error(err instanceof Error ? err.message : 'Could not update the tag.');
    } finally {
      setTagBusy(false);
    }
  }

  async function createAndAssignTag() {
    if (!householdId || tagBusy) return;
    const trimmed = newTag.trim();
    if (trimmed.length === 0) return;
    // Typing an existing tag's name assigns it instead of erroring on the
    // household-unique index.
    const existing = [...allTags, ...createdTags].find(
      (t) => t.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) {
      setNewTag('');
      if (!rowTags.some((x) => x.tagId === existing.tagId)) {
        await toggleTag({ tagId: existing.tagId, name: existing.name });
      }
      return;
    }
    setTagBusy(true);
    try {
      const res = await saveTag({ householdId, name: trimmed });
      if (typeof res.tagId === 'string') {
        const tag = { tagId: res.tagId, name: trimmed };
        // The tag exists server-side from here on, even if the assign fails.
        setTagsDirty(true);
        setCreatedTags((prevTags) => [...prevTags, { ...tag, usageCount: 1 }]);
        const write = assignTag({
          householdId,
          transactionId: row.transactionId,
          tagId: tag.tagId,
          assigned: true,
        });
        pendingTagWrite.current = write;
        await write;
        setRowTags((prevTags) => [...prevTags, tag]);
        setNewTag('');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the tag.');
    } finally {
      setTagBusy(false);
    }
  }

  async function voidTxn() {
    if (!householdId || !userId) return;
    setSaving(true);
    try {
      await voidManualTransaction({
        householdId,
        userId,
        transactionId: row.transactionId,
        reason: 'Voided from ledger',
      });
      toast.success('Transaction voided — the reversal is on the books, nothing deleted.');
      onSaved(row.transactionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not void the transaction.');
    } finally {
      setSaving(false);
    }
  }

  const original = row.originalDescription ?? row.description;
  const categoryOptions = useMemo(
    () => categories.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true)),
    [categories, row],
  );

  // Split direction follows the cash sign (expense = money out); every split
  // row offers categories of that one kind, same as manual entry.
  const splitKind: 'income' | 'expense' = row.categoryKind ?? inferKindFromAmount(row.amountMinor);

  // The transaction's entity, derived from its current classification (the
  // rich read model carries no entityId): the single-offset category or any
  // existing split's category resolves it through the categories list. Split
  // rows pass this into the picker so inline-create pins to the RIGHT entity
  // even from a blank row (code review r3603509625).
  const txnEntityId = useMemo(() => {
    const candidateIds = [
      row.categoryLedgerAccountId,
      ...(row.splits ?? []).map((s) => s.categoryLedgerAccountId),
    ];
    for (const id of candidateIds) {
      if (id === null) continue;
      const entityId = categories.find((c) => c.ledgerAccountId === id)?.entityId;
      if (entityId) return entityId;
    }
    return null;
  }, [row, categories]);
  const splitRemainder = splitRows ? splitRemainderMinor(row.amountMinor, splitRows) : '0';
  const splitSaveReady = splitRows !== null && splitsReady(row.amountMinor, splitRows);
  const isExistingSplit = (row.splits?.length ?? 0) > 0;

  function splitCategoryName(categoryId: string | null): string | null {
    if (categoryId === null) return null;
    return (
      categories.find((c) => c.ledgerAccountId === categoryId)?.name ??
      row.splits?.find((s) => s.categoryLedgerAccountId === categoryId)?.name ??
      null
    );
  }

  function setSplitRowAt(i: number, patch: Partial<SplitDraftRow>) {
    setSplitRows((prev) =>
      prev ? prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) : prev,
    );
  }

  async function saveSplits() {
    if (!householdId || !userId || !splitRows) return;
    // BigInt on integer strings end to end — the payload only exists when the
    // remainder is exactly 0 (Law 3/4; the server re-verifies Σ=0 either way).
    const payload = buildSplitsPayload(row.amountMinor, splitRows);
    if (!payload) return;
    setSplitBusy(true);
    try {
      await setTransactionSplits({
        householdId,
        userId,
        transactionId: row.transactionId,
        amountMinor: row.amountMinor,
        splits: payload,
        attemptKey: splitAttemptKey,
      });
      toast.success(
        payload.length > 1
          ? `Split across ${String(payload.length)} categories — the original entry stays on the books.`
          : 'Back to a single category — the split was reversed, not erased.',
      );
      onSaved(row.transactionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the splits.');
    } finally {
      setSplitBusy(false);
    }
  }

  async function save() {
    if (!householdId) return;
    setSaving(true);
    try {
      await overrideTransaction({
        householdId,
        transactionId: row.transactionId,
        // Saving the unchanged original name means "no override".
        displayDescription: name.trim() === original ? '' : name,
        note,
      });
      toast.success('Transaction updated.');
      onSaved(row.transactionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="truncate text-muted-foreground" title={original}>
            {original}
          </span>
          <Money amountMinor={row.amountMinor} currency={row.currency} signed />
        </div>
        {/* Account (+ last-4) and status, adjacent to the amount they
                qualify (Law 8). Status chip mirrors the ledger row's
                hides-at-absence convention (Auto/Reconciled precedent):
                'posted' is the overwhelming common case and renders nothing;
                only the exceptional 'pending' state earns a chip. */}
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate">{maskAccountLabel(row.accountName, row.accountMask)}</span>
          {row.status === 'pending' ? (
            <Badge variant="outline" className="shrink-0 gap-1 text-[10px] uppercase">
              Pending
            </Badge>
          ) : null}
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            flushTagsAndClose();
            // Renamed rows keep matching their siblings via the bank's
            // original description.
            onMerchantSearch(row.originalDescription ?? row.description);
          }}
        >
          See everything from this merchant
        </button>
        <div className="space-y-1.5">
          <Label htmlFor="txn-name">Name</Label>
          <Input
            id="txn-name"
            value={name}
            maxLength={140}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        {splitRows !== null && row.transferStatus !== 'confirmed' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Splits</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={splitBusy || splitRows.length >= 30}
                onClick={() => {
                  setSplitRows((prev) =>
                    prev ? [...prev, { categoryId: null, amount: '' }] : prev,
                  );
                }}
              >
                <Plus className="size-3.5" />
                Add split
              </Button>
            </div>
            {/* 390px: each row stacks category over amount; sm+ is one line. */}
            {splitRows.map((s, i) => (
              <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <CategoryPicker
                    row={{
                      ...row,
                      categoryLedgerAccountId: s.categoryId,
                      categoryName: splitCategoryName(s.categoryId) ?? 'Pick category',
                      categoryKind: splitKind,
                      splits: null,
                    }}
                    categories={categories}
                    wide
                    createEntityId={txnEntityId}
                    onPick={(catId) => {
                      setSplitRowAt(i, { categoryId: catId });
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    inputMode="decimal"
                    placeholder="0.00"
                    className="h-8 flex-1 text-right tabular-nums sm:w-28 sm:flex-none"
                    aria-label={`Split ${String(i + 1)} amount`}
                    value={s.amount}
                    onChange={(e) => {
                      setSplitRowAt(i, { amount: e.target.value });
                    }}
                  />
                  {splitRows.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove split ${String(i + 1)}`}
                      disabled={splitBusy}
                      onClick={() => {
                        setSplitRows((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {/* Σ=0 as UI: the remainder must land exactly on zero. Sticky so
                    it stays visible at 390px while the rows scroll. Red only
                    when negative (over-allocated) — Law 8. */}
            <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
              <span className="text-sm text-muted-foreground">Left to split</span>
              <Money
                amountMinor={splitRemainder}
                currency={row.currency}
                signed
                className="text-sm"
              />
            </div>
            {hasDuplicateCategories(splitRows) ? (
              <p className="text-xs text-muted-foreground">
                Each category can appear only once — merge the amounts.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {!isExistingSplit ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setSplitRows(null);
                  }}
                >
                  Cancel split
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Splits are the categorization — saved as real ledger postings.
                </span>
              )}
              <Button
                type="button"
                size="sm"
                disabled={splitBusy || !splitSaveReady}
                onClick={() => {
                  void saveSplits();
                }}
              >
                {splitBusy ? <Loader2 className="size-4 animate-spin" /> : null}
                Save splits
              </Button>
            </div>
          </div>
        ) : null}
        {row.transferStatus === 'confirmed' ? (
          <div className="space-y-1.5">
            <Label>Transfer</Label>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {BigInt(row.amountMinor) < 0n ? 'To ' : 'From '}
                {row.counterpartyAccountName ?? 'another account'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Confirmed as a transfer on the Review page — excluded from income/expense totals. Not
              editable here.
            </p>
          </div>
        ) : null}
        {row.transferStatus !== 'confirmed' && splitRows === null && categoryOptions.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Category</Label>
              {/* Teardown C7: every competitor has this. Expands into two
                      rows with the full amount seeded on row 1. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setSplitRows(
                    seedRowsForNewSplit(row.amountMinor, picked?.id ?? row.categoryLedgerAccountId),
                  );
                }}
              >
                <Split className="size-3.5" />
                Split…
              </Button>
            </div>
            <CategoryPicker
              // Overlay the in-dialog pick so the trigger shows the NEW
              // category while the strike-through below keeps the old one.
              row={
                picked
                  ? { ...row, categoryLedgerAccountId: picked.id, categoryName: picked.name }
                  : row
              }
              categories={categories}
              wide
              // Once picked in THIS session the badge would be stale —
              // saving always writes source='user' regardless of pick.
              auto={!picked && isAutoCategorized(row)}
              onPick={(catId, catName) => {
                setPicked({
                  id: catId,
                  name:
                    catName ??
                    categories.find((c) => c.ledgerAccountId === catId)?.name ??
                    'Updated',
                });
                onRecategorize(row.transactionId, catId);
              }}
            />
            {picked && picked.id !== row.categoryLedgerAccountId ? (
              <p className="text-xs text-muted-foreground">
                <span className="line-through">{row.categoryName ?? 'Uncategorized'}</span>
                <span aria-hidden="true"> → </span>
                <span className="text-foreground">{picked.name}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>Tags</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              ...allTags,
              ...createdTags.filter((c) => !allTags.some((a) => a.tagId === c.tagId)),
            ].map((t) => {
              const active = rowTags.some((x) => x.tagId === t.tagId);
              return (
                <button
                  key={t.tagId}
                  type="button"
                  disabled={tagBusy}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? 'border-foreground/40 bg-secondary text-foreground'
                      : 'border-dashed border-border text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => {
                    void toggleTag({ tagId: t.tagId, name: t.name });
                  }}
                >
                  #{t.name}
                </button>
              );
            })}
            <Input
              className="h-7 w-28 text-xs"
              placeholder="New tag"
              maxLength={40}
              value={newTag}
              onChange={(e) => {
                setNewTag(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createAndAssignTag();
              }}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="txn-note">Note</Label>
          <Textarea
            id="txn-note"
            value={note}
            maxLength={2000}
            rows={3}
            placeholder="Anything worth remembering about this transaction"
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
        </div>
      </div>
      <DialogFooter className="gap-2 sm:justify-between">
        {row.source === 'manual' && !voiding ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={saving}
            onClick={() => {
              setVoiding(true);
            }}
          >
            <Trash2 className="size-4" />
            Void
          </Button>
        ) : row.source === 'manual' ? (
          <Button
            variant="destructive"
            disabled={saving}
            onClick={() => {
              void voidTxn();
            }}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm void
          </Button>
        ) : (
          <span />
        )}
        <span className="flex gap-2">
          <Button variant="outline" onClick={flushTagsAndClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </span>
      </DialogFooter>
    </>
  );
}

/**
 * Mobile/narrow shell for TxnEditForm — a centered modal. Behavior is
 * unchanged from before the master-detail slice (teardown C6): every
 * existing caller, including the Accounts register page, keeps this exact
 * modal with zero prop changes. The ledger page (below the desktop
 * breakpoint, or always on the Accounts page) is the only caller; at desktop
 * widths the ledger page passes `row={null}` here and shows TxnDetailPanel
 * instead.
 */
export function TxnEditDialog({
  row,
  householdId,
  userId,
  categories,
  allTags,
  onTagsMutated,
  onClose,
  onSaved,
  onRecategorize,
  onMerchantSearch,
  formRef,
}: {
  row: RichTransactionRow | null;
  householdId: string | null;
  userId: string | null;
  categories: CategoryRow[];
  allTags: TagRow[];
  onTagsMutated: () => void;
  onClose: () => void;
  onSaved: (txnId: string) => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
  onMerchantSearch: (description: string) => void;
  /**
   * Optional external handle (ledger page master-detail): lets the caller
   * trigger the SAME flush-then-close path this dialog already uses for
   * Escape/overlay/× — e.g. right before switching the desktop panel to a
   * different transaction. Falls back to a local ref, so every other caller
   * (Accounts register) is unaffected.
   */
  formRef?: RefObject<TxnEditFormHandle | null>;
}) {
  const localRef = useRef<TxnEditFormHandle>(null);
  const activeRef = formRef ?? localRef;

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) activeRef.current?.requestClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
          <DialogDescription>
            Rename it or add a note. The bank&apos;s original description is kept.
          </DialogDescription>
        </DialogHeader>
        {row ? (
          <TxnEditForm
            ref={activeRef}
            row={row}
            householdId={householdId}
            userId={userId}
            categories={categories}
            allTags={allTags}
            onTagsMutated={onTagsMutated}
            onClose={onClose}
            onSaved={onSaved}
            onRecategorize={onRecategorize}
            onMerchantSearch={onMerchantSearch}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Desktop-width master-detail side panel (teardown C6 residual): the SAME
 * TxnEditForm as the modal, hosted in a static bordered card next to the
 * list instead of a Dialog overlay — the list stays visible and clickable,
 * no navigation-losing modal (Law 8). Only the ledger page mounts this, and
 * only with a non-null row at `lg`+ widths; renders nothing otherwise so it
 * never reserves layout space when no transaction is selected.
 */
export function TxnDetailPanel({
  row,
  householdId,
  userId,
  categories,
  allTags,
  onTagsMutated,
  onClose,
  onSaved,
  onRecategorize,
  onMerchantSearch,
  formRef,
}: {
  row: RichTransactionRow | null;
  householdId: string | null;
  userId: string | null;
  categories: CategoryRow[];
  allTags: TagRow[];
  onTagsMutated: () => void;
  onClose: () => void;
  onSaved: (txnId: string) => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
  onMerchantSearch: (description: string) => void;
  /** Lets the ledger page pre-flush this panel before switching selection. */
  formRef: RefObject<TxnEditFormHandle | null>;
}) {
  if (!row) return null;
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-heading text-base font-medium">Edit transaction</h2>
          <p className="text-sm text-muted-foreground">
            Rename it or add a note. The bank&apos;s original description is kept.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close detail panel"
          className="shrink-0"
          onClick={() => {
            formRef.current?.requestClose();
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="p-4">
        <TxnEditForm
          ref={formRef}
          row={row}
          householdId={householdId}
          userId={userId}
          categories={categories}
          allTags={allTags}
          onTagsMutated={onTagsMutated}
          onClose={onClose}
          onSaved={onSaved}
          onRecategorize={onRecategorize}
          onMerchantSearch={onMerchantSearch}
        />
      </div>
    </div>
  );
}
