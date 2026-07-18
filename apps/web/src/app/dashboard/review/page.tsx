'use client';

import { useEffect, useState, type ReactNode } from 'react';
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
import { useKeelQuery } from '@/lib/use-keel-query';
import { relativeDueLabel } from '@/lib/relative-date';
import { resolveSwipeDecision } from '@/lib/swipe';
import {
  keelCommand,
  newId,
  keelQuery,
  detectTransfers,
  decideTransfer,
  detectCategorySuggestions,
  type CategorySuggestionRow,
  type RecurringSeriesRow,
  type TransferLinkRow,
} from '@/lib/keel-api';
import {
  cadenceLabel,
  categorizationReasonLine,
  recurringReasonLine,
  transferReasonLine,
} from '@/lib/recurring-evidence';
import { groupTransfersByAccountPair } from '@/lib/transfer-grouping';
import { merchantDisplayName } from '@/lib/merchant-name';
import { Button } from '@/components/ui/button';
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

function ReviewBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );
  const transfers = useTransferSuggestions(householdId);
  const categorizations = useCategorySuggestions(householdId);
  // Bulk approve/dismiss (P0-B follow-up #3): client-side convenience over
  // the SAME audited command as a single decision — one
  // categorization.decide_suggestion call per selected id, never a shortcut
  // around Law 2's per-mutation audit_log requirement.
  const [catSelecting, setCatSelecting] = useState(false);
  const [catSelected, setCatSelected] = useState<Set<string>>(new Set());
  const [catBulkBusy, setCatBulkBusy] = useState(false);

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
    setCatBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const suggestionId of catSelected) {
      try {
        await keelCommand({
          commandId: newId(),
          command: 'categorization.decide_suggestion',
          // Deterministic per decision, exactly like the single-card action:
          // a retry replays, never re-executes (Law 9).
          economicEventKey: `catdecide:${suggestionId}:${accept ? 'accept' : 'dismiss'}`,
          actor: { kind: 'user', userId },
          householdId,
          payload: { suggestionId, accept },
        });
        ok++;
      } catch {
        failed++;
      }
    }
    setCatBulkBusy(false);
    setCatSelected(new Set());
    setCatSelecting(false);
    toast[failed > 0 ? 'error' : 'success'](
      failed > 0
        ? `${accept ? 'Approved' : 'Dismissed'} ${String(ok)}, ${String(failed)} failed.`
        : `${accept ? 'Approved' : 'Dismissed'} ${String(ok)} suggestion${ok === 1 ? '' : 's'}.`,
    );
    await categorizations.refetch();
  }

  const suggested = rows.filter((r) => r.status === 'suggested');

  if (!ready || (loading && transfers.loading && categorizations.loading)) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const nothingRecurring = Boolean(error) || suggested.length === 0;
  const nothingTransfers = transfers.suggested.length === 0;
  const nothingCategorizations = categorizations.suggested.length === 0;

  if (error && nothingTransfers && nothingCategorizations) {
    return (
      <EmptyState
        icon={<BadgeCheck className="size-6" />}
        title="Couldn't load suggestions"
        description={error}
      />
    );
  }

  if (!householdId || (nothingRecurring && nothingTransfers && nothingCategorizations)) {
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
                  onDone={() => {
                    void transfers.refetch();
                  }}
                />
              ) : (
                <TransferCard
                  key={first.linkId}
                  link={first}
                  householdId={householdId}
                  onDone={() => {
                    void transfers.refetch();
                  }}
                />
              ),
            ];
          })}
        </section>
      ) : null}

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
              onDone={() => {
                void refetch();
              }}
            />
          ))}
        </section>
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
                onDone={() => {
                  void categorizations.refetch();
                }}
              />
            ))}
          </LazyMotion>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Detect (deterministic, idempotent) then list transfer suggestions.
 * Detection failures degrade to an empty list — the section simply hides
 * until the backend supports it.
 */
function useTransferSuggestions(householdId: string | null) {
  const [rows, setRows] = useState<TransferLinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!householdId) {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await detectTransfers(householdId).catch(() => 0);
        const res = await keelQuery<TransferLinkRow>('transfers.list', householdId);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows(res.rows);
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows([]);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [householdId, reload]);

  return {
    suggested: rows.filter((r) => r.status === 'suggested'),
    loading,
    refetch: () => {
      setReload((n) => n + 1);
      return Promise.resolve();
    },
  };
}

/**
 * Detect (deterministic, idempotent) then list categorization suggestions.
 * Same degrade contract as useTransferSuggestions: any failure renders as an
 * empty section, never a broken page.
 */
function useCategorySuggestions(householdId: string | null) {
  const [rows, setRows] = useState<CategorySuggestionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!householdId) {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await detectCategorySuggestions(householdId).catch(() => 0);
        const res = await keelQuery<CategorySuggestionRow>(
          'categorization.suggestions',
          householdId,
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows(res.rows);
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setRows([]);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [householdId, reload]);

  return {
    suggested: rows.filter((r) => r.status === 'suggested'),
    loading,
    refetch: () => {
      setReload((n) => n + 1);
      return Promise.resolve();
    },
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
  onDone,
}: {
  link: TransferLinkRow;
  householdId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);

  async function act(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'reject');
    try {
      await decideTransfer({ householdId, linkId: link.linkId, confirm });
      toast.success(confirm ? 'Marked as a transfer.' : 'Kept as regular transactions.');
      onDone();
    } catch (err) {
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
  onDone,
}: {
  links: TransferLinkRow[];
  householdId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'confirm' | 'reject'>(null);
  const first = links[0];
  if (!first) return null;

  async function actAll(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'reject');
    let ok = 0;
    let failed = 0;
    for (const link of links) {
      try {
        await decideTransfer({ householdId, linkId: link.linkId, confirm });
        ok++;
      } catch {
        failed++;
      }
    }
    setBusy(null);
    toast[failed > 0 ? 'error' : 'success'](
      failed > 0
        ? `${confirm ? 'Confirmed' : 'Rejected'} ${String(ok)}, ${String(failed)} failed.`
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
  onDone: () => void;
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
      onDone();
    } catch (err) {
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
  onDone,
}: {
  series: RecurringSeriesRow;
  householdId: string;
  userId: string | null;
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
