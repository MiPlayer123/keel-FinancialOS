'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileCheck2,
  Plus,
  Trash2,
  Loader2,
  ChevronRight,
  LockOpen,
  CalendarClock,
  Upload,
  FileText,
  Sparkles,
  Cpu,
  ShieldCheck,
  AlertTriangle,
  X,
  TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchEntities,
  fetchStatementCadence,
  fetchStatementDrafts,
  fetchStatementDraftDetail,
  setStatementCadence,
  uploadStatement,
  issueStatementDraftApproval,
  approveStatementDraft,
  dismissStatementDraft,
  type StatementDraftDetail,
  keelCommand,
  keelQuery,
  newId,
  fetchStatementPaymentLinks,
  findStatementPayment,
  decideStatementPaymentLink,
  detachStatementPaymentLink,
  fetchStatementHoldingsDiff,
  applyStatementHoldings,
  unapplyStatementHoldings,
  STATEMENT_UPLOAD_ACCEPT,
  type AccountRow,
  type RichTransactionRow,
  type StatementCadenceRow,
  type StatementDraftRow,
  type StatementRow,
  type StatementPaymentLink,
  type StatementHoldingsDiff,
} from '@/lib/keel-api';
import { looksLikeInvestmentAccount } from '@/lib/investment-subtype';
import {
  buildStatementBody,
  runIssueThenApprove,
  type ApproveFormInput,
} from '@/lib/statement-approve';
import { sha256Hex, parseSignedDollars, minorToDollars } from '@/lib/hash';
import { shortDateWithYear } from '@/lib/relative-date';
import { AttachmentsSection } from '@/components/keel/attachments-section';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function StatementsPage() {
  return (
    <>
      <PageHeader
        title="Statements"
      />
      <div className="p-6">
        <StatementsBody />
      </div>
    </>
  );
}

function StatementsBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<StatementRow>(
    'statements.list',
    householdId,
  );
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [cadence, setCadence] = useState<StatementCadenceRow[]>([]);
  const [drafts, setDrafts] = useState<StatementDraftRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<StatementDraftRow | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const reloadCadence = () => {
    if (!householdId) return;
    void fetchStatementCadence(householdId)
      .then(setCadence)
      .catch(() => {
        setCadence([]);
      });
  };

  const reloadDrafts = useCallback(() => {
    if (!householdId) {
      setDrafts(null);
      return;
    }
    void fetchStatementDrafts(householdId)
      .then(setDrafts)
      .catch(() => {
        setDrafts([]);
      });
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
    void fetchStatementCadence(householdId)
      .then(setCadence)
      .catch(() => {
        setCadence([]);
      });
    // Resolve a default entity for uploads (household's first/personal books).
    void fetchEntities(householdId)
      .then((entities) => {
        setEntityId((current) => current ?? entities[0]?.entityId ?? null);
      })
      .catch(() => {
        /* upload stays disabled without an entity */
      });
    reloadDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadCadence is stable per householdId
  }, [householdId]);

  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? 'Account';
  }, [accounts]);

  if (!ready || loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<FileCheck2 className="size-6" />}
        title="Couldn't load statements"
        description={error}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          A statement is the bank&apos;s own record for a period. Upload the PDF/CSV/OFX
          and KEEL reads it, or enter one by hand — then reconcile it line-by-line
          against your ledger.
        </p>
        <div className="flex items-center gap-2">
          <StatementUploadButton
            disabled={uploading || !householdId || !entityId || accounts.length === 0}
            onClick={() => {
              setUploading(true);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
            New statement
          </Button>
        </div>
      </div>

      <StatementDraftsSection
        drafts={drafts}
        householdId={householdId}
        userId={userId}
        onReview={(d) => {
          setReviewDraft(d);
        }}
        onChanged={reloadDrafts}
      />

      <StatementCadenceSection
        cadence={cadence}
        accountName={accountName}
        householdId={householdId}
        userId={userId}
        onChanged={reloadCadence}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<FileCheck2 className="size-6" />}
          title="No statements yet"
          description="Enter your first bank statement, reconcile it against the ledger, then lock the period so nothing can quietly change behind a closed month. The Quicken habit, kept."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <StatementCard
              key={s.statementId}
              statement={s}
              accountName={accountName(s.accountId)}
              accountSubtype={accounts.find((a) => a.id === s.accountId)?.subtype ?? null}
              entityId={accounts.find((a) => a.id === s.accountId)?.entityId ?? null}
              open={openDetail === s.statementId}
              onToggle={() => {
                setOpenDetail(openDetail === s.statementId ? null : s.statementId);
              }}
              householdId={householdId}
              userId={userId}
              onChanged={() => {
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      <CreateStatementDialog
        open={creating}
        accounts={accounts}
        householdId={householdId}
        userId={userId}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={() => {
          setCreating(false);
          void refetch();
        }}
      />

      <UploadStatementDialog
        open={uploading}
        accounts={accounts}
        householdId={householdId}
        entityId={entityId}
        onClose={() => {
          setUploading(false);
        }}
        onUploaded={() => {
          setUploading(false);
          reloadDrafts();
        }}
      />

      {reviewDraft ? (
        <ReviewDraftDialog
          draft={reviewDraft}
          account={accounts.find((a) => a.id === reviewDraft.accountId) ?? null}
          householdId={householdId}
          userId={userId}
          onClose={() => {
            setReviewDraft(null);
          }}
          onApproved={() => {
            setReviewDraft(null);
            reloadDrafts();
            void refetch();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload button — hover affordance mirrors the receipts hub.
// ---------------------------------------------------------------------------
function StatementUploadButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" disabled={disabled} onClick={onClick}>
      <Upload className="size-4" />
      Upload statement
    </Button>
  );
}

const CLOSE_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => String(i + 1));

// F-029: per-account statement cadence (expected close day) + a "statement due"
// reminder. Derived from prior statements' close days or set manually. No CSV
// line import here (deferred) — this is the cadence/reminder slice only.
function StatementCadenceSection({
  cadence,
  accountName,
  householdId,
  userId,
  onChanged,
}: {
  cadence: StatementCadenceRow[];
  accountName: (id: string) => string;
  householdId: string | null;
  userId: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (cadence.length === 0) return null;

  const overdue = cadence.filter((c) => c.overdue);

  async function save(accountId: string, closeDay: number | null) {
    if (!householdId || !userId) return;
    setBusy(accountId);
    try {
      await setStatementCadence({ householdId, userId, accountId, closeDay });
      toast.success(closeDay === null ? 'Cadence cleared.' : 'Statement cadence saved.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update cadence.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-2">
      {overdue.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-keel-negative/40 bg-keel-negative/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-keel-negative">
            <CalendarClock className="size-4" />
            Statement due
          </div>
          {overdue.map((c) => (
            <p key={c.accountId} className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{accountName(c.accountId)}</span>{' '}
              — a statement was expected around{' '}
              <span className="font-mono">{c.nextExpectedClose}</span>
              {c.lastPeriodEnd ? (
                <>
                  {' '}(last one covered through{' '}
                  <span className="font-mono">{c.lastPeriodEnd}</span>)
                </>
              ) : null}
              . Enter it to reconcile the period.
            </p>
          ))}
        </div>
      ) : null}

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
          Statement cadence
        </summary>
        <div className="space-y-2 border-t border-border p-3">
          {cadence.map((c) => (
            <div
              key={c.accountId}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium">{accountName(c.accountId)}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {c.closeDay
                    ? `closes ~day ${String(c.closeDay)} (${c.closeDaySource})`
                    : 'no cadence yet'}
                  {c.nextExpectedClose ? ` · next ${c.nextExpectedClose}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={c.closeDay ? String(c.closeDay) : ''}
                  items={Object.fromEntries(CLOSE_DAY_OPTIONS.map((d) => [d, `Day ${d}`]))}
                  onValueChange={(v) => {
                    if (v) void save(c.accountId, Number(v));
                  }}
                >
                  <SelectTrigger className="h-7 w-28 text-xs" disabled={busy === c.accountId}>
                    <SelectValue placeholder="Set close day" />
                  </SelectTrigger>
                  <SelectContent>
                    {CLOSE_DAY_OPTIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        Day {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {c.closeDaySource === 'manual' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={busy === c.accountId}
                    onClick={() => void save(c.accountId, null)}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

// SLICE 8 [A7]: card-payment ↔ statement linking on a credit-card statement.
// The matcher (Law 1 deterministic, exact-only) suggests the card-side payment
// that settled the balance; the user confirms/rejects (Law 10 class B — nothing
// auto-confirms). Confirmed links can be detached (Law 2 reversible). When
// nothing is suggested yet, "Find payment" runs the matcher once.
function CardPaymentSection({
  statementId,
  endingMinor,
  currency,
  householdId,
  userId,
}: {
  statementId: string;
  endingMinor: string;
  currency: string;
  householdId: string | null;
  userId: string | null;
}) {
  const [links, setLinks] = useState<StatementPaymentLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) return;
    try {
      setLinks(await fetchStatementPaymentLinks(householdId, statementId));
    } catch {
      setLinks([]);
    }
  }, [householdId, statementId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function find() {
    if (!householdId) return;
    setBusy('find');
    try {
      const written = await findStatementPayment(householdId, statementId);
      if (written > 0) {
        toast.success('Found a matching card payment.');
      } else {
        toast.info('No single exact card payment found for this balance yet.');
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not search for a payment.');
    } finally {
      setBusy(null);
    }
  }

  async function decide(linkId: string, confirm: boolean) {
    if (!householdId || !userId) return;
    setBusy(linkId);
    try {
      await decideStatementPaymentLink({ householdId, userId, linkId, confirm });
      toast.success(confirm ? 'Card payment confirmed.' : 'Suggestion dismissed.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the link.');
    } finally {
      setBusy(null);
    }
  }

  async function detach(linkId: string) {
    if (!householdId || !userId) return;
    setBusy(linkId);
    try {
      await detachStatementPaymentLink({ householdId, userId, linkId });
      toast.success('Card payment detached.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not detach the link.');
    } finally {
      setBusy(null);
    }
  }

  const active = (links ?? []).filter(
    (l) => l.status === 'suggested' || l.status === 'confirmed',
  );

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Card payment</p>
          <p className="text-xs text-muted-foreground">
            The payment that settled this balance (
            <Money amountMinor={endingMinor} currency={currency} className="text-xs" />
            ).
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null || !householdId}
          onClick={() => {
            void find();
          }}
        >
          {busy === 'find' ? 'Searching…' : 'Find payment'}
        </Button>
      </div>

      {links === null ? (
        <Skeleton className="h-10 w-full" />
      ) : active.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No linked payment yet. Use “Find payment” to match the credit that paid this balance.
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((l) => (
            <div
              key={l.linkId}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {l.txnDate}
              </span>
              <span className="min-w-0 flex-1 truncate" title={l.txnDescription}>
                {l.txnDescription}
              </span>
              <Money amountMinor={l.txnAmountMinor} currency={l.currency} className="text-sm" />
              <Badge variant={l.status === 'confirmed' ? 'default' : 'secondary'} className="capitalize">
                {l.status}
              </Badge>
              {l.status === 'suggested' ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      void decide(l.linkId, true);
                    }}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      void decide(l.linkId, false);
                    }}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    void detach(l.linkId);
                  }}
                >
                  Detach
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// SLICE 9 [A8]: investment-statement holdings. Shows the per-symbol/CUSIP diff
// between the extracted positions and the account's CURRENT holdings (suggestion
// only, Law 10), and lets the user APPLY the positions (token-bound, class-B) or
// REVERT (Law 2). Apply rebuilds current from the newest applied statement; an
// older statement never regresses current, and a symbol absent from a newer full
// statement drops.
function InvestmentHoldingsSection({
  statementId,
  currency,
  householdId,
  userId,
}: {
  statementId: string;
  currency: string;
  householdId: string | null;
  userId: string | null;
}) {
  const [diff, setDiff] = useState<StatementHoldingsDiff | null>(null);
  const [busy, setBusy] = useState<null | 'apply' | 'revert'>(null);

  const load = useCallback(async () => {
    if (!householdId) return;
    try {
      setDiff(await fetchStatementHoldingsDiff(householdId, statementId));
    } catch {
      setDiff(null);
    }
  }, [householdId, statementId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    if (!householdId || !userId) return;
    setBusy('apply');
    try {
      await applyStatementHoldings({ householdId, userId, statementId });
      toast.success('Positions applied to this account’s holdings.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not apply positions.');
    } finally {
      setBusy(null);
    }
  }

  async function revert() {
    if (!householdId || !userId) return;
    setBusy('revert');
    try {
      await unapplyStatementHoldings({ householdId, userId, statementId });
      toast.success('Reverted — holdings rebuilt from the prior statement.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revert.');
    } finally {
      setBusy(null);
    }
  }

  if (!diff || !diff.hasExtraction) return null;
  const rows = diff.rows;
  const changed = rows.filter((r) => r.state !== 'same');

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <TrendingUp className="size-4" /> Portfolio positions
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" disabled={busy !== null || !userId} onClick={() => void apply()}>
            {busy === 'apply' ? 'Applying…' : 'Apply positions'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null || !userId}
            onClick={() => void revert()}
          >
            {busy === 'revert' ? 'Reverting…' : 'Revert'}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {changed.length === 0
          ? 'These positions already match the account’s current holdings.'
          : 'Suggested changes vs current holdings — nothing is applied until you choose Apply.'}
      </p>
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center gap-3 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="w-24 shrink-0">Symbol</span>
          <span className="min-w-0 flex-1">Name</span>
          <span className="w-24 shrink-0 text-right">Qty Δ</span>
          <span className="w-28 shrink-0 text-right">Value Δ</span>
          <span className="w-20 shrink-0 text-right">State</span>
        </div>
        {rows.map((r) => {
          const key = r.symbol ?? r.cusip ?? r.isin ?? 'row';
          const ident = r.symbol ?? r.cusip ?? r.isin ?? '—';
          return (
            <div
              key={key}
              className="flex items-center gap-3 border-t border-border px-3 py-2 text-sm"
            >
              <span className="w-24 shrink-0 truncate font-mono text-xs" title={r.cusip ?? r.isin ?? ''}>
                {ident}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.name ?? ''}>
                {r.name ?? ''}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
                {r.qtyDelta ?? '—'}
              </span>
              <span className="w-28 shrink-0 text-right">
                {r.valueDeltaMinor ? (
                  <Money amountMinor={r.valueDeltaMinor} currency={currency} signed className="text-sm" />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              <span className="w-20 shrink-0 text-right">
                <Badge
                  variant={
                    r.state === 'removed' ? 'destructive' : r.state === 'same' ? 'secondary' : 'default'
                  }
                  className="capitalize"
                >
                  {r.state}
                </Badge>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatementCard({
  statement: s,
  accountName,
  accountSubtype,
  entityId,
  open,
  onToggle,
  householdId,
  userId,
  onChanged,
}: {
  statement: StatementRow;
  accountName: string;
  accountSubtype: string | null;
  entityId: string | null;
  open: boolean;
  onToggle: () => void;
  householdId: string | null;
  userId: string | null;
  onChanged: () => void;
}) {
  const [reopening, setReopening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function reopen() {
    if (!householdId || !userId || !s.session || reason.trim().length === 0) return;
    setBusy(true);
    try {
      await keelCommand({
        commandId: newId(),
        command: 'reconciliations.reopen',
        economicEventKey: `reconciliations.reopen:${s.session.sessionId}:${newId()}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: { sessionId: s.session.sessionId, reason: reason.trim() },
      });
      toast.success('Reconciliation reopened; the period is unlocked.');
      setReopening(false);
      setReason('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reopen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40"
        onClick={onToggle}
      >
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{accountName}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {s.periodStart} → {s.periodEnd} · {s.lines.length} line{s.lines.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Money amountMinor={s.endingMinor} currency={s.currency} className="text-sm" />
          <Badge variant="secondary" className="capitalize">
            {s.status}
          </Badge>
        </div>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Opening</p>
              <Money amountMinor={s.openingMinor} currency={s.currency} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Ending</p>
              <Money amountMinor={s.endingMinor} currency={s.currency} />
            </div>
            {s.session ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">Ledger at close</p>
                  <Money amountMinor={s.session.ledgerEndingMinor} currency={s.currency} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Difference</p>
                  <Money amountMinor={s.session.differenceMinor} currency={s.currency} />
                </div>
              </>
            ) : null}
          </div>

          <AttachmentsSection
            householdId={householdId}
            userId={userId}
            entityId={entityId}
            targetType="statement"
            targetId={s.statementId}
            kind="statement"
          />

          {accountSubtype === 'credit_card' ? (
            <CardPaymentSection
              statementId={s.statementId}
              endingMinor={s.endingMinor}
              currency={s.currency}
              householdId={householdId}
              userId={userId}
            />
          ) : null}

          {accountSubtype && looksLikeInvestmentAccount(accountSubtype) ? (
            <InvestmentHoldingsSection
              statementId={s.statementId}
              currency={s.currency}
              householdId={householdId}
              userId={userId}
            />
          ) : null}

          <div className="overflow-hidden rounded-md border border-border">
            {s.lines.map((l, i) => (
              <div
                key={l.lineId}
                className={`flex items-center gap-3 px-3 py-2 text-sm ${
                  i > 0 ? 'border-t border-border' : ''
                }`}
              >
                <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                  {l.date}
                </span>
                <span className="min-w-0 flex-1 truncate" title={l.description}>
                  {l.description}
                </span>
                <Money amountMinor={l.amountMinor} currency={s.currency} signed className="text-sm" />
              </div>
            ))}
          </div>

          {s.status === 'closed' && s.session ? (
            reopening ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`reopen-${s.statementId}`}>Reason for reopening</Label>
                  <Input
                    id={`reopen-${s.statementId}`}
                    value={reason}
                    maxLength={500}
                    placeholder="e.g. missed a pending charge"
                    onChange={(e) => {
                      setReason(e.target.value);
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setReopening(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || reason.trim().length === 0}
                    onClick={() => {
                      void reopen();
                    }}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <LockOpen className="size-4" />}
                    Reopen
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReopening(true);
                }}
              >
                <LockOpen className="size-4" />
                Reopen reconciliation
              </Button>
            )
          ) : null}
          {s.status === 'open' || s.status === 'reopened' ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  setClosing(true);
                }}
              >
                <FileCheck2 className="size-4" />
                Reconcile &amp; close
              </Button>
              <CloseStatementDialog
                open={closing}
                statement={s}
                householdId={householdId}
                userId={userId}
                onClose={() => {
                  setClosing(false);
                }}
                onClosed={() => {
                  setClosing(false);
                  onChanged();
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type DraftLine = { date: string; amount: string; description: string };

function CreateStatementDialog({
  open,
  accounts,
  householdId,
  userId,
  onClose,
  onCreated,
}: {
  open: boolean;
  accounts: AccountRow[];
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [opening, setOpening] = useState('');
  const [ending, setEnding] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ date: '', amount: '', description: '' }]);
  const [busy, setBusy] = useState(false);

  // The server requires opening + Σ lines = ending EXACTLY; show the check live.
  const check = useMemo(() => {
    const openingMinor = parseSignedDollars(opening);
    const endingMinor = parseSignedDollars(ending);
    if (openingMinor === null || endingMinor === null) return null;
    let sum = 0n;
    for (const l of lines) {
      const v = parseSignedDollars(l.amount);
      if (v === null) return null;
      sum += BigInt(v);
    }
    const drift = BigInt(openingMinor) + sum - BigInt(endingMinor);
    return { openingMinor, endingMinor, drift: drift.toString() };
  }, [opening, ending, lines]);

  function setLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function create() {
    if (!householdId || !userId || !accountId || !check || check.drift !== '0') return;
    if (!periodStart || !periodEnd) return;
    setBusy(true);
    try {
      const payloadLines = lines.map((l, i) => ({
        lineKey: `line-${String(i + 1)}`,
        date: l.date,
        amountMinor: parseSignedDollars(l.amount) ?? '0',
        description: l.description.trim() || `Line ${String(i + 1)}`,
      }));
      // Hash the FULL statement body: a corrected re-entry (same lines,
      // fixed balances) must produce a new identity, not an idempotency 409.
      const sourceHash = await sha256Hex(
        JSON.stringify({
          accountId,
          periodStart,
          periodEnd,
          openingMinor: check.openingMinor,
          endingMinor: check.endingMinor,
          lines: payloadLines,
        }),
      );
      await keelCommand({
        commandId: newId(),
        command: 'statements.create',
        economicEventKey: `statements.create:${sourceHash}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          accountId,
          periodStart,
          periodEnd,
          openingMinor: check.openingMinor,
          endingMinor: check.endingMinor,
          currency: 'USD',
          sourceHash,
          lines: payloadLines,
        },
      });
      toast.success('Statement saved.');
      setAccountId(null);
      setPeriodStart('');
      setPeriodEnd('');
      setOpening('');
      setEnding('');
      setLines([{ date: '', amount: '', description: '' }]);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the statement.');
    } finally {
      setBusy(false);
    }
  }

  const balanced = check !== null && check.drift === '0';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New statement</DialogTitle>
          <DialogDescription>
            Copy the period, balances and lines from your bank statement. Opening plus
            all lines must equal the ending balance exactly.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-1">
              <Label>Account</Label>
              <Select
                value={accountId ?? undefined}
                items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
                onValueChange={(v) => {
                  setAccountId(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick account" />
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
              <Label htmlFor="stmt-start">Period start</Label>
              <Input
                id="stmt-start"
                type="date"
                value={periodStart}
                onChange={(e) => {
                  setPeriodStart(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stmt-end">Period end</Label>
              <Input
                id="stmt-end"
                type="date"
                value={periodEnd}
                onChange={(e) => {
                  setPeriodEnd(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="stmt-opening">Opening balance</Label>
              <Input
                id="stmt-opening"
                inputMode="decimal"
                placeholder="0.00"
                value={opening}
                onChange={(e) => {
                  setOpening(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stmt-ending">Ending balance</Label>
              <Input
                id="stmt-ending"
                inputMode="decimal"
                placeholder="0.00"
                value={ending}
                onChange={(e) => {
                  setEnding(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Statement lines</Label>
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="date"
                  className="w-36 shrink-0"
                  value={l.date}
                  onChange={(e) => {
                    setLine(i, { date: e.target.value });
                  }}
                />
                <Input
                  placeholder="Description"
                  value={l.description}
                  maxLength={500}
                  onChange={(e) => {
                    setLine(i, { description: e.target.value });
                  }}
                />
                <Input
                  className="w-28 shrink-0"
                  inputMode="decimal"
                  placeholder="-12.34"
                  value={l.amount}
                  onChange={(e) => {
                    setLine(i, { amount: e.target.value });
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove line"
                  disabled={lines.length === 1}
                  onClick={() => {
                    setLines((prev) => prev.filter((_, idx) => idx !== i));
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLines((prev) => [...prev, { date: '', amount: '', description: '' }]);
              }}
            >
              <Plus className="size-4" />
              Add line
            </Button>
          </div>

          <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
            {check === null ? (
              <span className="text-muted-foreground">
                Enter valid amounts to check the statement math.
              </span>
            ) : balanced ? (
              <span>Balanced: opening + lines = ending. Ready to save.</span>
            ) : (
              <span>
                Off by <Money amountMinor={check.drift} signed className="text-keel-negative" /> —
                opening + lines must equal ending.
              </span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy || !balanced || !accountId || !periodStart || !periodEnd ||
              lines.some((l) => !l.date)
            }
            onClick={() => {
              void create();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save statement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reconcile & close: explain every statement line (match it to a ledger
// transaction or classify why it can't be), explain the exact difference
// between the statement's ending balance and the ledger, then close — which
// locks the period. All arithmetic is BigInt on minor-unit strings.
// ---------------------------------------------------------------------------

const RESOLUTIONS = {
  matched_transaction: 'Matches a transaction',
  pending_posting: 'Pending — posts next period',
  missing_event: 'Missing from ledger',
  duplicate: 'Bank duplicate',
  stale_balance: 'Stale balance',
  opening_balance: 'Opening balance entry',
  adjustment: 'Adjustment',
} as const;
type Resolution = keyof typeof RESOLUTIONS;

type LineDraft = {
  resolution: Resolution | null;
  transactionId: string | null;
  explanation: string;
};
type AdjustmentDraft = { kind: Exclude<Resolution, 'matched_transaction'>; amount: string; explanation: string };

function CloseStatementDialog({
  open,
  statement: s,
  householdId,
  userId,
  onClose,
  onClosed,
}: {
  open: boolean;
  statement: StatementRow;
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [txns, setTxns] = useState<RichTransactionRow[] | null>(null);
  // null = fetch failed (server still verifies exactly); '0' = genuinely no
  // postings ≤ period end, which is a real, closable state.
  const [ledgerAtEnd, setLedgerAtEnd] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [adjustments, setAdjustments] = useState<AdjustmentDraft[]>([]);
  const [busy, setBusy] = useState(false);

  // Candidates: same account, inside the period, posted/reviewed, not voided.
  const candidates = useMemo(
    () =>
      (txns ?? []).filter(
        (t) =>
          t.accountId === s.accountId &&
          t.effectiveDate >= s.periodStart &&
          t.effectiveDate <= s.periodEnd &&
          (t.status === 'posted' || t.status === 'reviewed'),
      ),
    [txns, s],
  );

  useEffect(() => {
    if (!open || !householdId || txns !== null) return;
    let active = true;
    void Promise.all([
      keelQuery<RichTransactionRow>('transactions.rich', householdId),
      keelQuery<{ date: string; currency: string; balanceMinor: string }>(
        'accounts.balance_daily',
        householdId,
        { accountId: s.accountId, from: s.periodEnd, to: s.periodEnd },
      ),
    ])
      .then(([rich, daily]) => {
        if (!active) return;
        setTxns(rich.rows);
        // Match the server's semantics exactly: Σ postings ≤ period end in
        // the STATEMENT'S currency; no rows means the sum is genuinely 0.
        setLedgerAtEnd(
          daily.rows.find((r) => r.currency === s.currency)?.balanceMinor ?? '0',
        );
      })
      .catch(() => {
        if (!active) return;
        setTxns([]);
        setLedgerAtEnd(null);
      });
    return () => {
      active = false;
    };
  }, [open, householdId, txns, s]);

  // Auto-match once candidates land: exact amount, nearest date, one txn per line.
  useEffect(() => {
    if (txns === null || Object.keys(drafts).length > 0) return;
    const used = new Set<string>();
    const next: Record<string, LineDraft> = {};
    for (const line of s.lines) {
      const match = candidates
        .filter((t) => t.amountMinor === line.amountMinor && !used.has(t.transactionId))
        .sort(
          (a, b) =>
            Math.abs(Date.parse(a.effectiveDate) - Date.parse(line.date)) -
            Math.abs(Date.parse(b.effectiveDate) - Date.parse(line.date)),
        )[0];
      if (match) {
        used.add(match.transactionId);
        next[line.lineId] = {
          resolution: 'matched_transaction',
          transactionId: match.transactionId,
          explanation: `Matches ${match.description.slice(0, 60)}`,
        };
      } else {
        next[line.lineId] = { resolution: null, transactionId: null, explanation: '' };
      }
    }
    setDrafts(next);
  }, [txns, candidates, s.lines, drafts]);

  // The server requires Σ adjustments = statement ending − ledger(period end),
  // to the cent. Show the target live and prefill one row when it's nonzero.
  const differenceMinor = useMemo(() => {
    if (ledgerAtEnd === null) return null;
    return (BigInt(s.endingMinor) - BigInt(ledgerAtEnd)).toString();
  }, [ledgerAtEnd, s.endingMinor]);

  useEffect(() => {
    if (differenceMinor === null || differenceMinor === '0' || adjustments.length > 0) return;
    setAdjustments([
      { kind: 'adjustment', amount: minorToDollars(differenceMinor), explanation: '' },
    ]);
  }, [differenceMinor, adjustments.length]);

  const adjustmentSumMinor = useMemo(() => {
    let sum = 0n;
    for (const a of adjustments) {
      // Blank rows are ignorable scaffolding (they're filtered from the
      // payload) — only a NON-blank unparseable amount blocks the math.
      if (a.amount.trim() === '') continue;
      const v = parseSignedDollars(a.amount);
      if (v === null) return null;
      sum += BigInt(v);
    }
    return sum.toString();
  }, [adjustments]);

  const allResolved = s.lines.every((l) => {
    const d = drafts[l.lineId];
    return (
      d &&
      d.resolution !== null &&
      d.explanation.trim().length > 0 &&
      (d.resolution !== 'matched_transaction' || d.transactionId !== null)
    );
  });
  // When the balance fetch failed the client can't pre-check the exactness
  // rule — don't dead-end the button; the server verifies and its typed
  // error surfaces in the toast.
  const differenceExplained =
    differenceMinor === null ||
    (adjustmentSumMinor !== null &&
      adjustmentSumMinor === differenceMinor &&
      adjustments.every((a) => a.explanation.trim().length > 0 || a.amount.trim() === ''));

  async function close() {
    if (!householdId || !userId || !allResolved) return;
    setBusy(true);
    try {
      const items = s.lines.map((l) => {
        const d = drafts[l.lineId];
        return {
          lineId: l.lineId,
          resolution: d?.resolution ?? 'adjustment',
          ...(d?.resolution === 'matched_transaction' && d.transactionId
            ? { transactionId: d.transactionId }
            : {}),
          explanation: (d?.explanation ?? '').trim(),
        };
      });
      const payloadAdjustments = adjustments
        .filter((a) => a.amount.trim() !== '')
        .map((a) => ({
          kind: a.kind,
          amountMinor: parseSignedDollars(a.amount) ?? '0',
          explanation: a.explanation.trim(),
        }));
      const payload = { statementId: s.statementId, items, adjustments: payloadAdjustments };
      const key = await sha256Hex(JSON.stringify(payload));
      await keelCommand({
        commandId: newId(),
        command: 'reconciliations.close',
        economicEventKey: `reconciliations.close:${key}`,
        actor: { kind: 'user', userId },
        householdId,
        payload,
      });
      toast.success('Reconciled and closed — the period is locked.');
      onClosed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not close the reconciliation.');
    } finally {
      setBusy(false);
    }
  }

  function setDraft(lineId: string, patch: Partial<LineDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [lineId]: { resolution: null, transactionId: null, explanation: '', ...prev[lineId], ...patch },
    }));
  }

  // A transaction may explain at most ONE line — hide picks made elsewhere.
  const chosenElsewhere = (lineId: string): Set<string> => {
    const out = new Set<string>();
    for (const [id, d] of Object.entries(drafts)) {
      if (id !== lineId && d.transactionId) out.add(d.transactionId);
    }
    return out;
  };
  const candidateItems = Object.fromEntries(
    candidates.map((t) => [
      t.transactionId,
      `${shortDateWithYear(t.effectiveDate)} · ${t.description.slice(0, 36)}`,
    ]),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reconcile &amp; close</DialogTitle>
          <DialogDescription>
            Explain every statement line, explain the difference to the ledger, and the
            period locks. Everything is undoable via reopen-with-reason.
          </DialogDescription>
        </DialogHeader>

        {txns === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {s.lines.map((l) => {
                const d = drafts[l.lineId] ?? {
                  resolution: null,
                  transactionId: null,
                  explanation: '',
                };
                return (
                  <div key={l.lineId} className="space-y-2 rounded-md border border-border p-3">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                        {l.date}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={l.description}>
                        {l.description}
                      </span>
                      <Money
                        amountMinor={l.amountMinor}
                        currency={s.currency}
                        signed
                        className="shrink-0 text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Select
                        value={d.resolution ?? undefined}
                        items={RESOLUTIONS}
                        onValueChange={(v) => {
                          setDraft(l.lineId, {
                            resolution: v,
                            ...(v !== 'matched_transaction' ? { transactionId: null } : {}),
                          });
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="How does this line resolve?" />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(RESOLUTIONS) as Resolution[]).map((r) => (
                            <SelectItem key={r} value={r}>
                              {RESOLUTIONS[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {d.resolution === 'matched_transaction' ? (
                        <Select
                          value={d.transactionId ?? undefined}
                          items={candidateItems}
                          onValueChange={(v) => {
                            setDraft(l.lineId, { transactionId: v });
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Pick the transaction" />
                          </SelectTrigger>
                          <SelectContent>
                            {candidates
                              .filter(
                                (t) =>
                                  !chosenElsewhere(l.lineId).has(t.transactionId) ||
                                  t.transactionId === d.transactionId,
                              )
                              .map((t) => (
                                <SelectItem key={t.transactionId} value={t.transactionId}>
                                  {shortDateWithYear(t.effectiveDate)} · {t.description.slice(0, 36)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      <Input
                        className={d.resolution === 'matched_transaction' ? '' : 'sm:col-span-2'}
                        placeholder="Why (required)"
                        maxLength={500}
                        value={d.explanation}
                        onChange={(e) => {
                          setDraft(l.lineId, { explanation: e.target.value });
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 rounded-md border border-border bg-secondary/30 p-3 text-sm">
              {differenceMinor === null ? (
                <p className="text-muted-foreground">
                  Couldn&apos;t compute the ledger balance for {s.periodEnd} — the server
                  will still verify the difference exactly.
                </p>
              ) : differenceMinor === '0' ? (
                <p>Statement and ledger agree exactly — nothing to adjust.</p>
              ) : (
                <p>
                  Statement ending differs from the ledger by{' '}
                  <Money amountMinor={differenceMinor} signed className="font-medium" /> —
                  adjustments must add up to exactly that.
                </p>
              )}
              {adjustments.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select
                    value={a.kind}
                    items={Object.fromEntries(
                      (Object.keys(RESOLUTIONS) as Resolution[])
                        .filter((r) => r !== 'matched_transaction')
                        .map((r) => [r, RESOLUTIONS[r]]),
                    )}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setAdjustments((prev) =>
                        prev.map((row, idx) => (idx === i ? { ...row, kind: v } : row)),
                      );
                    }}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(RESOLUTIONS) as Resolution[])
                        .filter((r) => r !== 'matched_transaction')
                        .map((r) => (
                          <SelectItem key={r} value={r}>
                            {RESOLUTIONS[r]}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-28"
                    inputMode="decimal"
                    placeholder="-12.34"
                    value={a.amount}
                    onChange={(e) => {
                      setAdjustments((prev) =>
                        prev.map((row, idx) => (idx === i ? { ...row, amount: e.target.value } : row)),
                      );
                    }}
                  />
                  <Input
                    className="min-w-40 flex-1"
                    placeholder="Why (required)"
                    maxLength={500}
                    value={a.explanation}
                    onChange={(e) => {
                      setAdjustments((prev) =>
                        prev.map((row, idx) =>
                          idx === i ? { ...row, explanation: e.target.value } : row,
                        ),
                      );
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove adjustment"
                    onClick={() => {
                      setAdjustments((prev) => prev.filter((_, idx) => idx !== i));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAdjustments((prev) => [
                    ...prev,
                    { kind: 'adjustment', amount: '', explanation: '' },
                  ]);
                }}
              >
                <Plus className="size-4" />
                Add adjustment
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || txns === null || !allResolved || !differenceExplained}
            onClick={() => {
              void close();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FileCheck2 className="size-4" />}
            Close &amp; lock period
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SLICE 7: Upload statement (ingest mode) — REQUIRED account picker (entity-
// aware), .pdf/.csv/.ofx/.qfx, mode:'ingest'. A duplicate re-upload surfaces as
// "already uploaded" with a link to the existing draft, never an error [A4].
// ---------------------------------------------------------------------------
const STATEMENT_MAX_BYTES = 10 * 1024 * 1024;

function UploadStatementDialog({
  open,
  accounts,
  householdId,
  entityId,
  onClose,
  onUploaded,
}: {
  open: boolean;
  accounts: AccountRow[];
  householdId: string | null;
  entityId: string | null;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [dupe, setDupe] = useState<{ draftId: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Account picker is entity-aware: group by entity when the household has more
  // than one set of books, so a personal card and an LLC account never blur.
  const byEntity = useMemo(() => {
    const groups = new Map<string, AccountRow[]>();
    for (const a of accounts) {
      const list = groups.get(a.entityId) ?? [];
      list.push(a);
      groups.set(a.entityId, list);
    }
    return groups;
  }, [accounts]);

  function reset() {
    setAccountId(null);
    setFile(null);
    setDupe(null);
  }

  async function submit() {
    if (!householdId || !entityId || !accountId || !file) return;
    if (file.size <= 0 || file.size > STATEMENT_MAX_BYTES) {
      toast.error('File is empty or over the 10MB limit.');
      return;
    }
    setBusy(true);
    setDupe(null);
    try {
      const result = await uploadStatement({ householdId, entityId, accountId, file });
      if (result.duplicate) {
        // Not an error — the same bytes for this account already exist.
        setDupe({ draftId: result.draftId });
        toast.info('This statement was already uploaded.');
        return;
      }
      toast.success('Statement uploaded — reading it now.');
      reset();
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload the statement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload statement</DialogTitle>
          <DialogDescription>
            Pick the account this statement belongs to, then choose the file. KEEL
            reads it and prepares a draft for you to review before anything is written.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Account</Label>
            <Select
              value={accountId ?? undefined}
              items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
              onValueChange={(v) => {
                setAccountId(v);
              }}
            >
              <SelectTrigger className="w-full" disabled={busy}>
                <SelectValue placeholder="Pick the account" />
              </SelectTrigger>
              <SelectContent>
                {Array.from(byEntity.values()).flatMap((list) =>
                  list.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  )),
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Statement file</Label>
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              accept={STATEMENT_UPLOAD_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setDupe(null);
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  inputRef.current?.click();
                }}
              >
                <FileText className="size-4" />
                Choose file
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={file?.name}>
                {file ? file.name : 'PDF, CSV, OFX or QFX'}
              </span>
            </div>
          </div>

          {dupe ? (
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
              This file is already uploaded for this account. Its draft is in the
              list below{dupe.draftId ? ' — review it there.' : '.'}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {dupe ? 'Done' : 'Cancel'}
          </Button>
          <Button
            disabled={busy || !accountId || !file || dupe !== null}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SLICE 7: Drafts inbox — filename, account, extractor badge (deterministic
// CSV/OFX vs AI + confidence), extracted period/opening/ending, line count, the
// ledger-delta preview (discrepancy vs ledger at period_end), account-hint
// mismatch. Actions: Review & approve / Dismiss.
// ---------------------------------------------------------------------------

/** Deterministic parsers (CSV/OFX) vs the AI extractor — the trust signal a
 *  reviewer needs before approving. */
function isDeterministicExtractor(extractor: string | null): boolean {
  if (!extractor) return false;
  const e = extractor.toLowerCase();
  return e.includes('csv') || e.includes('ofx') || e.includes('deterministic');
}

function ExtractorBadge({ extraction }: { extraction: StatementDraftRow['extraction'] }) {
  if (!extraction) return null;
  const deterministic = isDeterministicExtractor(extraction.extractor);
  // Math.round is lint-banned (money allocation rule); confidence is a 0–1 ratio,
  // so a truncated integer percent is fine for the badge.
  const pct =
    extraction.confidence !== null ? Math.trunc(extraction.confidence * 100) : null;
  return deterministic ? (
    <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
      <ShieldCheck className="size-3" />
      Deterministic
    </Badge>
  ) : (
    <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
      <Cpu className="size-3" />
      AI read{pct !== null ? ` · ${String(pct)}%` : ''}
    </Badge>
  );
}

function StatementDraftsSection({
  drafts,
  householdId,
  userId,
  onReview,
  onChanged,
}: {
  drafts: StatementDraftRow[] | null;
  householdId: string | null;
  userId: string | null;
  onReview: (draft: StatementDraftRow) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  // Only live drafts belong in the inbox; approved/dismissed are terminal.
  const live = useMemo(
    () => (drafts ?? []).filter((d) => d.status !== 'approved' && d.status !== 'dismissed'),
    [drafts],
  );

  async function dismiss(draftId: string) {
    if (!householdId || !userId) return;
    setBusy(draftId);
    try {
      await dismissStatementDraft({ householdId, userId, draftId });
      toast.success('Draft dismissed.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not dismiss the draft.');
    } finally {
      setBusy(null);
    }
  }

  if (drafts === null || live.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Uploaded — needs review</h2>
        <span className="text-xs text-muted-foreground">{live.length}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        KEEL read these. Review the exact statement it will write, then approve — nothing
        is recorded until you do.
      </p>
      <div className="space-y-2">
        {live.map((d) => (
          <DraftCard
            key={d.draftId}
            draft={d}
            busy={busy === d.draftId}
            onReview={() => {
              onReview(d);
            }}
            onDismiss={() => {
              void dismiss(d.draftId);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function DraftCard({
  draft,
  busy,
  onReview,
  onDismiss,
}: {
  draft: StatementDraftRow;
  busy: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const ex = draft.extraction;
  const reading = ex === null || ex.status === 'pending';
  // Narrowed views: `failedEx` is set only on a read failure, `extractedEx` only
  // on a successful read — each is non-null in its own JSX branch, so no
  // redundant null checks downstream.
  const failedEx = ex !== null && ex.status === 'failed' ? ex : null;
  const extractedEx = ex !== null && ex.status === 'extracted' ? ex : null;
  const currency = (ex !== null ? ex.currency : null) ?? draft.accountCurrency;

  // Account-hint mismatch: the extractor guessed a currency that differs from
  // the account it was uploaded to. Surface it — don't silently coerce.
  const currencyMismatch =
    ex !== null && ex.currency !== null && ex.currency !== draft.accountCurrency;

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            {draft.url ? (
              <a
                href={draft.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-medium hover:underline"
                title={draft.originalFilename}
              >
                {draft.originalFilename}
              </a>
            ) : (
              <span className="min-w-0 truncate font-medium" title={draft.originalFilename}>
                {draft.originalFilename}
              </span>
            )}
            <ExtractorBadge extraction={ex} />
          </div>
          <p className="text-xs text-muted-foreground">
            {draft.accountName}
            {ex !== null && ex.holdingCount > 0 ? (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1">
                  <TrendingUp className="size-3" />
                  {ex.holdingCount} holding{ex.holdingCount === 1 ? '' : 's'}
                </span>
              </>
            ) : null}
          </p>

          {reading ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Reading statement…
            </p>
          ) : failedEx ? (
            <p className="text-xs text-keel-negative">
              Could not read this statement automatically
              {failedEx.errorCode !== null ? ` (${failedEx.errorCode})` : ''}. You can still enter
              it by hand.
            </p>
          ) : extractedEx ? (
            <div className="mt-1 space-y-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                {extractedEx.periodStart !== null && extractedEx.periodEnd !== null ? (
                  <span className="font-mono text-muted-foreground">
                    {extractedEx.periodStart} → {extractedEx.periodEnd}
                  </span>
                ) : null}
                <span className="text-muted-foreground">
                  {extractedEx.lineCount} line{extractedEx.lineCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                {extractedEx.openingMinor !== null ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Opening <Money amountMinor={extractedEx.openingMinor} currency={currency} className="text-xs" />
                  </span>
                ) : null}
                {extractedEx.endingMinor !== null ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Ending <Money amountMinor={extractedEx.endingMinor} currency={currency} className="text-xs" />
                  </span>
                ) : null}
              </div>
              {draft.discrepancyMinor !== null ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="size-3 shrink-0" />
                  {draft.discrepancyMinor === '0' ? (
                    <span>Matches your ledger at period end.</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      Ledger differs by
                      <Money amountMinor={draft.discrepancyMinor} currency={currency} signed className="text-xs" />
                    </span>
                  )}
                </p>
              ) : null}
              {currencyMismatch ? (
                <p className="flex items-center gap-1.5 text-xs text-keel-negative">
                  <AlertTriangle className="size-3 shrink-0" />
                  Read as {extractedEx.currency}, but the account is {draft.accountCurrency}.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || reading}
            onClick={onReview}
          >
            Review &amp; approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDismiss}
            aria-label="Dismiss draft"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SLICE 7 — THE GATE (Law 11). Review a draft in a prefilled, fully-editable
// form, then approve. On confirm the client builds ONE statement body and hands
// the SAME object to issue (mint the token) AND approve_draft (redeem+write) via
// runIssueThenApprove — the client half of "exact bytes approved = exact bytes
// executed". Currency comes from the ACCOUNT, never hardcoded USD [A6]. Zero
// lines are supported for anchor/valuation statements [A6].
// ---------------------------------------------------------------------------

type ReviewLine = { date: string; amount: string; description: string };

const ANCHOR_REASONS = {
  investment_valuation: 'Investment valuation',
  market_value: 'Market value',
  no_transaction_detail: 'No transaction detail',
} as const;

function ReviewDraftDialog({
  draft,
  account,
  householdId,
  userId,
  onClose,
  onApproved,
}: {
  draft: StatementDraftRow;
  account: AccountRow | null;
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onApproved: () => void;
}) {
  // Currency is the ACCOUNT's, never USD [A6]. Fall back to the draft row's
  // recorded account currency if the account object hasn't loaded.
  const currency = account?.currency ?? draft.accountCurrency;

  const [detail, setDetail] = useState<StatementDraftDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [opening, setOpening] = useState('');
  const [ending, setEnding] = useState('');
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [balanceCheck, setBalanceCheck] = useState<'strict' | 'anchor'>('strict');
  const [anchorReason, setAnchorReason] =
    useState<keyof typeof ANCHOR_REASONS>('investment_valuation');
  const [anchorGap, setAnchorGap] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);

  // Prefill from the extraction (every field stays editable).
  useEffect(() => {
    let active = true;
    if (!householdId) return;
    setDetail(null);
    setLoadError(false);
    void fetchStatementDraftDetail(householdId, draft.draftId)
      .then((d) => {
        if (!active) return;
        setDetail(d);
        const ex = d.extraction;
        setPeriodStart(ex?.periodStart ?? '');
        setPeriodEnd(ex?.periodEnd ?? '');
        setOpening(ex?.openingMinor != null ? minorToDollars(ex.openingMinor) : '');
        setEnding(ex?.endingMinor != null ? minorToDollars(ex.endingMinor) : '');
        setLines(
          d.lines.map((l) => ({
            date: l.date ?? '',
            amount: minorToDollars(l.amountMinor),
            description: l.description ?? '',
          })),
        );
        // An investment draft with holdings but no lines defaults to anchor.
        if (d.lines.length === 0 && d.holdings.length > 0) setBalanceCheck('anchor');
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [householdId, draft.draftId]);

  const form: ApproveFormInput = useMemo(
    () => ({
      periodStart,
      periodEnd,
      opening,
      ending,
      currency,
      lines,
      balanceCheck,
      ...(balanceCheck === 'anchor'
        ? { anchorReason, anchorGapExplanation: anchorGap }
        : {}),
    }),
    [periodStart, periodEnd, opening, ending, currency, lines, balanceCheck, anchorReason, anchorGap],
  );

  // Live validation using the SAME builder the submit path uses (single source
  // of truth for the client-side gate).
  const built = useMemo(() => buildStatementBody(form), [form]);

  function setLine(i: number, patch: Partial<ReviewLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function approve() {
    if (!householdId || !userId || !built.ok) return;
    setBusy(true);
    setTokenExpired(false);
    try {
      // THE GATE: issue a token for THIS body, then approve with THE SAME body.
      await runIssueThenApprove({
        householdId,
        userId,
        draftId: draft.draftId,
        balanceCheck,
        body: built.body,
        deps: {
          issue: (input) =>
            issueStatementDraftApproval(input).then((r) => ({
              tokenId: r.tokenId,
              expiresAt: r.expiresAt,
            })),
          approve: (input) => approveStatementDraft(input),
        },
      });
      toast.success('Statement approved and recorded.');
      onApproved();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not approve the statement.';
      // A stale/expired approval token: offer a clean re-try (re-issue).
      if (/EXPIRED|expired|already redeemed|P0007/.test(message)) {
        setTokenExpired(true);
        toast.error('The approval window expired — review again and re-approve.');
      } else {
        toast.error(message);
      }
    } finally {
      setBusy(false);
    }
  }

  const holdings = detail?.holdings ?? [];

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review &amp; approve statement</DialogTitle>
          <DialogDescription>
            This is the exact statement KEEL will record for{' '}
            <span className="font-medium text-foreground">{draft.accountName}</span>. Everything
            is editable — approve only what you have checked.
          </DialogDescription>
        </DialogHeader>

        {detail === null && !loadError ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {loadError ? (
              <p className="rounded-md border border-keel-negative/40 bg-keel-negative/5 px-3 py-2 text-sm text-keel-negative">
                Couldn&apos;t load the read details. You can still enter the statement by hand.
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rv-start">Period start</Label>
                <Input
                  id="rv-start"
                  type="date"
                  value={periodStart}
                  onChange={(e) => {
                    setPeriodStart(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rv-end">Period end</Label>
                <Input
                  id="rv-end"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => {
                    setPeriodEnd(e.target.value);
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rv-opening">Opening balance ({currency})</Label>
                <Input
                  id="rv-opening"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={opening}
                  onChange={(e) => {
                    setOpening(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rv-ending">Ending balance ({currency})</Label>
                <Input
                  id="rv-ending"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={ending}
                  onChange={(e) => {
                    setEnding(e.target.value);
                  }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Reconciliation mode</Label>
              <Select
                value={balanceCheck}
                items={{ strict: 'Strict (opening + lines = ending)', anchor: 'Anchor (balance only)' }}
                onValueChange={(v) => {
                  if (v === 'strict' || v === 'anchor') setBalanceCheck(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="strict">Strict (opening + lines = ending)</SelectItem>
                  <SelectItem value="anchor">Anchor (balance only — no line equation)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {balanceCheck === 'anchor' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Anchor reason</Label>
                  <Select
                    value={anchorReason}
                    items={ANCHOR_REASONS}
                    onValueChange={(v) => {
                      if (v) setAnchorReason(v);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ANCHOR_REASONS) as (keyof typeof ANCHOR_REASONS)[]).map((r) => (
                        <SelectItem key={r} value={r}>
                          {ANCHOR_REASONS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rv-gap">Why the balance differs</Label>
                  <Input
                    id="rv-gap"
                    placeholder="e.g. market moves, no per-trade detail"
                    maxLength={1000}
                    value={anchorGap}
                    onChange={(e) => {
                      setAnchorGap(e.target.value);
                    }}
                  />
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Statement lines</Label>
                {lines.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    No lines{balanceCheck === 'anchor' ? ' (anchor)' : ''}
                  </span>
                ) : null}
              </div>
              {lines.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="date"
                    className="w-36 shrink-0"
                    value={l.date}
                    onChange={(e) => {
                      setLine(i, { date: e.target.value });
                    }}
                  />
                  <Input
                    placeholder="Description"
                    value={l.description}
                    maxLength={500}
                    onChange={(e) => {
                      setLine(i, { description: e.target.value });
                    }}
                  />
                  <Input
                    className="w-28 shrink-0"
                    inputMode="decimal"
                    placeholder="-12.34"
                    value={l.amount}
                    onChange={(e) => {
                      setLine(i, { amount: e.target.value });
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove line"
                    onClick={() => {
                      setLines((prev) => prev.filter((_, idx) => idx !== i));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLines((prev) => [...prev, { date: '', amount: '', description: '' }]);
                }}
              >
                <Plus className="size-4" />
                Add line
              </Button>
            </div>

            {holdings.length > 0 ? (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <TrendingUp className="size-4" /> Holdings read from this statement
                </Label>
                <p className="text-xs text-muted-foreground">
                  Preview only — applying holdings to your portfolio comes in a later step.
                </p>
                <div className="overflow-hidden rounded-md border border-border">
                  {holdings.map((h, i) => (
                    <div
                      key={`${h.symbol ?? h.cusip ?? 'h'}-${String(i)}`}
                      className={`flex items-center gap-3 px-3 py-2 text-sm ${
                        i > 0 ? 'border-t border-border' : ''
                      }`}
                    >
                      <span className="w-20 shrink-0 truncate font-mono text-xs">
                        {h.symbol ?? h.cusip ?? h.isin ?? '—'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={h.name ?? ''}>
                        {h.name ?? ''}
                      </span>
                      {h.qty ? <span className="shrink-0 text-xs text-muted-foreground">{h.qty}</span> : null}
                      {h.valueMinor ? (
                        <Money amountMinor={h.valueMinor} currency={h.currency ?? currency} className="shrink-0 text-sm" />
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
              {built.ok ? (
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="size-4" /> Ready to approve — this is what will be written.
                </span>
              ) : (
                <span className="text-muted-foreground">{built.error}</span>
              )}
            </div>

            {tokenExpired ? (
              <p className="text-xs text-muted-foreground">
                The previous approval token expired. Re-approve to mint a fresh one.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !built.ok} onClick={() => void approve()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Approve &amp; record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
