'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Check,
  X,
  Loader2,
  ArrowRight,
  ArrowLeftRight,
  ChevronDown,
  ListChecks,
} from 'lucide-react';
import { LazyMotion, domMax, m, useMotionValue, useTransform } from 'motion/react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, keelQueryKey } from '@/lib/use-keel-query';
import { isUncategorized } from '@/lib/needs-attention';
import { relativeDueLabel } from '@/lib/relative-date';
import { resolveSwipeDecision } from '@/lib/swipe';
import {
  keelCommand,
  newId,
  categorizeTransaction,
  detectTransfers,
  decideTransfer,
  detectCategorySuggestions,
  fetchCategories,
  type CategoryRow,
  type CategorySuggestionRow,
  type QueryResult,
  type RecurringSeriesRow,
  type RichTransactionRow,
  type TransferLinkRow,
} from '@/lib/keel-api';
import { CategoryPicker } from '@/components/keel/txn-edit-dialog';
import {
  cadenceLabel,
  categorizationReasonLine,
  recurringReasonLine,
  transferReasonLine,
} from '@/lib/recurring-evidence';
import { groupTransfersByAccountPair } from '@/lib/transfer-grouping';
import { merchantDisplayName } from '@/lib/merchant-name';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReviewPage() {
  return (
    <>
      <PageHeader title="Review" description="Approve or dismiss what KEEL detected." />
      <div className="p-6">
        <ReviewBody />
      </div>
    </>
  );
}

/** Render cap for the Still-uncategorized list; the ledger link carries the rest. */
const STILL_UNCATEGORIZED_CAP = 25;

function ReviewBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );
  const removeRecurring = useOptimisticRemove<RecurringSeriesRow>(
    'recurring.list',
    householdId,
    seriesIdOf,
  );
  const transfers = useTransferSuggestions(householdId);
  const categorizations = useCategorySuggestions(householdId);
  // F-017 "Still uncategorized": transactions that matched no rule and no
  // bank category never mint a suggestion, so they'd otherwise never reach
  // Review. Plain read-model list over the shared transactions.rich cache.
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  // Optimistically resolved transactions: hidden from "Still uncategorized"
  // the moment a direct pick (or an accepted suggestion) succeeds, without
  // waiting for the transactions.rich refetch to land.
  const [resolvedTxnIds, setResolvedTxnIds] = useState<Set<string>>(new Set());
  // Bulk approve/dismiss (P0-B follow-up #3): client-side convenience over
  // the SAME audited command as a single decision — one
  // categorization.decide_suggestion call per selected id, never a shortcut
  // around Law 2's per-mutation audit_log requirement.
  const [catSelecting, setCatSelecting] = useState(false);
  const [catSelected, setCatSelected] = useState<Set<string>>(new Set());
  const [catBulkBusy, setCatBulkBusy] = useState(false);

  useEffect(() => {
    if (!householdId) return;
    void fetchCategories(householdId)
      .then(setCategories)
      .catch(() => undefined);
  }, [householdId]);

  const markResolved = useCallback((txnIds: string[]) => {
    if (txnIds.length === 0) return;
    setResolvedTxnIds((prev) => {
      const next = new Set(prev);
      for (const id of txnIds) next.add(id);
      return next;
    });
  }, []);

  // F-4: the optimistic hide only needs to survive until the authoritative
  // transactions.rich refetch lands. Prune those ids afterwards so the Set
  // stays bounded AND a transaction that later becomes uncategorized again is
  // not permanently suppressed by a stale id.
  const pruneResolved = useCallback((txnIds: string[]) => {
    if (txnIds.length === 0) return;
    setResolvedTxnIds((prev) => {
      if (!txnIds.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of txnIds) next.delete(id);
      return next;
    });
  }, []);

  const stillUncategorized = useMemo(() => {
    const pending = new Set(categorizations.suggested.map((r) => r.canonicalTransactionId));
    return txns.rows
      .filter(
        (t) =>
          isUncategorized(t) &&
          !pending.has(t.transactionId) &&
          !resolvedTxnIds.has(t.transactionId),
      )
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  }, [txns.rows, categorizations.suggested, resolvedTxnIds]);

  function toggleCatSelected(id: string) {
    setCatSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkDecide(accept: boolean) {
    if (!householdId || !userId || catSelected.size === 0) return;
    const ids = [...catSelected];
    // Captured BEFORE optimistic removal — accepted suggestions must also
    // hide their transaction from "Still uncategorized" below.
    const txnBySuggestion = new Map(
      categorizations.suggested.map((r) => [r.suggestionId, r.canonicalTransactionId]),
    );
    setCatBulkBusy(true);
    // F-003: optimistic removal + parallel decides. Each id is still its own
    // audited categorization.decide_suggestion command (Law 2) — allSettled
    // only parallelizes, it never merges decisions.
    const restore = categorizations.remove(ids);
    const results = await Promise.allSettled(
      ids.map((suggestionId) =>
        keelCommand({
          commandId: newId(),
          command: 'categorization.decide_suggestion',
          // Deterministic per decision, exactly like the single-card action:
          // a retry replays, never re-executes (Law 9).
          economicEventKey: `catdecide:${suggestionId}:${accept ? 'accept' : 'dismiss'}`,
          actor: { kind: 'user', userId },
          householdId,
          payload: { suggestionId, accept },
        }),
      ),
    );
    const failed = new Set(ids.filter((_, i) => results[i]?.status === 'rejected'));
    const ok = ids.length - failed.size;
    setCatBulkBusy(false);
    setCatSelected(new Set());
    setCatSelecting(false);
    // Rollback the failures only — never fake a server success.
    if (failed.size > 0) restore([...failed]);
    if (accept) {
      markResolved(
        ids
          .filter((id) => !failed.has(id))
          .flatMap((id) => {
            const txnId = txnBySuggestion.get(id);
            return txnId === undefined ? [] : [txnId];
          }),
      );
    }
    toast[failed.size > 0 ? 'error' : 'success'](
      failed.size > 0
        ? `${accept ? 'Approved' : 'Dismissed'} ${String(ok)}, ${String(failed.size)} failed.`
        : `${accept ? 'Approved' : 'Dismissed'} ${String(ok)} suggestion${ok === 1 ? '' : 's'}.`,
    );
    await categorizations.refetch();
  }

  function categorizeStillUncategorized(
    txn: RichTransactionRow,
    categoryLedgerAccountId: string,
    categoryName?: string,
  ) {
    if (!householdId) return;
    // Optimistic: the row leaves the list now; restored below on failure.
    markResolved([txn.transactionId]);
    void (async () => {
      try {
        await categorizeTransaction({
          householdId,
          transactionId: txn.transactionId,
          categoryLedgerAccountId,
        });
        toast.success(categoryName ? `Filed under ${categoryName}.` : 'Category updated.');
        await txns.refetch();
        // Authoritative data has landed — drop the optimistic hide (F-4).
        pruneResolved([txn.transactionId]);
      } catch (err) {
        setResolvedTxnIds((prev) => {
          const next = new Set(prev);
          next.delete(txn.transactionId);
          return next;
        });
        toast.error(err instanceof Error ? err.message : 'Could not update category.');
      }
    })();
  }

  const suggested = rows.filter((r) => r.status === 'suggested');

  // F-004: a section has SETTLED only once its list (and, where one exists,
  // its mount-time detect pass) has finished — OR across loaders, never AND.
  // Sections with cached rows render immediately; unsettled empty sections
  // show a skeleton below instead of a false global empty state.
  const recurringSettled = !loading;
  const transfersSettled = !transfers.loading;
  const categorizationsSettled = !categorizations.loading;
  // Still-uncategorized derives from transactions.rich AND the pending
  // suggestions list (rows with a pending suggestion are excluded).
  const stillUncatSettled = !txns.loading && categorizationsSettled;
  const allSettled =
    recurringSettled && transfersSettled && categorizationsSettled && stillUncatSettled;

  if (!ready) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const nothingRecurring = suggested.length === 0;
  const nothingTransfers = transfers.suggested.length === 0;
  const nothingCategorizations = categorizations.suggested.length === 0;
  const nothingUncategorized = stillUncategorized.length === 0;

  if (
    allSettled &&
    error &&
    nothingTransfers &&
    nothingCategorizations &&
    nothingUncategorized
  ) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Couldn't load suggestions"
        description={error}
      />
    );
  }

  // "All caught up" may render only once EVERY section has settled empty —
  // never while a slow detect/list pass could still surface items (F-004).
  if (
    !householdId ||
    (allSettled &&
      nothingRecurring &&
      nothingTransfers &&
      nothingCategorizations &&
      nothingUncategorized)
  ) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="You're all caught up"
        description="Nothing needs your review right now. Recurring series, transfer matches and categorizations will surface here as suggestions — each waiting for your approval."
      />
    );
  }

  return (
    <div className="space-y-8">
      {nothingTransfers && !transfersSettled ? <Skeleton className="h-24 w-full" /> : null}
      {transfers.suggested.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Possible transfers · {transfers.suggested.length}
          </h2>
          <p className="text-xs text-muted-foreground">
            These pairs look like money moving between your own accounts. Confirming keeps both
            sides in the ledger but stops them counting as income and spending.
          </p>
          {groupTransfersByAccountPair(transfers.suggested).flatMap((group) => {
            const first = group[0];
            if (!first) return [];
            return [
              group.length > 1 ? (
                <RecurringTransferGroupCard
                  key={first.linkId}
                  links={group}
                  householdId={householdId}
                  onRemove={() => transfers.remove(group.map((l) => l.linkId))}
                  onDone={() => {
                    void transfers.refetch();
                  }}
                />
              ) : (
                <TransferCard
                  key={first.linkId}
                  link={first}
                  householdId={householdId}
                  onRemove={() => transfers.remove([first.linkId])}
                  onDone={() => {
                    void transfers.refetch();
                  }}
                />
              ),
            ];
          })}
        </section>
      ) : null}

      {nothingRecurring && !recurringSettled ? <Skeleton className="h-24 w-full" /> : null}
      {suggested.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Recurring series · {suggested.length}
          </h2>
          {suggested.map((series) => (
            <SuggestionCard
              key={series.seriesId}
              series={series}
              householdId={householdId}
              userId={userId}
              onRemove={() => removeRecurring([series.seriesId])}
              onDone={() => {
                void refetch();
              }}
            />
          ))}
        </section>
      ) : null}

      {nothingCategorizations && !categorizationsSettled ? (
        <Skeleton className="h-24 w-full" />
      ) : null}
      {categorizations.suggested.length > 0 ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Categorizations · {categorizations.suggested.length}
            </h2>
            {categorizations.suggested.length > 1 ? (
              <Button
                variant={catSelecting ? 'secondary' : 'outline'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setCatSelecting((s) => !s);
                  setCatSelected(new Set());
                }}
              >
                <ListChecks className="size-3.5" />
                {catSelecting ? 'Done' : 'Select'}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Deterministic matches from your rules and the bank&apos;s own categories. Nothing is
            filed until you accept it.
          </p>
          {catSelecting ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-2.5">
              <span className="text-sm font-medium">{catSelected.size} selected</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={catBulkBusy}
                onClick={() => {
                  setCatSelected(new Set(categorizations.suggested.map((r) => r.suggestionId)));
                }}
              >
                Select all
              </Button>
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                disabled={catBulkBusy || catSelected.size === 0}
                onClick={() => {
                  void bulkDecide(false);
                }}
              >
                {catBulkBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <X className="size-4" />
                )}
                Dismiss {catSelected.size > 0 ? catSelected.size : ''}
              </Button>
              <Button
                size="sm"
                disabled={catBulkBusy || catSelected.size === 0}
                onClick={() => {
                  void bulkDecide(true);
                }}
              >
                {catBulkBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Approve {catSelected.size > 0 ? catSelected.size : ''}
              </Button>
            </div>
          ) : null}
          {/* domMax (not the smaller domAnimation bundle Tilt uses elsewhere)
              is required for drag gestures — loaded lazily once for this
              section only, not the whole Review page. */}
          <LazyMotion features={domMax} strict>
            {categorizations.suggested.map((row) => (
              <CategorizationCard
                key={row.suggestionId}
                row={row}
                householdId={householdId}
                userId={userId}
                selecting={catSelecting}
                selected={catSelected.has(row.suggestionId)}
                onToggle={() => {
                  toggleCatSelected(row.suggestionId);
                }}
                onRemove={() => categorizations.remove([row.suggestionId])}
                onDone={(accepted) => {
                  // Accepted → the transaction is categorized server-side;
                  // keep it out of "Still uncategorized" while the
                  // transactions.rich refetch is still in flight.
                  if (accepted) markResolved([row.canonicalTransactionId]);
                  void categorizations.refetch();
                }}
              />
            ))}
          </LazyMotion>
        </section>
      ) : null}

      {nothingUncategorized && !stillUncatSettled ? <Skeleton className="h-24 w-full" /> : null}
      {stillUncategorized.length > 0 ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Still uncategorized · {stillUncategorized.length}
            </h2>
            <Link
              href="/dashboard/ledger?category=uncategorized"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Open in ledger
            </Link>
          </div>
          <p className="text-xs text-muted-foreground">
            No rule and no bank category matched these, so there is nothing to approve — pick a
            category directly. Renames, notes and splits live in the ledger.
          </p>
          <Card>
            <CardContent className="divide-y divide-border p-0">
              {stillUncategorized.slice(0, STILL_UNCATEGORIZED_CAP).map((t) => (
                <div
                  key={t.transactionId}
                  className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p
                      className="truncate text-sm font-medium"
                      title={t.originalDescription ?? t.description}
                    >
                      {merchantDisplayName(t.description)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      <Money amountMinor={t.amountMinor} currency={t.currency} /> on{' '}
                      <span className="font-mono text-xs">{t.effectiveDate}</span>
                      {' · '}
                      {t.accountName}
                    </p>
                  </div>
                  <div className="w-full shrink-0 sm:w-56">
                    <CategoryPicker
                      row={t}
                      categories={categories}
                      wide
                      onPick={(categoryLedgerAccountId, categoryName) => {
                        categorizeStillUncategorized(t, categoryLedgerAccountId, categoryName);
                      }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          {stillUncategorized.length > STILL_UNCATEGORIZED_CAP ? (
            <p className="text-xs text-muted-foreground">
              Showing the {STILL_UNCATEGORIZED_CAP} most recent —{' '}
              <Link
                href="/dashboard/ledger?category=uncategorized"
                className="underline underline-offset-2 hover:text-foreground"
              >
                see all {stillUncategorized.length} in the ledger
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Run deterministic detection ONCE on page mount, then refresh the shared
 * list cache (F-003/F-004). Decisions later invalidate the LIST only — the
 * detect RPC never re-runs per decision. The returned `detecting` flag holds
 * the section's loading state until detect + the post-detect list refresh
 * have settled, so the page can't claim "all caught up" while suggestions
 * are still landing.
 */
function useDetectOnMount(
  query: string,
  householdId: string | null,
  detect: (householdId: string) => Promise<number>,
) {
  const queryClient = useQueryClient();
  const [detecting, setDetecting] = useState(true);

  useEffect(() => {
    if (!householdId) {
      setDetecting(false);
      return;
    }
    let active = true;
    setDetecting(true);
    void (async () => {
      try {
        // Detection failures degrade to the cached/last list — same contract
        // as before: the section simply hides, never a broken page.
        await detect(householdId).catch(() => 0);
        await queryClient
          .invalidateQueries({ queryKey: keelQueryKey(query, householdId) })
          .catch(() => undefined);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setDetecting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [householdId, query, detect, queryClient]);

  return detecting;
}

/**
 * Optimistic removal over a shared keel-query list (F-003): drop rows from
 * the cached QueryResult the moment the user acts; the returned restore puts
 * back the rows that FAILED (all of them by default) in the server's
 * original order. This never fakes a server success — callers must restore
 * on error, and the post-decision invalidation reconciles with server truth.
 * Because the ReviewBadge reads the SAME cache keys, the nav count moves in
 * lockstep with every decision (F-004).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Row ties idOf to the cached QueryResult<Row> rows
function useOptimisticRemove<Row>(
  query: string,
  householdId: string | null,
  idOf: (row: Row) => string,
) {
  const queryClient = useQueryClient();
  return useCallback(
    (ids: string[]) => {
      const key = keelQueryKey(query, householdId);
      // An in-flight refetch (e.g. a previous decision's invalidation) must
      // not resurrect the row underneath the optimistic update.
      void queryClient.cancelQueries({ queryKey: key });
      const prevRows = queryClient.getQueryData<QueryResult<Row>>(key)?.rows ?? [];
      const drop = new Set(ids);
      queryClient.setQueryData<QueryResult<Row>>(key, (cur) =>
        cur ? { ...cur, rows: cur.rows.filter((r) => !drop.has(idOf(r))) } : cur,
      );
      return (restoreIds: string[] = ids) => {
        const keep = new Set(restoreIds);
        queryClient.setQueryData<QueryResult<Row>>(key, (cur) => {
          if (!cur) return cur;
          const present = new Set(cur.rows.map(idOf));
          return {
            ...cur,
            rows: prevRows.filter((r) => present.has(idOf(r)) || keep.has(idOf(r))),
          };
        });
      };
    },
    [query, householdId, idOf, queryClient],
  );
}

const linkIdOf = (r: TransferLinkRow) => r.linkId;
const suggestionIdOf = (r: CategorySuggestionRow) => r.suggestionId;
const seriesIdOf = (r: RecurringSeriesRow) => r.seriesId;

/**
 * Transfer suggestions on the SHARED react-query cache (key
 * ['keel-query', 'transfers.list', householdId] — the same key the nav
 * ReviewBadge reads), with detection triggered explicitly on page mount
 * only. `loading` covers both the list read and the initial detect pass.
 */
function useTransferSuggestions(householdId: string | null) {
  const list = useKeelQuery<TransferLinkRow>('transfers.list', householdId);
  const detecting = useDetectOnMount('transfers.list', householdId, detectTransfers);
  const remove = useOptimisticRemove<TransferLinkRow>('transfers.list', householdId, linkIdOf);
  return {
    suggested: list.rows.filter((r) => r.status === 'suggested'),
    loading: list.loading || detecting,
    remove,
    refetch: list.refetch,
  };
}

/**
 * Categorization suggestions — same shared-cache + detect-on-mount contract
 * as useTransferSuggestions.
 */
function useCategorySuggestions(householdId: string | null) {
  const list = useKeelQuery<CategorySuggestionRow>('categorization.suggestions', householdId);
  const detecting = useDetectOnMount(
    'categorization.suggestions',
    householdId,
    detectCategorySuggestions,
  );
  const remove = useOptimisticRemove<CategorySuggestionRow>(
    'categorization.suggestions',
    householdId,
    suggestionIdOf,
  );
  return {
    suggested: list.rows.filter((r) => r.status === 'suggested'),
    loading: list.loading || detecting,
    remove,
    refetch: list.refetch,
  };
}

/**
 * Law 11 "proof on demand": a plain useState disclosure (no Collapsible
 * primitive exists in components/ui, and adding a dep is out of scope).
 * The TLDR/reason line stays visible; evidence renders only when opened.
 */
function WhyDisclosure({ subject, children }: { subject: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        // N cards render N "Why?" buttons; the label ties each to its card
        // for screen readers (review finding).
        aria-label={`Why is ${subject} suggested?`}
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Why?
        <ChevronDown
          className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function TransferCard({
  link,
  householdId,
  onRemove,
  onDone,
}: {
  link: TransferLinkRow;
  householdId: string;
  /** Optimistic removal (F-003); returns a restore for the failure path. */
  onRemove: () => (failedIds?: string[]) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);

  async function act(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'reject');
    // F-003: the card disappears immediately; a failed decide restores it —
    // the optimistic UI never fakes a server success.
    const restore = onRemove();
    try {
      await decideTransfer({ householdId, linkId: link.linkId, confirm });
      toast.success(confirm ? 'Marked as a transfer.' : 'Kept as regular transactions.');
      onDone();
    } catch (err) {
      restore();
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">
              {link.outAccountName}
              <ArrowRight className="mx-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />
              {link.inAccountName}
            </p>
          </div>

          <p className="text-sm text-muted-foreground">
            <Money amountMinor={link.amountMinor} currency={link.currency} /> on{' '}
            <span className="font-mono text-xs">{link.effectiveDate}</span>
          </p>
          {/* Law 11: deterministic reason codes from real row fields — no invented confidence. */}
          <p className="text-xs text-muted-foreground">{transferReasonLine(link.dayGap)}</p>
          <WhyDisclosure subject={`the ${link.outAccountName} to ${link.inAccountName} transfer`}>
            {/*
             * Evidence table (proof on demand). Limitation: TransferLinkRow
             * carries a single shared effectiveDate + dayGap, not per-side
             * posting dates, so we show the pair date on the out side and
             * express the in side's date as the gap — rather than fetching
             * per-transaction rows the contract doesn't expose here.
             */}
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
              {[
                {
                  label: 'Out',
                  account: link.outAccountName,
                  description: link.outDescription,
                  date: link.effectiveDate,
                },
                {
                  label: 'In',
                  account: link.inAccountName,
                  description: link.inDescription,
                  // day_gap is symmetric (abs(in − out) in the detector) and
                  // the row carries only the out side's date — the in side
                  // may post BEFORE the out side, so never assert a
                  // direction we don't know (review finding: "+Nd" showed a
                  // fabricated date in the evidence panel).
                  date:
                    link.dayGap === 0
                      ? link.effectiveDate
                      : `${link.effectiveDate} ±${String(link.dayGap)}d`,
                },
              ].map((side) => (
                <div
                  key={side.label}
                  className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <span className="w-8 shrink-0 font-medium text-muted-foreground">
                    {side.label}
                  </span>
                  <span className="truncate font-medium">{side.account}</span>
                  <span className="min-w-0 truncate text-muted-foreground" title={side.description}>
                    {side.description}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">{side.date}</span>
                </div>
              ))}
              <div className="flex items-baseline gap-2 border-t border-border pt-2">
                <span className="text-muted-foreground">Both sides</span>
                <Money amountMinor={link.amountMinor} currency={link.currency} />
              </div>
            </div>
          </WhyDisclosure>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act(false);
            }}
          >
            {busy === 'reject' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <X className="size-4" />
            )}
            Not a transfer
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act(true);
            }}
          >
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Confirm transfer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A recurring transfer between the same two accounts (e.g. a weekly
 * checking → savings sweep) generates a fresh suggested pair every sync —
 * without grouping, that's N identical cards demanding N separate confirm
 * clicks forever (TRANSFER-2). This groups them into one card with a bulk
 * action, while still listing every occurrence's date so an outlier (a
 * coincidental amount match that isn't really this series) is visible
 * before a bulk "Confirm all" sweeps it in too. Each occurrence still goes
 * through its own keel_decide_transfer call — batching is a UI convenience
 * over the same audited per-decision command, not a shortcut around it.
 */
function RecurringTransferGroupCard({
  links,
  householdId,
  onRemove,
  onDone,
}: {
  links: TransferLinkRow[];
  householdId: string;
  /** Optimistic removal of the whole group (F-003); restore takes the failed ids. */
  onRemove: () => (failedIds?: string[]) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const first = links[0];
  if (!first) return null;

  async function actAll(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'reject');
    // F-003: drop the whole group immediately, decide in parallel
    // (Promise.allSettled), restore only the failures. Each occurrence still
    // goes through its own audited keel_decide_transfer call.
    const restore = onRemove();
    const results = await Promise.allSettled(
      links.map((link) => decideTransfer({ householdId, linkId: link.linkId, confirm })),
    );
    const failedIds = links
      .filter((_, i) => results[i]?.status === 'rejected')
      .map((l) => l.linkId);
    const ok = links.length - failedIds.length;
    setBusy(null);
    if (failedIds.length > 0) restore(failedIds);
    toast[failedIds.length > 0 ? 'error' : 'success'](
      failedIds.length > 0
        ? `${confirm ? 'Confirmed' : 'Rejected'} ${String(ok)}, ${String(failedIds.length)} failed.`
        : `${confirm ? 'Confirmed' : 'Rejected'} ${String(ok)} transfers.`,
    );
    onDone();
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">
              {first.outAccountName}
              <ArrowRight className="mx-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />
              {first.inAccountName}
            </p>
            <Badge variant="secondary" className="font-normal">
              {links.length} occurrences
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Same two accounts, {links.length} times — looks recurring. Review each date below, or
            confirm the whole series at once.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {links.map((link) => (
              <span
                key={link.linkId}
                className="rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
                title={`${link.outDescription} → ${link.inDescription}`}
              >
                {link.effectiveDate} · <Money amountMinor={link.amountMinor} currency={link.currency} />
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void actAll(false);
            }}
          >
            {busy === 'reject' ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
            Reject all {links.length}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void actAll(true);
            }}
          >
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Confirm all {links.length}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CategorizationCard({
  row,
  householdId,
  userId,
  selecting,
  selected,
  onToggle,
  onRemove,
  onDone,
}: {
  row: CategorySuggestionRow;
  householdId: string;
  userId: string | null;
  /** Bulk-select mode (P0-B follow-up #3): shows a checkbox, hides the
   *  per-card actions so one click can't fire both an individual and a bulk
   *  decision on the same suggestion. */
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  /** Optimistic removal (F-003); returns a restore for the failure path. */
  onRemove: () => (failedIds?: string[]) => void;
  /** Called on server success only; `accepted` distinguishes accept/dismiss. */
  onDone: (accepted: boolean) => void;
}) {
  const [busy, setBusy] = useState<null | 'accept' | 'dismiss'>(null);
  // Raw bank descriptions (not detector fingerprints) — pass through as-is;
  // the lib's uppercase-only cleanup rule applies naturally.
  const displayName = merchantDisplayName(row.description);
  const reasonLine = categorizationReasonLine({
    reasonCode: row.reasonCode,
    rulePattern: row.rulePattern,
    pfcPrimary: row.evidence.pfcPrimary ?? null,
  });

  // C17 swipe review queue: an ADDITION over the buttons below, never a
  // replacement — `act` is the SAME function a swipe or a button click
  // calls, so a swipe goes through the identical audited
  // categorization.decide_suggestion command (Law 7). Disabled during bulk
  // select (a drag would fight the checkbox gesture) and while a decision
  // is already in flight.
  const x = useMotionValue(0);
  // Law 8: red is reserved for negative money, so the dismiss hint uses a
  // neutral muted tone rather than red, even though it maps to "reject".
  const acceptHintOpacity = useTransform(x, [0, 96], [0, 1]);
  const dismissHintOpacity = useTransform(x, [-96, 0], [1, 0]);
  const swipeDisabled = Boolean(selecting) || busy !== null;

  async function act(accept: boolean) {
    if (!userId) return;
    setBusy(accept ? 'accept' : 'dismiss');
    // F-003: the card disappears immediately; a failed decide restores it —
    // the optimistic UI never fakes a server success.
    const restore = onRemove();
    try {
      await keelCommand({
        commandId: newId(),
        command: 'categorization.decide_suggestion',
        // Deterministic per decision: a retry replays, never re-executes.
        economicEventKey: `catdecide:${row.suggestionId}:${accept ? 'accept' : 'dismiss'}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: { suggestionId: row.suggestionId, accept },
      });
      toast.success(accept ? `Filed under ${row.suggestedCategoryName}.` : 'Suggestion dismissed.');
      onDone(accept);
    } catch (err) {
      restore();
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      {/* Swipe direction hints — decorative only (the buttons below carry
          the real accessible affordance), so hidden from assistive tech and
          never intercepting pointer events. */}
      <m.div
        aria-hidden="true"
        style={{ opacity: acceptHintOpacity }}
        className="pointer-events-none absolute inset-0 flex items-center rounded-xl bg-primary/10 pl-5 text-primary"
      >
        <Check className="size-5" />
      </m.div>
      <m.div
        aria-hidden="true"
        style={{ opacity: dismissHintOpacity }}
        className="pointer-events-none absolute inset-0 flex items-center justify-end rounded-xl bg-muted pr-5 text-muted-foreground"
      >
        <X className="size-5" />
      </m.div>
      <m.div
        style={{ x }}
        drag={swipeDisabled ? false : 'x'}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.6}
        dragSnapToOrigin
        onDragEnd={(_event, info) => {
          const decision = resolveSwipeDecision(info.offset.x, info.velocity.x);
          if (decision === 'accept') void act(true);
          else if (decision === 'dismiss') void act(false);
        }}
        className="touch-pan-y"
      >
        <Card>
          <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
            {selecting ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={selected ?? false}
                aria-label={`Select ${displayName}`}
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border ${
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                }`}
                onClick={onToggle}
              >
                {selected ? <Check className="size-3.5" /> : null}
              </button>
            ) : null}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-medium" title={row.originalDescription}>
                  {displayName}
                </p>
                <Badge variant="secondary" className="max-w-40 shrink-0">
                  <span className="truncate">{row.suggestedCategoryName}</span>
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                <Money amountMinor={row.amountMinor} currency={row.currency} /> on{' '}
                <span className="font-mono text-xs">{row.effectiveDate}</span>
                {' · '}
                {row.accountName}
              </p>
              {/* Law 11: deterministic reason code — a rule or the bank's PFC, never invented confidence. */}
              <p className="text-xs text-muted-foreground">{reasonLine}</p>
              <WhyDisclosure
                subject={`the ${row.suggestedCategoryName} categorization for ${displayName}`}
              >
                <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-xs">
                  {/* Raw description reachable without hover (touch parity). */}
                  <p className="break-all text-muted-foreground/80">
                    Bank memo: <span className="font-mono">{row.originalDescription}</span>
                  </p>
                  <p className="break-all text-muted-foreground/80">
                    {row.source === 'rule' ? (
                      <>
                        {/* FROZEN as-detected pattern (Law 9) — matches the reason line. */}
                        Matched rule (as detected):{' '}
                        <span className="font-mono">
                          {row.rulePattern ?? row.evidence.pattern ?? '—'}
                        </span>
                      </>
                    ) : (
                      <>
                        Bank category key:{' '}
                        <span className="font-mono">
                          {row.evidence.pfcPrimary ?? row.evidence.pfcKey ?? '—'}
                        </span>
                      </>
                    )}
                  </p>
                  {/* The rule's PRESENT text may only appear here, explicitly
                  labeled — never in the reason line (adversarial review P2-2). */}
                  {row.source === 'rule' &&
                  row.ruleLivePattern !== null &&
                  row.ruleLivePattern !== (row.rulePattern ?? row.evidence.pattern) ? (
                    <p className="break-all text-muted-foreground/80">
                      Rule as of now: <span className="font-mono">{row.ruleLivePattern}</span>
                    </p>
                  ) : null}
                  <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    {/* Current vs suggested: the change being approved, spelled out. */}
                    <span className="truncate line-through decoration-muted-foreground/60">
                      {row.currentCategoryName}
                    </span>
                    <ArrowRight className="size-3 shrink-0" aria-hidden />
                    <span className="truncate font-medium text-foreground">
                      {row.suggestedCategoryName}
                    </span>
                  </p>
                </div>
              </WhyDisclosure>
            </div>
            {selecting ? null : (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    void act(false);
                  }}
                >
                  {busy === 'dismiss' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <X className="size-4" />
                  )}
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    void act(true);
                  }}
                >
                  {busy === 'accept' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Check className="size-4" />
                  )}
                  Accept
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </m.div>
    </div>
  );
}

function SuggestionCard({
  series,
  householdId,
  userId,
  onRemove,
  onDone,
}: {
  series: RecurringSeriesRow;
  householdId: string;
  userId: string | null;
  /** Optimistic removal (F-003); returns a restore for the failure path. */
  onRemove: () => (failedIds?: string[]) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const first = series.occurrences[0];
  // Law 11: display evidence derived deterministically from the projected
  // occurrences already on the row — calendar arithmetic only, no confidence.
  const expectedDates = series.occurrences.map((o) => o.expectedDate);
  const reasonLine = recurringReasonLine({
    sign: series.sign,
    expectedDates,
    amountsMinor: series.occurrences.map((o) => o.expectedAmountMinor),
  });
  const cadence = cadenceLabel(expectedDates);

  async function act(command: 'recurring.confirm' | 'recurring.reject') {
    if (!userId) return;
    const kind = command === 'recurring.confirm' ? 'confirm' : 'reject';
    setBusy(kind);
    const effectiveDate = today();
    // F-003: the card disappears immediately; a failed command restores it —
    // the optimistic UI never fakes a server success.
    const restore = onRemove();
    try {
      // Payload is exactly {seriesId, effectiveDate(, horizonDays)} — the
      // contracts schemas are .strict(); the candidateVersionHash we used to
      // send made every confirm/reject a 400.
      await keelCommand({
        commandId: newId(),
        command,
        economicEventKey: `${command}:${series.seriesId}:${effectiveDate}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          seriesId: series.seriesId,
          effectiveDate,
          ...(command === 'recurring.confirm' ? { horizonDays: 90 } : {}),
        },
      });
      toast.success(kind === 'confirm' ? 'Recurring series confirmed.' : 'Suggestion dismissed.');
      onDone();
    } catch (err) {
      restore();
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {/* counterpartyKey is the detector's lowercased fingerprint —
                render it like a merchant; the raw key stays in the tooltip. */}
            {/* Fingerprints are lowercase machine strings — uppercase to opt
                into the lib's aggressive bank-memo cleanup (lowercase is
                treated as human-typed and left unstripped). */}
            <p className="truncate font-medium" title={series.counterpartyKey}>
              {merchantDisplayName(series.counterpartyKey.toUpperCase())}
            </p>
            <Badge variant="secondary" className="capitalize">
              {series.sign}
            </Badge>
          </div>
          {first ? (
            <p className="text-sm text-muted-foreground">
              Next <Money amountMinor={first.expectedAmountMinor} currency={first.currency} /> on{' '}
              <span className="font-mono text-xs">{first.expectedDate}</span>
              {relativeDueLabel(first.expectedDate, today()) ? (
                <span> ({relativeDueLabel(first.expectedDate, today())})</span>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Detected recurring series</p>
          )}
          <p className="text-xs text-muted-foreground">{reasonLine}</p>
          {series.occurrences.length > 0 ? (
            <WhyDisclosure
              subject={`the ${merchantDisplayName(series.counterpartyKey.toUpperCase())} recurring series`}
            >
              <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-xs">
                <p className="text-muted-foreground">
                  {series.occurrences.length} upcoming projected
                  {cadence ? ` · projected ${cadence}` : ''}
                </p>
                {/* Raw detector fingerprint, reachable without hover — the
                    title attr on the card name is unreachable on touch
                    (Law 8/9; review finding). */}
                <p className="break-all text-muted-foreground/80">
                  Matched on: <span className="font-mono">{series.counterpartyKey}</span>
                </p>
                <ul className="space-y-1">
                  {series.occurrences.map((occ) => (
                    <li
                      key={occ.occurrenceId}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <span className="font-mono text-muted-foreground">
                        {occ.expectedDate}
                        {relativeDueLabel(occ.expectedDate, today()) ? (
                          <> ({relativeDueLabel(occ.expectedDate, today())})</>
                        ) : null}
                      </span>
                      <Money amountMinor={occ.expectedAmountMinor} currency={occ.currency} />
                    </li>
                  ))}
                </ul>
              </div>
            </WhyDisclosure>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act('recurring.reject');
            }}
          >
            {busy === 'reject' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <X className="size-4" />
            )}
            Dismiss
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void act('recurring.confirm');
            }}
          >
            {busy === 'confirm' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Confirm
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
