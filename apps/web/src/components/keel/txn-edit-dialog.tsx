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
  setTransactionBusiness,
  setTransactionDate,
  setTransactionSplits,
  undoTransfer,
  voidManualTransaction,
  type AccountRow,
  type CategoryRow,
  type RichTransactionRow,
  type TagRow,
  type TransactionSplit,
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
  entityLabel,
  groupForPicker,
  hasExactName,
  hasMultipleEntities,
  inferKindFromAmount,
  parseRecents,
  pushRecent,
  recentCategoriesKey,
  scopeToEntity,
} from '@/lib/category-picker';
import {
  businessEntities,
  businessTagIndex,
  ordinaryTags,
  rowBusinessEntityId,
} from '@/lib/business-tags';
import { maskAccountLabel } from '@/lib/account-label';
import { merchantDisplayName } from '@/lib/merchant-name';
import { shortDateWithYear } from '@/lib/relative-date';
import { isUncategorized } from '@/lib/needs-attention';
import { canApproveAuto, isAutoCategorized } from '@/lib/review-state';
import { useHousehold } from '@/components/keel/household-context';
import { AttachmentsSection } from '@/components/keel/attachments-section';
import { BusinessToggle } from '@/components/keel/business-toggle';
import { useEntityLens } from '@/components/keel/entity-lens-context';
import { TransferCounterpartyFlow } from '@/components/keel/transfer-counterparty-flow';
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
import { DialogFooter } from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';

// Single definition now lives in lib (Home's "Needs attention" module counts
// with it too); re-exported here so existing consumers keep their import path.
export { isUncategorized } from '@/lib/needs-attention';

/**
 * A category is a "Transfers" category if it carries the seeded pfc_key
 * (rename-proof) or is literally named Transfers (pre-key fallback). Shared so
 * both the compact row picker and the detail picker route a Transfers pick
 * into the counterparty flow instead of writing a one-sided tag (F-012, P1-6).
 */
function isTransferCategoryRow(c: Pick<CategoryRow, 'name' | 'pfcKey'>): boolean {
  return c.pfcKey === 'transfers' || c.name.trim().toLowerCase() === 'transfers';
}

/**
 * Label one split leg for the compact "Split · N" chip tooltip. An ACCOUNT leg
 * (a distribution moving money into another real account, e.g. a paycheck's
 * 401(k) share) reads as "Transfer to {account}", not as a plain category name —
 * so the summary matches how the leg renders in the detail Sheet and in the
 * destination account's register.
 */
function splitSummaryLabel(s: TransactionSplit): string {
  return s.legType === 'account' ? `Transfer to ${s.name}` : s.name;
}

/**
 * A buy/sell whose single offset the investment-flow classifier routed to the
 * non-category Investments asset ledger (seeded pfc_key='investments',
 * 20260721060000). Economically the cash converted into holdings within the
 * same account — already excluded from cash flow — so the register renders it
 * with transfer visual language ("→ Investments") instead of a bare negative
 * that reads as spending. Rename-proof via the pfc key, mirroring
 * isTransferCategoryRow above.
 */
function isInvestmentFlowRow(t: Pick<RichTransactionRow, 'categoryPfcKey'>): boolean {
  return t.categoryPfcKey === 'investments';
}

export type ListCallbacks = {
  onRecategorize: (txnId: string, categoryId: string) => void;
  onEdit: (row: RichTransactionRow) => void;
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  /**
   * Inline ✓ approve of an auto-categorized row (Quicken-style). Optional so
   * callers that don't offer it (e.g. read-only lists) simply omit it — the
   * checkmark then never renders. Defaults to onRecategorize with the row's own
   * category id: approving re-files the SAME category with source='user' via the
   * one categorize command (Law 7 — no second write path), which is exactly what
   * clears the "Auto" state.
   */
  onApproveAuto?: ((txnId: string, categoryId: string) => void) | undefined;
};

export function TxnList({
  rows,
  categories,
  bordered,
  running,
  businessNames,
  onRecategorize,
  onEdit,
  selecting,
  selected,
  onToggle,
  onApproveAuto,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  bordered?: boolean;
  /** Optional Quicken-style running balance per transactionId (register view). */
  running?: Map<string, string>;
  /** tagId -> business name; see TxnRow. */
  businessNames?: Map<string, string> | undefined;
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
        // Index suffix: category-grouped split fanning can place two shares
        // of one transaction (or same-named categories) in one list.
        <TxnRow
          key={`${t.transactionId}:${String(i)}`}
          t={t}
          topBorder={i > 0}
          categories={categories}
          running={running}
          businessNames={businessNames}
          onRecategorize={onRecategorize}
          onEdit={onEdit}
          selecting={selecting}
          selected={selected}
          onToggle={onToggle}
          onApproveAuto={onApproveAuto}
        />
      ))}
    </div>
  );
}

