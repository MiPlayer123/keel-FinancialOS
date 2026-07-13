'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Loader2,
  Pencil,
  Split,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  assignTag,
  saveTag,
  overrideTransaction,
  voidManualTransaction,
  type CategoryRow,
  type RichTransactionRow,
  type TagRow,
} from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Rename-proof "is it still on a landing pad?" check: the stable pfc_key when
 * the migration has landed, the seeded name as a fallback until then. Split
 * transactions are categorized by their splits — never "uncategorized".
 */
export function isUncategorized(t: RichTransactionRow): boolean {
  if (t.splits && t.splits.length > 0) return false;
  if (t.categoryPfcKey != null) return t.categoryPfcKey.startsWith('uncategorized');
  return t.categoryName ? t.categoryName.startsWith('Uncategorized') : true;
}

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
          <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
            {t.effectiveDate.slice(5)}
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
            <p className="truncate text-sm font-medium" title={t.description}>
              {t.description}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t.accountName}
              {/* The picker is hidden below sm — keep the category visible. */}
              {t.categoryName ? (
                <span className="sm:hidden"> · {t.categoryName}</span>
              ) : null}
              {t.note ? (
                <span className="text-muted-foreground/80">
                  {' '}
                  <StickyNote className="inline size-3 align-[-1px]" aria-label="Note" />{' '}
                  {t.note.length > 40 ? `${t.note.slice(0, 40)}…` : t.note}
                </span>
              ) : null}
              {(t.tags ?? []).slice(0, 2).map((x) => (
                <span key={x.tagId} className="text-muted-foreground/80"> #{x.name}</span>
              ))}
              {(t.tags?.length ?? 0) > 2 ? (
                <span className="text-muted-foreground/60"> +{String((t.tags?.length ?? 0) - 2)}</span>
              ) : null}
            </p>
          </button>
          {t.transferStatus === 'confirmed' ? (
            <Badge variant="secondary" className="hidden shrink-0 gap-1 sm:inline-flex">
              <ArrowLeftRight className="size-3" />
              Transfer
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

export function CategoryPicker({
  row,
  categories,
  onPick,
}: {
  row: RichTransactionRow;
  categories: CategoryRow[];
  onPick: (categoryLedgerAccountId: string) => void;
}) {
  // Only offer categories matching the transaction's direction (income/expense).
  const options = useMemo(
    () => categories.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true)),
    [categories, row.categoryKind],
  );
  const label = row.categoryName ?? 'Uncategorized';
  const isDefault = isUncategorized(row);

  if (options.length === 0) {
    return (
      <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
        {label}
      </Badge>
    );
  }

  return (
    <Select
      value={row.categoryLedgerAccountId ?? undefined}
      items={Object.fromEntries(options.map((c) => [c.ledgerAccountId, c.name]))}
      onValueChange={(v) => {
        if (v) onPick(v);
      }}
    >
      <SelectTrigger
        className={`hidden h-7 w-40 shrink-0 border-dashed sm:flex ${
          isDefault ? 'text-muted-foreground' : ''
        }`}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((c) => (
          <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
            {c.parentLedgerAccountId ? <span className="pl-3">{c.name}</span> : c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}


/**
 * Edit the user-facing name + note for a transaction. Presentation overlay
 * only: the provider's original description is immutable and stays visible.
 * Also hosts the category picker (on mobile it's the only recategorize path).
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
}: {
  row: RichTransactionRow | null;
  householdId: string | null;
  userId: string | null;
  categories: CategoryRow[];
  allTags: TagRow[];
  onTagsMutated: () => void;
  onClose: () => void;
  onSaved: () => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
  onMerchantSearch: (description: string) => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
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

  useEffect(() => {
    if (!row) return;
    setName(row.description);
    setNote(row.note ?? '');
    setVoiding(false);
    setRowTags(row.tags ?? []);
    setCreatedTags([]);
    setNewTag('');
    setTagsDirty(false);
  }, [row]);

  async function toggleTag(tag: { tagId: string; name: string }) {
    if (!row || !householdId) return;
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
    if (!row || !householdId || tagBusy) return;
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
    if (!row || !householdId || !userId) return;
    setSaving(true);
    try {
      await voidManualTransaction({
        householdId,
        userId,
        transactionId: row.transactionId,
        reason: 'Voided from ledger',
      });
      toast.success('Transaction voided — the reversal is on the books, nothing deleted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not void the transaction.');
    } finally {
      setSaving(false);
    }
  }

  const original = row?.originalDescription ?? row?.description ?? '';
  const categoryOptions = useMemo(
    () =>
      row
        ? categories.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true))
        : [],
    [categories, row],
  );

  async function save() {
    if (!row || !householdId) return;
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
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) flushTagsAndClose();
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
          <div className="space-y-4">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground" title={original}>
                {original}
              </span>
              <Money amountMinor={row.amountMinor} currency={row.currency} signed />
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
            {row.splits && row.splits.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Splits</Label>
                <div className="space-y-1 rounded-md border border-border px-3 py-2">
                  {row.splits.map((s) => (
                    <div
                      key={s.categoryLedgerAccountId}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate">{s.name}</span>
                      <Money
                        amountMinor={(-BigInt(s.amountMinor)).toString()}
                        currency={row.currency}
                        signed
                        className="shrink-0 text-sm"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Split transactions are categorized by their splits. To change them,
                  void and re-enter.
                </p>
              </div>
            ) : null}
            {row.transferStatus !== 'confirmed' &&
            !(row.splits && row.splits.length > 0) &&
            categoryOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={row.categoryLedgerAccountId ?? undefined}
                  items={Object.fromEntries(
                    categoryOptions.map((c) => [c.ledgerAccountId, c.name]),
                  )}
                  onValueChange={(v) => {
                    if (v) onRecategorize(row.transactionId, v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={row.categoryName ?? 'Uncategorized'} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                        {c.parentLedgerAccountId ? <span className="pl-3">{c.name}</span> : c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {[...allTags, ...createdTags.filter((c) => !allTags.some((a) => a.tagId === c.tagId))].map(
                  (t) => {
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
                  },
                )}
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
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {row?.source === 'manual' && !voiding ? (
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
          ) : row?.source === 'manual' ? (
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
      </DialogContent>
    </Dialog>
  );
}
