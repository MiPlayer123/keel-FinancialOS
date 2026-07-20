'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Repeat, Loader2, CalendarClock, Plus, Pause, Play, CheckCircle2, SkipForward, XCircle, Banknote, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import { relativeDueLabel } from '@/lib/relative-date';
import { BalanceTrendChart, type BalancePoint } from '@/components/keel/charts';
import {
  advanceSchedule,
  enterSchedule,
  fetchAccounts,
  fetchCategories,
  fetchLedgerKinds,
  fetchSchedules,
  fetchRecurringClassification,
  fetchRecurringScheduleLinks,
  linkRecurringSchedule,
  unlinkRecurringSchedule,
  saveSchedule,
  setScheduleStatus,
  type AccountRow,
  type CategoryRow,
  type RecurringBucket,
  type RecurringClassificationRow,
  type RecurringScheduleLink,
  type RecurringSeriesRow,
  type ScheduleRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import {
  RECURRING_ACTIONS,
  CADENCE_SUFFIX,
  recurringTransition,
  nextOccurrence,
  changedToday,
  stepScheduleDue,
  annualizedEstimate,
  type RecurringCommand,
} from '@/lib/recurring';
import { RECURRING_BUCKET_BADGE_LABELS } from '@/lib/recurring-bucket';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { parseSignedDollars } from '@/lib/hash';
import { entityLabel, hasMultipleEntities, scopeToEntity } from '@/lib/category-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { useEffect } from 'react';

export default function RecurringPage() {
  return (
    <>
      <PageHeader
        title="Recurring"
        description="Subscriptions, bills, and recurring income KEEL has detected — confirm, pause or stop tracking them."
      />
      <div className="p-6">
        <RecurringBody />
      </div>
    </>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function RecurringBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RecurringSeriesRow>(
    'recurring.list',
    householdId,
  );
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const balanceRows = useKeelQuerySilent<TrialBalanceRow>('ledger.trial_balance', householdId);
  const [ledgerKinds, setLedgerKinds] = useState<Map<string, string>>(new Map());
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [classification, setClassification] = useState<RecurringClassificationRow[]>([]);
  const [links, setLinks] = useState<RecurringScheduleLink[]>([]);

  const reloadSchedules = useCallback(() => {
    if (!householdId) return;
    void fetchSchedules(householdId)
      .then(setSchedules)
      .catch(() => {
        setSchedules([]);
      });
  }, [householdId]);

  const reloadLinks = useCallback(() => {
    if (!householdId) return;
    void fetchRecurringScheduleLinks(householdId)
      .then(setLinks)
      .catch(() => {
        setLinks([]);
      });
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
    void fetchLedgerKinds(householdId)
      .then(setLedgerKinds)
      .catch(() => {
        setLedgerKinds(new Map());
      });
    void fetchCategories(householdId)
      .then(setCategories)
      .catch(() => {
        setCategories([]);
      });
    void fetchRecurringClassification(householdId)
      .then(setClassification)
      .catch(() => {
        setClassification([]);
      });
    reloadSchedules();
    reloadLinks();
  }, [householdId, reloadSchedules, reloadLinks]);

  // seriesId → bucket, and seriesId → active link (if any).
  const bucketBySeries = useMemo(
    () => new Map(classification.map((c) => [c.seriesId, c.bucket])),
    [classification],
  );
  const linkBySeries = useMemo(
    () => new Map(links.map((l) => [l.seriesId, l])),
    [links],
  );
  const linkedScheduleIds = useMemo(
    () => new Set(links.map((l) => l.scheduleId)),
    [links],
  );

  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? '';
  }, [accounts]);

  if (!ready || loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<Repeat className="size-6" />}
        title="Couldn't load recurring series"
        description={error}
      />
    );
  }

  const today = todayIso();
  const active = rows.filter((r) => r.status === 'confirmed');
  const suggested = rows.filter((r) => r.status === 'suggested');
  const paused = rows.filter((r) => r.status === 'paused');

  if (!householdId) {
    return (
      <EmptyState
        icon={<Repeat className="size-6" />}
        title="No recurring activity yet"
        description="As transactions sync, KEEL detects subscriptions and regular bills and suggests them here for your approval. Detection runs nightly."
      />
    );
  }
  const nothingDetected =
    active.length === 0 && suggested.length === 0 && paused.length === 0;

  const upcoming = active
    .flatMap((s) =>
      s.occurrences
        .filter((o) => o.status === 'expected' && o.expectedDate >= today)
        .map((o) => ({ series: s, occ: o })),
    )
    .sort((a, b) => a.occ.expectedDate.localeCompare(b.occ.expectedDate))
    .slice(0, 12);

  return (
    <div className="space-y-8">
      <ScheduledSection
        householdId={householdId}
        userId={userId}
        accounts={accounts}
        categories={categories}
        schedules={schedules}
        today={today}
        onChanged={reloadSchedules}
      />

      {nothingDetected ? (
        <EmptyState
          icon={<Repeat className="size-6" />}
          title="No recurring activity detected yet"
          description="As transactions sync, KEEL detects subscriptions and regular bills and suggests them here for your approval. Detection runs nightly."
        />
      ) : null}

      {upcoming.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Coming up</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {upcoming.map(({ series, occ }, i) => (
              <div
                key={occ.occurrenceId}
                className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                  {occ.expectedDate.slice(5)}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm">{series.counterpartyKey}</p>
                <Money
                  amountMinor={
                    series.sign === 'outflow'
                      ? `-${occ.expectedAmountMinor}`
                      : occ.expectedAmountMinor
                  }
                  currency={occ.currency}
                  signed
                  className="shrink-0 text-sm"
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <OccurrenceCalendar rows={active} />

      <ProjectedCash
        series={active}
        schedules={schedules}
        linkedScheduleIds={linkedScheduleIds}
        balances={balanceRows ?? []}
        accounts={accounts}
        ledgerKinds={ledgerKinds}
      />

      {/* B: two clearly separated lanes — outflow subscriptions/bills, and
          recurring income (paychecks etc.). Non-paycheck inflows (cashback,
          Venmo) are suppressed at detection (C) and never reach either lane. */}
      <RecurringLanes
        lane="expense"
        heading="Subscriptions & bills"
        suggested={suggested}
        active={active}
        paused={paused}
        bucketBySeries={bucketBySeries}
        linkBySeries={linkBySeries}
        schedules={schedules}
        linkedScheduleIds={linkedScheduleIds}
        accountName={accountName}
        householdId={householdId}
        userId={userId}
        onDone={() => void refetch()}
        onLinksChanged={reloadLinks}
      />

      <RecurringLanes
        lane="income"
        heading="Recurring income"
        suggested={suggested}
        active={active}
        paused={paused}
        bucketBySeries={bucketBySeries}
        linkBySeries={linkBySeries}
        schedules={schedules}
        linkedScheduleIds={linkedScheduleIds}
        accountName={accountName}
        householdId={householdId}
        userId={userId}
        onDone={() => void refetch()}
        onLinksChanged={reloadLinks}
      />
    </div>
  );
}

// B: one lane (expense or income) rendered across the three statuses. A lane with
// no series in it renders nothing (its heading never appears empty).
function RecurringLanes({
  lane,
  heading,
  suggested,
  active,
  paused,
  bucketBySeries,
  linkBySeries,
  schedules,
  linkedScheduleIds,
  accountName,
  householdId,
  userId,
  onDone,
  onLinksChanged,
}: {
  lane: 'expense' | 'income';
  heading: string;
  suggested: RecurringSeriesRow[];
  active: RecurringSeriesRow[];
  paused: RecurringSeriesRow[];
  bucketBySeries: Map<string, RecurringBucket>;
  linkBySeries: Map<string, RecurringScheduleLink>;
  schedules: ScheduleRow[];
  linkedScheduleIds: Set<string>;
  accountName: (id: string) => string;
  householdId: string;
  userId: string | null;
  onDone: () => void;
  onLinksChanged: () => void;
}) {
  const inLane = (rows: RecurringSeriesRow[]) =>
    rows.filter((s) =>
      isExcludedSeries(s, bucketBySeries)
        ? false
        : lane === 'income'
          ? isIncomeSeries(s, bucketBySeries)
          : !isIncomeSeries(s, bucketBySeries),
    );
  const laneSuggested = inLane(suggested);
  const laneActive = inLane(active);
  const lanePaused = inLane(paused);
  if (laneSuggested.length === 0 && laneActive.length === 0 && lanePaused.length === 0) {
    return null;
  }

  const suggestHint =
    lane === 'income'
      ? 'Detected recurring income (paychecks, transfers in) — confirm to track it.'
      : 'Detected from your transaction history — nothing is tracked until you confirm.';

  const shared = {
    bucketBySeries,
    linkBySeries,
    schedules,
    linkedScheduleIds,
    accountName,
    householdId,
    userId,
    onDone,
    onLinksChanged,
    lane,
  } as const;

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold">{heading}</h2>
      {laneSuggested.length > 0 ? (
        <SeriesSection title="Suggested" hint={suggestHint} rows={laneSuggested} {...shared} />
      ) : null}
      {laneActive.length > 0 ? (
        <SeriesSection title="Active" rows={laneActive} {...shared} />
      ) : null}
      {lanePaused.length > 0 ? (
        <SeriesSection title="Paused" rows={lanePaused} {...shared} />
      ) : null}
    </div>
  );
}

// Outflow buckets only — the "Subscriptions & Bills" surface. Income is a
// separate lane (see B, docs/RECURRING-RESEARCH.md): paychecks and other
// recurring inflows are not subscriptions and must not sit in this list.
// 'recurring' (classifier v4) = generic recurring expense — cadence evidenced,
// kind not — grouped last, after the kinds KEEL can actually vouch for.
const EXPENSE_BUCKET_ORDER: RecurringBucket[] = ['bill', 'utility', 'subscription', 'recurring'];
const BUCKET_LABELS: Record<RecurringBucket, string> = {
  income: 'Income',
  paycheck: 'Paychecks',
  bill: 'Bills',
  utility: 'Utilities',
  subscription: 'Subscriptions',
  recurring: 'Recurring',
  excluded: 'Excluded',
};

// C: a series classified 'excluded' (personal P2P transfer) is offered on
// neither lane — it is not a subscription/bill and not income.
function isExcludedSeries(
  s: RecurringSeriesRow,
  bucketBySeries: Map<string, RecurringBucket>,
): boolean {
  return bucketBySeries.get(s.seriesId) === 'excluded';
}

// B: a series is "income" when its classification bucket is income, or (for
// legacy/unclassified candidates) when its sign is inflow. Everything else is an
// outflow subscription/bill. Cashback/Venmo inflows are suppressed at detection
// now (C), so this lane holds genuine recurring income (paychecks, transfers in).
function isIncomeSeries(
  s: RecurringSeriesRow,
  bucketBySeries: Map<string, RecurringBucket>,
): boolean {
  if (isExcludedSeries(s, bucketBySeries)) return false;
  const bucket = bucketBySeries.get(s.seriesId);
  // Both plain income AND paychecks live on the income lane (a paycheck is
  // income, just marked distinctly). Everything else classified is an outflow.
  if (bucket) return bucket === 'income' || bucket === 'paycheck';
  return s.sign === 'inflow';
}

function SeriesSection({
  title,
  hint,
  rows,
  bucketBySeries,
  linkBySeries,
  schedules,
  linkedScheduleIds,
  accountName,
  householdId,
  userId,
  onDone,
  onLinksChanged,
  // B: when 'income', render inflow series under a single Income lane (no
  // subscription sub-buckets); when 'expense', render only outflow buckets.
  lane,
}: {
  title: string;
  hint?: string;
  rows: RecurringSeriesRow[];
  bucketBySeries: Map<string, RecurringBucket>;
  linkBySeries: Map<string, RecurringScheduleLink>;
  schedules: ScheduleRow[];
  linkedScheduleIds: Set<string>;
  accountName: (id: string) => string;
  householdId: string;
  userId: string | null;
  onDone: () => void;
  onLinksChanged: () => void;
  lane: 'expense' | 'income';
}) {
  // Group by classification bucket, but only within this lane. Income rows never
  // appear in the expense lane and vice versa.
  const groups = useMemo<{ bucket: RecurringBucket; rows: RecurringSeriesRow[] }[]>(() => {
    const laneRows = rows.filter((s) =>
      isExcludedSeries(s, bucketBySeries)
        ? false
        : lane === 'income'
          ? isIncomeSeries(s, bucketBySeries)
          : !isIncomeSeries(s, bucketBySeries),
    );
    if (lane === 'income') {
      // One flat Income group — no subscription sub-headings on the income lane.
      return laneRows.length > 0 ? [{ bucket: 'income', rows: laneRows }] : [];
    }
    const byBucket = new Map<RecurringBucket, RecurringSeriesRow[]>();
    for (const s of laneRows) {
      // Unclassified (no classification row yet) is a *generic* recurring
      // expense, never a claimed "subscription" (GAP-2: no evidence, no claim).
      const bucket = bucketBySeries.get(s.seriesId) ?? 'recurring';
      const list = byBucket.get(bucket) ?? [];
      list.push(s);
      byBucket.set(bucket, list);
    }
    return EXPENSE_BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
      bucket: b,
      rows: byBucket.get(b) ?? [],
    }));
  }, [rows, bucketBySeries, lane]);

  if (groups.length === 0) return null;

  const showBucketHeadings = lane === 'expense' && groups.length > 1;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {groups.map((g) => (
        <div key={g.bucket} className="space-y-2">
          {showBucketHeadings ? (
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {BUCKET_LABELS[g.bucket]}
            </h3>
          ) : null}
          {g.rows.map((s) => (
            <SeriesCard
              key={s.seriesId}
              series={s}
              bucket={bucketBySeries.get(s.seriesId) ?? null}
              accountName={accountName(s.accountId)}
              link={linkBySeries.get(s.seriesId) ?? null}
              schedules={schedules}
              linkedScheduleIds={linkedScheduleIds}
              householdId={householdId}
              userId={userId}
              onDone={onDone}
              onLinksChanged={onLinksChanged}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function SeriesCard({
  series,
  bucket,
  accountName,
  link,
  schedules,
  linkedScheduleIds,
  householdId,
  userId,
  onDone,
  onLinksChanged,
}: {
  series: RecurringSeriesRow;
  bucket: RecurringBucket | null;
  accountName: string;
  link: RecurringScheduleLink | null;
  schedules: ScheduleRow[];
  linkedScheduleIds: Set<string>;
  householdId: string;
  userId: string | null;
  onDone: () => void;
  onLinksChanged: () => void;
}) {
  const [busy, setBusy] = useState<RecurringCommand | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const next = nextOccurrence(series, todayIso());
  const lockedToday = series.status !== 'suggested' && changedToday(series, todayIso());
  const actions = RECURRING_ACTIONS[series.status];

  // Same-direction schedules not already linked to another series are eligible
  // to merge with this one so the projection stops double-counting.
  const linkableSchedules = useMemo(
    () =>
      schedules.filter(
        (sc) =>
          !linkedScheduleIds.has(sc.scheduleId) &&
          (series.sign === 'inflow') === BigInt(sc.amountMinor || '0') > 0n,
      ),
    [schedules, linkedScheduleIds, series.sign],
  );
  const linkedSchedule = link
    ? schedules.find((sc) => sc.scheduleId === link.scheduleId)
    : undefined;

  async function doLink(scheduleId: string) {
    if (!userId) return;
    setLinkBusy(true);
    try {
      await linkRecurringSchedule({ householdId, userId, seriesId: series.seriesId, scheduleId });
      toast.success('Linked — the projection now counts this once.');
      onLinksChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link the schedule.');
    } finally {
      setLinkBusy(false);
    }
  }
  async function doUnlink() {
    if (!userId || !link) return;
    setLinkBusy(true);
    try {
      await unlinkRecurringSchedule({ householdId, userId, linkId: link.linkId });
      toast.success('Unlinked.');
      onLinksChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink.');
    } finally {
      setLinkBusy(false);
    }
  }
  // Estimated annual total (teardown C13: "$X/mo · ~$Y/yr"). Derived purely
  // from this series' own projected occurrences — null (shown as nothing)
  // rather than a guess when the cadence isn't confidently inferable (Law 9).
  const estimate = useMemo(() => annualizedEstimate(series.occurrences), [series.occurrences]);

  async function act(command: RecurringCommand) {
    if (!userId) return;
    setBusy(command);
    try {
      await recurringTransition({ command, seriesId: series.seriesId, householdId, userId });
      toast.success('Updated.');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{series.counterpartyKey}</p>
            {bucket === 'paycheck' ? (
              <>
                {/* PAYROLL/WAGES: clearly marked as a paycheck, and linked to the
                    Paychecks page where it's confirm-or-decline. Non-payroll
                    income (dividends, interest) shows no such badge. */}
                <Badge className="gap-1">
                  <Banknote className="size-3" />
                  Paycheck
                </Badge>
                <Link
                  href="/dashboard/paychecks"
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Tracked on Paychecks
                  <ArrowRight className="size-3" />
                </Link>
              </>
            ) : series.sign === 'inflow' ? (
              <Badge variant="outline" className="text-muted-foreground">
                Recurring income
              </Badge>
            ) : (
              /* Outflow: the classifier's bucket, adjacent to the name it
                 qualifies (Law 8). "Recurring" is the neutral generic —
                 cadence evidenced, kind not (classifier v4) — and also the
                 honest placeholder while classification hasn't loaded. */
              <Badge variant="secondary">
                {RECURRING_BUCKET_BADGE_LABELS[bucket ?? 'recurring']}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {accountName}
            {next ? (
              <>
                {accountName ? ' · ' : ''}
                next <Money amountMinor={next.expectedAmountMinor} currency={next.currency} /> on{' '}
                <span className="font-mono">{next.expectedDate}</span>
                {relativeDueLabel(next.expectedDate, todayIso()) ? (
                  <span> ({relativeDueLabel(next.expectedDate, todayIso())})</span>
                ) : null}
              </>
            ) : null}
          </p>
          {estimate ? (
            <p className="text-xs text-muted-foreground">
              <Money amountMinor={estimate.amountMinor} currency={estimate.currency} />
              {CADENCE_SUFFIX[estimate.cadence]}
              {estimate.cadence !== 'annual' ? (
                <>
                  {' · ~'}
                  <Money amountMinor={estimate.annualMinor.toString()} currency={estimate.currency} />
                  {CADENCE_SUFFIX.annual}
                </>
              ) : null}
            </p>
          ) : null}
          {/* F-028: merge a manual schedule with this detected series so the
              projection stops double-counting. */}
          {series.status === 'confirmed' ? (
            linkedSchedule ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Linked to schedule &ldquo;{linkedSchedule.description}&rdquo; — counted once.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={linkBusy}
                  onClick={() => void doUnlink()}
                >
                  Unlink
                </Button>
              </p>
            ) : linkableSchedules.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Same as a schedule?</span>
                <Select
                  value=""
                  items={Object.fromEntries(
                    linkableSchedules.map((sc) => [sc.scheduleId, sc.description]),
                  )}
                  onValueChange={(v) => {
                    if (v) void doLink(v);
                  }}
                >
                  <SelectTrigger className="h-7 w-44 text-xs" disabled={linkBusy}>
                    <SelectValue placeholder="Link a schedule…" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkableSchedules.map((sc) => (
                      <SelectItem key={sc.scheduleId} value={sc.scheduleId}>
                        {sc.description}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {lockedToday ? (
            <span className="text-xs text-muted-foreground">
              Changed today — next change available tomorrow.
            </span>
          ) : (
            actions.map(({ command, label }, i) => (
              <Button
                key={command}
                variant={i === 0 ? 'default' : 'outline'}
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  void act(command);
                }}
              >
                {busy === command ? <Loader2 className="size-4 animate-spin" /> : null}
                {label}
              </Button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Month calendar of expected occurrences (confirmed series only). Pure
// layout over data the page already has; amounts stay minor-unit strings.
// ---------------------------------------------------------------------------
function OccurrenceCalendar({ rows }: { rows: RecurringSeriesRow[] }) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = first.getUTCDay(); // 0 = Sunday
  const nowIso = now.toISOString().slice(0, 10);
  const monthKey = nowIso.slice(0, 7);

  const byDay = new Map<
    number,
    { name: string; signedMinor: string; currency: string; paid: boolean }[]
  >();
  for (const s of rows) {
    if (s.status !== 'confirmed') continue;
    for (const o of s.occurrences) {
      // Upcoming (expected) and already-paid (matched) only; a missed
      // occurrence at its expected amount would read as a bill still due.
      if (o.status !== 'expected' && o.status !== 'matched') continue;
      if (!o.expectedDate.startsWith(monthKey)) continue;
      const day = Number(o.expectedDate.slice(8, 10));
      const list = byDay.get(day) ?? [];
      list.push({
        name: s.counterpartyKey,
        signedMinor:
          s.sign === 'outflow' ? `-${o.expectedAmountMinor}` : o.expectedAmountMinor,
        currency: o.currency,
        paid: o.status === 'matched',
      });
      byDay.set(day, list);
    }
  }
  if (byDay.size === 0) return null;

  const monthName = ['January','February','March','April','May','June','July','August','September','October','November','December'][month];

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {monthName} {String(year)}
      </h2>
      <div className="overflow-x-auto">
        <div className="min-w-[560px] overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-7 border-b border-border bg-secondary/30 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: lead }).map((_, i) => (
              <div key={`lead-${String(i)}`} className="min-h-16 border-b border-r border-border/60" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const iso = `${monthKey}-${String(day).padStart(2, '0')}`;
              const items = byDay.get(day) ?? [];
              const isToday = iso === nowIso;
              return (
                <div
                  key={day}
                  className={`min-h-16 space-y-0.5 border-b border-r border-border/60 p-1 ${
                    isToday ? 'bg-secondary/40' : ''
                  }`}
                >
                  <p
                    className={`text-right text-[11px] ${
                      isToday ? 'font-semibold' : 'text-muted-foreground'
                    }`}
                  >
                    {String(day)}
                  </p>
                  {items.slice(0, 2).map((item, idx) => (
                    <p
                      key={`${item.name}-${String(idx)}`}
                      className={`truncate text-[11px] leading-tight ${
                        item.paid ? 'text-muted-foreground/70 line-through decoration-border' : ''
                      }`}
                      title={item.paid ? `${item.name} — paid` : item.name}
                    >
                      {item.name}
                      <span className="text-muted-foreground">
                        {' '}
                        <Money amountMinor={item.signedMinor} currency={item.currency} signed className="text-[11px]" />
                      </span>
                    </p>
                  ))}
                  {items.length > 2 ? (
                    <p className="text-[10px] text-muted-foreground">+{String(items.length - 2)}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Projected cash: today's asset balances rolled forward through the expected
// occurrences of confirmed series (Quicken's "Projected Balances", household
// level). Pure BigInt arithmetic over data already on the page — Law 1.
// Approximation, stated in the caption: card-charged subscriptions reduce the
// projection when charged, not when the card is paid.
// ---------------------------------------------------------------------------
const PROJECTION_DAYS = 60;

function ProjectedCash({
  series,
  schedules,
  linkedScheduleIds,
  balances,
  accounts,
  ledgerKinds,
}: {
  series: RecurringSeriesRow[];
  schedules: ScheduleRow[];
  linkedScheduleIds: Set<string>;
  balances: TrialBalanceRow[];
  accounts: AccountRow[];
  ledgerKinds: Map<string, string>;
}) {
  const projection = useMemo(() => {
    if (balances.length === 0 || ledgerKinds.size === 0) return null;
    const assetLedgerIds = new Set(
      accounts
        .filter((a) => ledgerKinds.get(a.ledgerAccountId) === 'asset')
        .map((a) => a.ledgerAccountId),
    );
    if (assetLedgerIds.size === 0) return null;
    const assetRows = balances.filter((b) => assetLedgerIds.has(b.ledgerAccountId));
    if (assetRows.length === 0) return null;
    // Single-currency projection: the dominant currency across asset accounts.
    const counts = new Map<string, number>();
    for (const b of assetRows) counts.set(b.currency, (counts.get(b.currency) ?? 0) + 1);
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
    let base = 0n;
    for (const b of assetRows) {
      if (b.currency === currency) base += BigInt(b.balanceMinor || '0');
    }

    const start = new Date();
    const startIso = start.toISOString().slice(0, 10);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + PROJECTION_DAYS);
    const endIso = end.toISOString().slice(0, 10);

    const deltaByDate = new Map<string, bigint>();
    for (const s of series) {
      if (s.status !== 'confirmed') continue;
      for (const o of s.occurrences) {
        if (o.status !== 'expected') continue;
        if (o.currency !== currency) continue;
        if (o.expectedDate <= startIso || o.expectedDate > endIso) continue;
        const amt = BigInt(o.expectedAmountMinor || '0');
        const delta = s.sign === 'outflow' ? -amt : amt;
        deltaByDate.set(o.expectedDate, (deltaByDate.get(o.expectedDate) ?? 0n) + delta);
      }
    }
    // User-declared schedules project too: expand active schedules' due dates
    // through the horizon (stepDue mirrors the server's month clamping).
    for (const sc of schedules) {
      if (sc.status !== 'active') continue;
      if (sc.currency !== currency) continue;
      // F-028: a schedule linked to a detected series is the same economic
      // stream — count the detected series only, never both.
      if (linkedScheduleIds.has(sc.scheduleId)) continue;
      let due = sc.nextDueDate;
      let guard = 0;
      while (due <= endIso && guard < 200) {
        if (due > startIso) {
          deltaByDate.set(due, (deltaByDate.get(due) ?? 0n) + BigInt(sc.amountMinor || '0'));
        }
        if (sc.frequency === 'once') break;
        due = stepScheduleDue(due, sc.frequency, sc.anchorDay, sc.anchorDay2);
        guard += 1;
      }
    }
    if (deltaByDate.size === 0) return null;

    const points: BalancePoint[] = [{ date: startIso, balanceMinor: base.toString(), currency }];
    let running = base;
    let low = base;
    let lowDate = startIso;
    for (const [date, delta] of [...deltaByDate.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      running += delta;
      points.push({ date, balanceMinor: running.toString(), currency });
      if (running < low) {
        low = running;
        lowDate = date;
      }
    }
    points.push({ date: endIso, balanceMinor: running.toString(), currency });
    return { points, low, lowDate, currency };
  }, [series, schedules, linkedScheduleIds, balances, accounts, ledgerKinds]);

  if (!projection) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Projected cash · next {PROJECTION_DAYS} days
      </h2>
      <div className="rounded-lg border border-border p-4">
        <BalanceTrendChart points={projection.points} height={180} />
        <p className="mt-2 text-xs text-muted-foreground">
          Today&apos;s asset balances rolled forward through confirmed recurring bills,
          income, and your schedules. Link a schedule to the detected series it
          duplicates and it&apos;s counted once. Lowest point:{' '}
          <Money
            amountMinor={projection.low.toString()}
            currency={projection.currency}
            className="text-xs"
          />{' '}
          around {projection.lowDate}. Card-charged subscriptions are counted when they
          charge, not when the card is paid.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Scheduled bills & income (Quicken reminders): user-declared schedules with
// Enter/Skip. Enter posts a REAL manual transaction through the envelope with
// attemptKey sched:{id}:{due} — the same occurrence can never post twice
// (idempotent economics) — then rolls the due date forward; Skip only rolls.
// ---------------------------------------------------------------------------
const FREQUENCY_LABELS: Record<ScheduleRow['frequency'], string> = {
  once: 'One time',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month (15th & 30th)',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 months',
  annual: 'Yearly',
};

function ScheduledSection({
  householdId,
  userId,
  accounts,
  categories,
  schedules,
  today,
  onChanged,
}: {
  householdId: string;
  userId: string | null;
  accounts: AccountRow[];
  categories: CategoryRow[];
  schedules: ScheduleRow[];
  today: string;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  async function enter(s: ScheduleRow) {
    if (!userId) return;
    if (!s.categoryLedgerAccountId) {
      toast.error('Give this schedule a category first (edit it) so Enter can post.');
      return;
    }
    setBusyId(s.scheduleId);
    try {
      // Server-side atomic: post + advance commit (or roll back) together in
      // one call — no client-side re-read, no two-step post-then-advance race.
      const res = await enterSchedule({
        householdId,
        scheduleId: s.scheduleId,
        fromDueDate: s.nextDueDate,
      });
      if (!res.entered) {
        toast.info('This occurrence changed elsewhere — refreshed.');
      } else if (res.idempotentReplay) {
        toast.info('Already entered — nothing new posted.');
      } else {
        toast.success(`Entered ${s.description} — it's in the ledger now.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not enter the transaction.');
    } finally {
      onChanged();
      setBusyId(null);
    }
  }

  async function skip(s: ScheduleRow) {
    setBusyId(s.scheduleId);
    try {
      await advanceSchedule({
        householdId,
        scheduleId: s.scheduleId,
        fromDueDate: s.nextDueDate,
        reason: 'skipped',
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not skip it.');
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(s: ScheduleRow, status: 'active' | 'paused' | 'ended') {
    setBusyId(s.scheduleId);
    try {
      await setScheduleStatus({ householdId, scheduleId: s.scheduleId, status });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the schedule.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Bills &amp; scheduled</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
      {schedules.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
          Rent, insurance, a paycheck — anything you know is coming. KEEL shows it as
          due, projects it into your balance curve, and one click enters it into the
          ledger on the day.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {schedules.map((s, i) => {
            const isDue = s.status === 'active' && s.nextDueDate <= today;
            // The manual-transaction envelope rejects dates > today + 1 year.
            const tooFarOut =
              (Date.parse(s.nextDueDate) - Date.parse(today)) / 86400000 > 365;
            const dueSoon =
              s.status === 'active' &&
              !isDue &&
              s.autoEnterDays !== null &&
              s.autoEnterDays > 0 &&
              (Date.parse(s.nextDueDate) - Date.parse(today)) / 86400000 <= s.autoEnterDays;
            return (
              <div
                key={s.scheduleId}
                className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border' : ''} ${s.status === 'paused' ? 'opacity-60' : ''}`}
              >
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                  {s.nextDueDate.slice(5)}
                </span>
                <p className="min-w-0 flex-1 truncate text-sm" title={s.description}>
                  {s.description}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {FREQUENCY_LABELS[s.frequency]} · {accountNames.get(s.accountId) ?? ''}
                    {s.categoryName ? ` · ${s.categoryName}` : ''}
                  </span>
                </p>
                {isDue ? (
                  <Badge variant="secondary">
                    {s.nextDueDate < today
                      ? `Overdue · ${relativeDueLabel(s.nextDueDate, today) ?? s.nextDueDate}`
                      : 'Due today'}
                  </Badge>
                ) : null}
                {dueSoon ? (
                  <Badge variant="outline">{relativeDueLabel(s.nextDueDate, today) ?? 'Due soon'}</Badge>
                ) : null}
                {s.status === 'paused' ? <Badge variant="outline">Paused</Badge> : null}
                <Money
                  amountMinor={s.amountMinor}
                  currency={s.currency}
                  signed
                  className="shrink-0 text-sm"
                />
                <span className="flex shrink-0 items-center gap-0.5">
                  {s.status === 'active' ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Enter ${s.description}`}
                        title={
                          tooFarOut
                            ? 'Too far out to post — the ledger takes dates up to a year ahead'
                            : 'Enter into the ledger'
                        }
                        disabled={busyId === s.scheduleId || tooFarOut}
                        onClick={() => {
                          void enter(s);
                        }}
                      >
                        {busyId === s.scheduleId ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Skip ${s.description}`}
                        title="Skip this occurrence"
                        disabled={busyId === s.scheduleId}
                        onClick={() => {
                          void skip(s);
                        }}
                      >
                        <SkipForward className="size-3.5" />
                      </Button>
                    </>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={s.status === 'paused' ? 'Resume schedule' : 'Pause schedule'}
                    title={s.status === 'paused' ? 'Resume' : 'Pause'}
                    disabled={busyId === s.scheduleId}
                    onClick={() => {
                      void setStatus(s, s.status === 'paused' ? 'active' : 'paused');
                    }}
                  >
                    {s.status === 'paused' ? (
                      <Play className="size-3.5" />
                    ) : (
                      <Pause className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`End ${s.description}`}
                    title="End this schedule"
                    disabled={busyId === s.scheduleId}
                    onClick={() => {
                      void setStatus(s, 'ended');
                    }}
                  >
                    <XCircle className="size-3.5" />
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <AddScheduleDialog
        open={adding}
        householdId={householdId}
        accounts={accounts}
        categories={categories}
        onClose={() => {
          setAdding(false);
        }}
        onSaved={() => {
          setAdding(false);
          onChanged();
        }}
      />
    </section>
  );
}

function AddScheduleDialog({
  open,
  householdId,
  accounts,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string;
  accounts: AccountRow[];
  categories: CategoryRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [direction, setDirection] = useState<'bill' | 'income'>('bill');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<ScheduleRow['frequency']>('monthly');
  const [nextDue, setNextDue] = useState(() => todayIso());
  const [dueEarly, setDueEarly] = useState<'0' | '3' | '7'>('3');
  // Two days-of-month for the 'semimonthly' frequency (defaults 15th & 30th).
  const [semiDay1, setSemiDay1] = useState('15');
  const [semiDay2, setSemiDay2] = useState('30');
  const [busy, setBusy] = useState(false);

  const kind = direction === 'bill' ? 'expense' : 'income';
  // Entity-scope to the chosen account's entity (D-060): a schedule posts into
  // that account's entity, so its category must belong to the same entity.
  // Scoping collapses the identical-name Personal/Business duplication; the
  // label disambiguates if an account isn't chosen yet (multi-entity).
  const accountEntityId = accounts.find((a) => a.id === accountId)?.entityId ?? null;
  const categoryOptions = scopeToEntity(categories, accountEntityId).filter(
    (c) => c.kind === kind,
  );
  const showEntity = hasMultipleEntities(categoryOptions);
  const catLabel = (c: CategoryRow) => entityLabel(c.name, c.entityName, showEntity);

  async function save() {
    if (!accountId || !categoryId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    let anchorDay: number | null = null;
    let anchorDay2: number | null = null;
    if (frequency === 'semimonthly') {
      const d1 = Number(semiDay1);
      const d2 = Number(semiDay2);
      if (
        !Number.isInteger(d1) ||
        !Number.isInteger(d2) ||
        d1 < 1 ||
        d1 > 31 ||
        d2 < 1 ||
        d2 > 31 ||
        d1 === d2
      ) {
        toast.error('Pick two different days of the month between 1 and 31.');
        return;
      }
      anchorDay = Math.min(d1, d2);
      anchorDay2 = Math.max(d1, d2);
    }
    setBusy(true);
    try {
      await saveSchedule({
        householdId,
        accountId,
        description: description.trim(),
        amountMinor: direction === 'bill' ? `-${minor}` : minor,
        categoryLedgerAccountId: categoryId,
        frequency,
        nextDueDate: nextDue,
        autoEnterDays: Number(dueEarly),
        anchorDay,
        anchorDay2,
      });
      toast.success('Scheduled. It shows as due ahead of time and projects into your cash curve.');
      setDescription('');
      setAmount('');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the schedule.');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a bill or income</DialogTitle>
          <DialogDescription>
            KEEL reminds you when it&apos;s due; entering it posts a real transaction.
            No money moves on its own.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            {(['bill', 'income'] as const).map((d) => (
              <Button
                key={d}
                type="button"
                variant={direction === d ? 'secondary' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => {
                  setDirection(d);
                  setCategoryId(null);
                }}
              >
                {d === 'bill' ? 'Bill' : 'Income'}
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
              <Label htmlFor="sched-amount">Amount</Label>
              <Input
                id="sched-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sched-desc">Description</Label>
            <Input
              id="sched-desc"
              value={description}
              maxLength={140}
              placeholder="e.g. Rent"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select
              value={categoryId ?? undefined}
              items={Object.fromEntries(
                categoryOptions.map((c) => [c.ledgerAccountId, catLabel(c)]),
              )}
              onValueChange={(v) => {
                setCategoryId(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((c) => (
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
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Repeats</Label>
              <Select
                value={frequency}
                items={FREQUENCY_LABELS}
                onValueChange={(v) => {
                  if (v) setFrequency(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(FREQUENCY_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-due">Next due</Label>
              <Input
                id="sched-due"
                type="date"
                value={nextDue}
                onChange={(e) => {
                  setNextDue(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Show as due</Label>
              <Select
                value={dueEarly}
                items={{ '0': 'On the day', '3': '3 days early', '7': '7 days early' }}
                onValueChange={(v) => {
                  if (v) setDueEarly(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">On the day</SelectItem>
                  <SelectItem value="3">3 days early</SelectItem>
                  <SelectItem value="7">7 days early</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {frequency === 'semimonthly' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sched-semi-day1">First day of month</Label>
                <Input
                  id="sched-semi-day1"
                  type="number"
                  min={1}
                  max={31}
                  value={semiDay1}
                  onChange={(e) => {
                    setSemiDay1(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sched-semi-day2">Second day of month</Label>
                <Input
                  id="sched-semi-day2"
                  type="number"
                  min={1}
                  max={31}
                  value={semiDay2}
                  onChange={(e) => {
                    setSemiDay2(e.target.value);
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Enters twice a month on these days. A day past a short month
                (e.g. the 30th) lands on that month&apos;s last day (Feb 28/29).
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !accountId ||
              !categoryId ||
              !amount.trim() ||
              !nextDue ||
              description.trim().length === 0
            }
            onClick={() => {
              void save();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