/**
 * WS-H (F-005): one transaction row, extracted from TxnList so both the plain
 * list and the virtualized list (VirtualTxnList) render byte-identical markup.
 * `topBorder` replaces the old index-based `i > 0` border: a virtualized row
 * mounts in isolation and has no reliable "am I first" index, so the caller
 * decides. Behaviour is otherwise identical to the pre-extraction inline row.
 */
export function TxnRow({
  t,
  topBorder,
  categories,
  running,
  businessNames,
  onRecategorize,
  onEdit,
  selecting,
  selected,
  onToggle,
  onApproveAuto,
}: {
  t: RichTransactionRow;
  topBorder: boolean;
  categories: CategoryRow[];
  running?: Map<string, string> | undefined;
  /**
   * tagId -> business name, for every business tag in the household
   * (business-tags.ts). Optional: a caller that has not loaded the tag list
   * simply renders no business badge, and the business tag then shows as an
   * ordinary #chip rather than disappearing.
   */
  businessNames?: Map<string, string> | undefined;
} & ListCallbacks) {
  // Quicken-style inline approve: offered only on an auto-categorized row that
  // carries a concrete category. Approving re-files that SAME category with
  // source='user' through the ordinary recategorize path (Law 7 — one write
  // path), turning inference into an explicit human decision (Law 2/9). Falls
  // back to onRecategorize when the caller passes no dedicated handler.
  const showApprove = canApproveAuto(t) && !selecting;
  const approve = onApproveAuto ?? onRecategorize;
  // Concrete category to re-affirm (canApproveAuto already guarantees non-null
  // when showApprove; captured here to avoid a forbidden non-null assertion).
  const approveCatId = t.categoryLedgerAccountId;
  // The business marker gets its own badge rather than a #chip: it answers a
  // different question from a label ("whose books is this on?") and is the one
  // tag that changes what a report counts.
  const rowTagList = t.tags ?? [];
  const businessName = businessNames
    ? rowTagList.map((x) => businessNames.get(x.tagId)).find((n) => n !== undefined)
    : undefined;
  const plainTags = businessNames
    ? rowTagList.filter((x) => !businessNames.has(x.tagId))
    : rowTagList;
  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 ${topBorder ? 'border-t border-border' : ''}`}
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
            {t.note || plainTags.length > 0 || businessName !== undefined ? (
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
                {businessName !== undefined ? (
                  <span
                    className="shrink-0 rounded-full border border-border px-1.5 py-px text-[0.65rem] font-medium text-foreground/80"
                    title={`Counted in ${businessName}'s books`}
                  >
                    {businessName}
                  </span>
                ) : null}
                {plainTags.length > 0 ? (
                  <span className="flex min-w-0 shrink items-center gap-1 truncate">
                    {plainTags.slice(0, 2).map((x) => (
                      <span key={x.tagId} className="shrink-0">#{x.name}</span>
                    ))}
                    {plainTags.length > 2 ? (
                      <span className="shrink-0 text-muted-foreground/60">
                        +{String(plainTags.length - 2)}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </p>
            ) : null}
          </button>
          {t.transferStatus === 'confirmed' || t.distributionTransfer ? (
            // A distribution's transfer leg (a paycheck's 401(k) inflow landing
            // in the Roth account) reads exactly like a confirmed transfer —
            // ArrowLeftRight + "→/← {source account}" — but carries no
            // transferLinkId, so the detail Sheet offers no undo/unlink.
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
          ) : isInvestmentFlowRow(t) ? (
            // A buy/sell whose offset the investment-flow classifier routed to
            // the Investments asset ledger (pfc_key='investments'). The money
            // moved INTO/OUT OF holdings, not out of the household — a bare
            // "-$200 · Investments" line read as spending (user bug report).
            // Render it with the same transfer visual language instead. Still
            // recategorizable from the detail sheet (nothing here is locked).
            <Badge
              variant="secondary"
              className="hidden max-w-40 shrink-0 gap-1 sm:inline-flex"
              title={
                BigInt(t.amountMinor) < 0n
                  ? 'Invested — moved into your Investments balance'
                  : 'Sold — moved out of your Investments balance'
              }
            >
              <ArrowLeftRight className="size-3 shrink-0" />
              <span className="truncate">
                {BigInt(t.amountMinor) < 0n ? '→ Investments' : '← Investments'}
              </span>
            </Badge>
          ) : t.splits && t.splits.length > 0 ? (
            <Badge
              variant="secondary"
              className="hidden shrink-0 gap-1 sm:inline-flex"
              title={t.splits.map(splitSummaryLabel).join(' · ')}
            >
              <Split className="size-3" />
              Split · {t.splits.length}
            </Badge>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              {/* Inline ✓ approve (F: Quicken-style auto confirm). Renders only
                  on an auto-categorized row; hidden below sm alongside the
                  picker it qualifies. Approving re-files the row's OWN category
                  with source='user' via the shared recategorize command — the
                  Auto pill clears and the row becomes reviewed without opening
                  the editor. Green tick = a confirm affordance, never a money
                  judgment (Law 8: red is reserved for negative money). */}
              {showApprove && approveCatId !== null ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Approve category ${t.categoryName ?? ''}`.trim()}
                  title={`Approve “${t.categoryName ?? 'this category'}” — confirm the auto-categorization`}
                  className="hidden size-7 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 sm:inline-flex dark:text-emerald-500 dark:hover:bg-emerald-950/40"
                  onClick={() => {
                    approve(t.transactionId, approveCatId);
                  }}
                >
                  <Check className="size-4" />
                </Button>
              ) : null}
              <CategoryPicker
                row={t}
                categories={categories}
                auto={isAutoCategorized(t)}
                // This list may be window-virtualized (VirtualTxnList); a
                // non-modal popover keeps opening it from scrolling the window
                // and unmounting the row mid-open (the "dropdown won't open on
                // the credit-card page" bug — those pages always virtualize).
                nonModal
                // P1-6: the compact row picker must NOT write a one-sided
                // "Transfers" tag. Picking Transfer here opens the detail Sheet,
                // where the counterparty flow (match / book) runs.
                onTransferPick={() => {
                  onEdit(t);
                }}
                onPick={(catId) => {
                  onRecategorize(t.transactionId, catId);
                }}
              />
            </span>
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
  onTransferPick,
  wide,
  createEntityId,
  auto,
  nonModal,
}: {
  row: RichTransactionRow;
  categories: CategoryRow[];
  onPick: (categoryLedgerAccountId: string, categoryName?: string) => void;
  /**
   * F-012 / P1-6 / P1-7: picking "Transfers" is never a one-sided category
   * write — it opens the counterparty flow. When provided, this is called
   * instead of onPick for a Transfers pick, and the "Transfer" affordance is
   * offered as a single DIRECTION-NEUTRAL option (outside the income/expense
   * kind filter, so an inflow row can reach it too — P1-7). Transfer
   * categories are removed from the ordinary kind groups so a silent one-sided
   * tag is impossible. When omitted (a caller with no flow host), Transfers
   * simply doesn't appear — the pick can only happen through the detail Sheet.
   */
  onTransferPick?: () => void;
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
  /**
   * Render the popover NON-modal (no focus trap, no scroll lock). Set for the
   * compact picker inside the virtualized transaction list — a transient list
   * popover shouldn't lock the page the way a real modal surface does. The
   * Sheet-hosted pickers (split rows, detail category) keep the default
   * trap-focus — they live in a real modal surface and aren't inside a window
   * virtualizer.
   *
   * NOTE this alone never fixed the "dropdown scrolls the page to the top and
   * tears itself down" bug on the virtualized ledger: the actual scroller was
   * cmdk's mount-time scrollIntoView of its auto-selected first item, fired
   * during the frame the popup is still parked at the top of the DOCUMENT.
   * That's cured at the source by positionMethod="fixed" in ui/popover.tsx
   * (see the comment there); this flag remains for the modality semantics.
   */
  nonModal?: boolean;
}) {
  const { householdId } = useHousehold();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [createKind, setCreateKind] = useState<'income' | 'expense'>('expense');
  // F-016 (picker slice): inline-create can now nest under a parent. null =
  // top-level. Reset whenever the popover opens or the kind flips (a parent of
  // the other kind can't hold this child).
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Categories created inline, merged in so a new one is pickable (and its
  // name resolvable) immediately, before the parent refetches categories.
  const [created, setCreated] = useState<CategoryRow[]>([]);

  // Entity-scope (D-060): a transaction can only be categorized into its OWN
  // entity's categories (the categorize / set-splits procs reject a
  // cross-entity category). The scope entity is the explicit caller pin
  // (split rows pass the txn's entity) or the row's owning entity. When
  // neither is known (pre-migration rows), fall through unscoped — the label
  // below then disambiguates identical names by entity. This is exactly what
  // makes the founder's "duplicated" Personal+Business categories collapse to
  // just this transaction's entity.
  const scopeEntityId = createEntityId ?? row.entityId ?? null;
  const allMerged = useMemo(() => {
    const known = new Set(categories.map((c) => c.ledgerAccountId));
    const full = [...categories, ...created.filter((c) => !known.has(c.ledgerAccountId))];
    return scopeToEntity(full, scopeEntityId);
  }, [categories, created, scopeEntityId]);

  // Only label with the entity when the picker actually spans more than one
  // (an unscoped multi-entity view). A scoped or single-entity list is clean.
  const showEntity = useMemo(() => hasMultipleEntities(allMerged), [allMerged]);

  // A "Transfer" category exists on the taxonomy (any entity/kind). Used to
  // decide whether to show the direction-neutral Transfer affordance (P1-7).
  const hasTransferCategory = useMemo(
    () => allMerged.some((c) => isTransferCategoryRow(c)),
    [allMerged],
  );

  // Transfers are handled by the counterparty flow, never as a plain category
  // pick — drop them from the ordinary groups in EVERY picker so a one-sided
  // tag is impossible anywhere (P1-6, incl. the Review page). Callers that can
  // host the flow pass onTransferPick and get the direction-neutral "Transfer"
  // affordance below; callers that can't simply don't surface Transfers.
  const merged = useMemo(
    () => allMerged.filter((c) => !isTransferCategoryRow(c)),
    [allMerged],
  );

  // Offer ALL categories across both kinds (income AND expense): the server
  // (keel_categorize_transaction) validates entity + is_category but NOT kind,
  // so an inflow can legitimately be filed under an expense category (e.g. a
  // "payback" into Restaurants) and vice-versa. Kind-scoping the options made
  // the UI stricter than the backend for no reason. Entity-scoping stays
  // (via `merged`); the Income/Expense grouping below keeps it readable.
  const options = merged;
  const groups = useMemo(() => groupForPicker(merged, query, null), [merged, query]);
  const recentOptions = useMemo(
    () =>
      recents
        .map((id) => options.find((c) => c.ledgerAccountId === id))
        .filter((c): c is CategoryRow => c !== undefined),
    [recents, options],
  );

  // Parents an inline-created child can nest under: top-level categories
  // (no parent themselves — the schema is one level deep) of the SELECTED
  // kind. Empty until at least one top-level category of that kind exists.
  const parentOptions = useMemo(
    () =>
      merged.filter(
        (c) => c.kind === createKind && (c.parentLedgerAccountId ?? null) === null,
      ),
    [merged, createKind],
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
    setCreateParentId(null);
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
      // If a parent is chosen, the child MUST live in the parent's entity (the
      // one-level nesting trigger + reparent proc enforce same-entity); pin the
      // create to that entity so the server doesn't reject the pairing.
      const parent = createParentId
        ? merged.find((c) => c.ledgerAccountId === createParentId)
        : null;
      const createEntity = parent?.entityId ?? entityId;
      const res = await createCategory({
        householdId,
        name,
        kind: createKind,
        entityId: createEntity,
        parentLedgerAccountId: createParentId,
      });
      if (typeof res.ledgerAccountId === 'string') {
        const newCat: CategoryRow = {
          ledgerAccountId: res.ledgerAccountId,
          name,
          kind: createKind,
          entityId: createEntity ?? '',
          parentLedgerAccountId: createParentId,
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
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      // Virtualized-list picker (nonModal): no focus trap / scroll lock for a
      // transient list popover. Elsewhere keep the a11y focus trap. (The
      // scroll-to-top-on-open bug is fixed in ui/popover.tsx, not here.)
      modal={nonModal ? false : 'trap-focus'}
    >
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
            // Don't grab focus synchronously in the non-modal list picker: a
            // sync focus() scrolls the window and can de-virtualize (unmount)
            // this row before the popup settles. Modal (Sheet) pickers keep
            // autoFocus so typing starts immediately behind the focus trap.
            autoFocus={!nonModal}
          />
          <CommandList>
            {groups.length === 0 && !canCreate && !(onTransferPick && hasTransferCategory) ? (
              <CommandEmpty>No matching category.</CommandEmpty>
            ) : null}
            {/* P1-6/P1-7: direction-neutral Transfer affordance. Available to
                inflow AND outflow rows (outside the kind filter). Picking it
                opens the counterparty flow — the one-sided overlay is never
                written. Filtered by the query like a real option would be. */}
            {onTransferPick &&
            hasTransferCategory &&
            (trimmed.length === 0 || 'transfer'.includes(trimmed.toLowerCase())) ? (
              <CommandGroup heading="Transfer">
                <CommandItem
                  value="transfer:flow"
                  onSelect={() => {
                    setOpen(false);
                    onTransferPick();
                  }}
                >
                  <ArrowLeftRight className="size-4" />
                  <span className="truncate">Transfer between accounts…</span>
                </CommandItem>
              </CommandGroup>
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
                    <span className="truncate">
                      {entityLabel(c.name, c.entityName, showEntity)}
                    </span>
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
                      {entityLabel(c.name, c.entityName, showEntity)}
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
                        // A parent of the OTHER kind can't hold this child.
                        setCreateParentId(null);
                      }}
                    >
                      {k === 'expense' ? 'Expense' : 'Income'}
                    </button>
                  ))}
                </div>
                {/* F-016: optional parent for the new category (one level deep).
                    Hidden when there's no top-level category of this kind to
                    nest under. */}
                {parentOptions.length > 0 ? (
                  <div className="flex items-center gap-1.5 px-2 pb-1.5">
                    <span className="text-xs text-muted-foreground">under</span>
                    <select
                      aria-label="Parent category"
                      className="h-6 min-w-0 flex-1 rounded-md border border-border bg-transparent px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={createParentId ?? ''}
                      onChange={(e) => {
                        setCreateParentId(e.target.value === '' ? null : e.target.value);
                      }}
                    >
                      <option value="">Nothing (top level)</option>
                      {parentOptions.map((c) => (
                        <option key={c.ledgerAccountId} value={c.ledgerAccountId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
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
  /** The transaction's owning account's entity — required to attach a document. */
  entityId: string | null;
  categories: CategoryRow[];
  /** All household accounts — counterparty choices for the transfer flow (F-012). */
  accounts: AccountRow[];
  /** Rows already loaded on the page — used to detect a matching opposite leg. */
  allRows: RichTransactionRow[];
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
  entityId,
  categories,
  accounts,
  allRows,
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
  const [date, setDate] = useState('');
  // One idempotency key per dialog session, mirroring splitAttemptKey: a
  // retry after a timeout replays the same date correction instead of
  // double-revising (invariant 3).
  const [dateAttemptKey, setDateAttemptKey] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
  // A manual txn can be voided from here only while it is NOT part of an active
  // (suggested/confirmed) transfer — those legs must be undone first (the server
  // enforces this with P0009; see the Void footer below, review follow-up c).
  const voidable =
    row.source === 'manual' &&
    row.transferStatus !== 'suggested' &&
    row.transferStatus !== 'confirmed';
  // Category picked in THIS dialog session. The row prop keeps the pre-change
  // category until close, so old→new stays visible (teardown C4: the change
  // you just made is legible, not silent).
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  // F-012: when the user picks the "Transfers" category, we intercept with the
  // counterparty step instead of writing a one-sided tag. Null = not in the
  // flow (plain picker shown).
  const [transferFlow, setTransferFlow] = useState(false);
  const [undoingTransfer, setUndoingTransfer] = useState(false);
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
  // Business attribution (20260831120000) rides the same tag overlay. It is
  // DERIVED from the row rather than seeded into state, with an optional
  // override for the in-flight optimistic value: the first attribution to a
  // business mints that business's tag server-side, so the parent refetches
  // both the row and the tag list right after the write. Seeding state from
  // the row would let that refetch clobber the optimistic value mid-flight;
  // deriving means the override simply stops mattering once truth catches up.
  // `undefined` = no override, show what the row says.
  const [businessOverride, setBusinessOverride] = useState<string | null | undefined>(undefined);
  const [businessBusy, setBusinessBusy] = useState(false);
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

  // The household's businesses, and which tag ids attribute to them. Entities
  // come from the lens provider, which already loads them household-wide.
  const { entities } = useEntityLens();
  const businesses = useMemo(() => businessEntities(entities, allTags), [entities, allTags]);
  const businessIndex = useMemo(() => businessTagIndex(allTags), [allTags]);
  // Business tags are set through BusinessToggle, never the ordinary chips —
  // offering two paths to the same fact is how ambiguity gets in.
  const pickerTags = useMemo(() => ordinaryTags(allTags), [allTags]);
  const rowBusiness =
    businessOverride !== undefined ? businessOverride : rowBusinessEntityId(row, businessIndex);

  // Recomputed every render (no deps array) so it always closes over the
  // latest flushTagsAndClose — the only thing external callers ever need.
  useImperativeHandle(ref, () => ({ requestClose: flushTagsAndClose }));

  useEffect(() => {
    setName(row.description);
    setNote(row.note ?? '');
    setDate(row.effectiveDate);
    setDateAttemptKey(crypto.randomUUID());
    setVoiding(false);
    setPicked(null);
    setTransferFlow(false);
    setUndoingTransfer(false);
    // Multi-split rows open straight into the editor, seeded from the real
    // postings; single-category rows start in picker mode with a "Split…"
    // affordance. A distribution (a split with an account-transfer leg, e.g. a
    // paycheck's 401k into a retirement account) is NOT editable by the
    // category-only editor — it opens read-only (see the Splits block below).
    const rowHasAccountLeg = (row.splits ?? []).some((s) => s.legType === 'account');
    setSplitRows(
      row.splits && row.splits.length > 0 && !rowHasAccountLeg
        ? seedRowsFromSplits(row.splits)
        : null,
    );
    setSplitBusy(false);
    setSplitAttemptKey(crypto.randomUUID());
    setRowTags(row.tags ?? []);
    setBusinessOverride(undefined);
    setCreatedTags([]);
    setNewTag('');
    setTagsDirty(false);
  }, [row]);

  /**
   * Attribute this transaction to a business, or clear it. The proc replaces
   * any previous business rather than adding one, so the optimistic state is a
   * straight assignment. tagsDirty is set because the parent must refetch: the
   * first attribution to a business creates that business's tag, and the row's
   * own tag list changes.
   */
  async function setBusiness(entityId: string | null) {
    if (!householdId || businessBusy) return;
    if (rowBusiness === entityId) return;
    setBusinessOverride(entityId);
    setTagsDirty(true);
    setBusinessBusy(true);
    try {
      const write = setTransactionBusiness({
        householdId,
        transactionId: row.transactionId,
        entityId,
      });
      pendingTagWrite.current = write;
      await write;
    } catch (err) {
      // Fall back to what the row actually says rather than to a remembered
      // value that may itself be stale.
      setBusinessOverride(undefined);
      toast.error(
        err instanceof Error ? err.message : 'Could not change the business for this transaction.',
      );
    } finally {
      setBusinessBusy(false);
    }
  }

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
        // Never a business tag: the ordinary picker only mints plain labels.
        setCreatedTags((prevTags) => [...prevTags, { ...tag, usageCount: 1, entityId: null }]);
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

  async function undoTransferLink() {
    if (!householdId || !row.transferLinkId) return;
    setUndoingTransfer(true);
    try {
      await undoTransfer({ householdId, linkId: row.transferLinkId });
      toast.success(
        row.transferBooked
          ? 'Transfer undone — the booked leg was reversed, not deleted.'
          : 'Unlinked — both sides are back in income and spending.',
      );
      onSaved(row.transactionId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not undo the transfer.');
    } finally {
      setUndoingTransfer(false);
    }
  }

  const original = row.originalDescription ?? row.description;
  // Existence gate only (drives whether the Category section renders). Not
  // kind-scoped: the picker itself offers both kinds now, so any category
  // existing at all means the section is useful.
  const categoryOptions = categories;

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
  // A distribution: at least one leg is a transfer INTO another real account
  // (e.g. a paycheck's 401k). It reads as one ledger line with the transfer
  // shown inside it, and is displayed read-only here (the category-only editor
  // can't represent an account leg).
  const accountLegs = (row.splits ?? []).filter((s) => s.legType === 'account');
  const hasAccountLeg = accountLegs.length > 0;

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
      if (date !== row.effectiveDate && userId) {
        await setTransactionDate({
          householdId,
          userId,
          transactionId: row.transactionId,
          effectiveDate: date,
          attemptKey: dateAttemptKey,
        });
      }
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
        <div className="space-y-1.5">
          <Label htmlFor="txn-date">Date</Label>
          <Input
            id="txn-date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
            }}
          />
          {date !== row.effectiveDate ? (
            <p className="text-xs text-muted-foreground">
              Moving this transaction from {shortDateWithYear(row.effectiveDate)} to{' '}
              {shortDateWithYear(date)} — the original entry is reversed, not erased.
            </p>
          ) : null}
        </div>
        {hasAccountLeg && row.transferStatus !== 'confirmed' ? (
          // A distribution: one ledger line whose splits include a transfer into
          // another account (e.g. a paycheck's 401k). Shown read-only — the
          // transfer leg keeps this a single transaction, and its counterparty
          // balance grows from the same batch.
          <div className="space-y-2">
            <Label>Splits</Label>
            <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
              {(row.splits ?? []).map((s, i) => (
                <div key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {s.legType === 'account' ? (
                      <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="min-w-0 truncate">
                      {s.legType === 'account' ? `Transfer to ${s.name}` : s.name}
                    </span>
                  </span>
                  {/* Negate the stored debit-positive offset to the natural
                      cash-effect sign, so a paycheck reads gross POSITIVE, taxes
                      and the 401k transfer NEGATIVE, and the lines sum to the net
                      deposit (same convention as the ledger's grouped-split view). */}
                  <Money
                    amountMinor={(-BigInt(s.amountMinor)).toString()}
                    currency={row.currency}
                    signed
                    className="text-sm"
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Excluded from income and spending — the transfer moves money between your
              accounts inside this one entry.
            </p>
          </div>
        ) : null}
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
            <p className="text-xs text-muted-foreground">
              Enter a negative amount for a refund or reimbursement (a credit that
              reduces that category).
            </p>
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
        {row.transferStatus === 'confirmed' || row.distributionTransfer ? (
          // A distribution's transfer leg (a paycheck's 401(k) inflow landing
          // here) renders like a confirmed transfer — "To/From {source
          // account}" + the excluded-from-income-and-spending note — but has no
          // transferLinkId, so the row.transferLinkId guard below drops the
          // undo/unlink button: this leg is part of its header transaction and
          // is only editable there, not unwound from the destination register.
          <div className="space-y-1.5">
            <Label>Transfer</Label>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {BigInt(row.amountMinor) < 0n ? 'To ' : 'From '}
                {row.counterpartyAccountName ?? 'another account'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">
                Excluded from income and spending.
                {row.transferBooked ? ' KEEL booked the other side.' : ''}
              </p>
              {row.transferLinkId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
                  disabled={undoingTransfer}
                  onClick={() => {
                    void undoTransferLink();
                  }}
                >
                  {undoingTransfer ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {row.transferBooked ? 'Undo transfer' : 'Unlink'}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {isInvestmentFlowRow(row) && row.transferStatus !== 'confirmed' && !row.distributionTransfer ? (
          // Investment buy/sell (offset on the Investments asset ledger). Info
          // only — the category picker below stays live, so a mis-classified
          // row can still be re-filed to a real category (which replaces the
          // Investments offset via the normal recategorize command).
          <div className="space-y-1.5">
            <Label>Investment</Label>
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <ArrowLeftRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {BigInt(row.amountMinor) < 0n
                  ? 'Invested — moved into your Investments balance'
                  : 'Sold — moved out of your Investments balance'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Excluded from income and spending. Holdings are tracked on the Investments page.
            </p>
          </div>
        ) : null}
        {row.transferStatus !== 'confirmed' && !row.distributionTransfer && splitRows === null && !hasAccountLeg && categoryOptions.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Category</Label>
              {/* Teardown C7: every competitor has this. Expands into two
                      rows with the full amount seeded on row 1. */}
              {!transferFlow ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setSplitRows(
                      seedRowsForNewSplit(
                        row.amountMinor,
                        picked?.id ?? row.categoryLedgerAccountId,
                      ),
                    );
                  }}
                >
                  <Split className="size-3.5" />
                  Split…
                </Button>
              ) : null}
            </div>
            {transferFlow ? (
              // F-012: picking "Transfers" opens the counterparty step here
              // (match an existing opposite leg, or book one on a manual
              // account) instead of writing a one-sided classification tag.
              <TransferCounterpartyFlow
                householdId={householdId}
                row={row}
                accounts={accounts}
                allRows={allRows}
                onDone={() => {
                  setTransferFlow(false);
                  onSaved(row.transactionId);
                }}
                onCancel={() => {
                  setTransferFlow(false);
                }}
              />
            ) : (
              <>
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
                  // F-012 / P1-7: picking "Transfers" opens the counterparty
                  // step (direction-neutral, so an inflow row reaches it too)
                  // instead of writing a one-sided classification tag.
                  onTransferPick={() => {
                    setTransferFlow(true);
                  }}
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
              </>
            )}
          </div>
        ) : null}
        {businesses.length > 0 ? (
          <div className="space-y-1.5">
            <Label>Business</Label>
            <BusinessToggle
              businesses={businesses}
              value={rowBusiness}
              disabled={businessBusy}
              onChange={(entityId) => {
                void setBusiness(entityId);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Counts this expense in that business&apos;s books even though a personal account
              paid for it. Nothing moves.
            </p>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label>Tags</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              ...pickerTags,
              ...createdTags.filter((c) => !pickerTags.some((a) => a.tagId === c.tagId)),
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
        <AttachmentsSection
          householdId={householdId}
          userId={userId}
          entityId={entityId}
          targetType="transaction"
          targetId={row.transactionId}
          kind="receipt"
        />
      </div>
      <DialogFooter className="gap-2 sm:justify-between">
        {/* Void is offered only for manual txns that are NOT part of an active
            transfer. The server already rejects voiding an active transfer leg
            (P0009 "undo the transfer first"); hiding the button keeps the UI
            from offering an action that can only fail — undo the transfer via
            the transfer panel above instead (review follow-up c). */}
        {voidable && !voiding ? (
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
        ) : voidable ? (
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

type TxnDetailSheetProps = {
  row: RichTransactionRow | null;
  householdId: string | null;
  userId: string | null;
  /** Looked up by row.accountId to find the entity a new attachment belongs to. */
  accounts: AccountRow[];
  categories: CategoryRow[];
  /** Rows already loaded on the page — transfer match detection (F-012). */
  allRows?: RichTransactionRow[];
  allTags: TagRow[];
  onTagsMutated: () => void;
  onClose: () => void;
  onSaved: (txnId: string) => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
  onMerchantSearch: (description: string) => void;
  /**
   * Optional external handle: lets the caller trigger the SAME flush-then-
   * close path this sheet uses for Escape/overlay/× — e.g. right before
   * switching the panel to a different transaction without an intermediate
   * close. Falls back to a local ref.
   */
  formRef?: RefObject<TxnEditFormHandle | null>;
};

/**
 * F-010 — Transaction detail as a full-height RIGHT-SIDE panel (shadcn Sheet).
 * One surface for every width and every caller (ledger + account pages): a
 * fixed panel down the full right edge on desktop, a full-screen sheet at
 * 390px. The list underneath keeps its scroll position (the Sheet overlays,
 * it doesn't reflow the page). Hosts the unchanged TxnEditForm — category
 * (with the F-012 transfer flow), tags, notes, splits, attachments, transfer
 * status — so this is a re-house + polish, not a rewrite of form logic.
 */
export function TxnDetailSheet({
  row,
  householdId,
  userId,
  accounts,
  categories,
  allRows,
  allTags,
  onTagsMutated,
  onClose,
  onSaved,
  onRecategorize,
  onMerchantSearch,
  formRef,
}: TxnDetailSheetProps) {
  const localRef = useRef<TxnEditFormHandle>(null);
  const activeRef = formRef ?? localRef;

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) activeRef.current?.requestClose();
      }}
    >
      {/* Full-screen on mobile; a comfortable fixed-width panel down the full
          right edge on sm+ (Sheet's own right-side positioning gives the
          full viewport height). Scrolls internally so long transactions —
          many splits, attachments — never clip. */}
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle>Edit transaction</SheetTitle>
          <SheetDescription>
            Rename it or add a note. The bank&apos;s original description is kept.
          </SheetDescription>
        </SheetHeader>
        {row ? (
          <div className="px-4 py-4">
            <TxnEditForm
              ref={activeRef}
              row={row}
              householdId={householdId}
              userId={userId}
              entityId={accounts.find((a) => a.id === row.accountId)?.entityId ?? null}
              categories={categories}
              accounts={accounts}
              allRows={allRows ?? []}
              allTags={allTags}
              onTagsMutated={onTagsMutated}
              onClose={onClose}
              onSaved={onSaved}
              onRecategorize={onRecategorize}
              onMerchantSearch={onMerchantSearch}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Back-compat aliases so existing callers keep compiling while the pages
 * migrate to the single Sheet surface. Both now resolve to TxnDetailSheet —
 * the old centered-modal / inline-card split is gone (F-010). TxnDetailPanel
 * ignores its old always-required formRef shape by threading it through.
 */
export function TxnEditDialog(props: TxnDetailSheetProps) {
  return <TxnDetailSheet {...props} />;
}

export function TxnDetailPanel(
  props: TxnDetailSheetProps & { formRef: RefObject<TxnEditFormHandle | null> },
) {
  return <TxnDetailSheet {...props} />;
}
