'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  Plus,
  Loader2,
  ChevronRight,
  Undo2,
  Sparkles,
  Info,
  CalendarClock,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import { fetchEntities, keelCommand, newId, type RichTransactionRow } from '@/lib/keel-api';
import { TxnPicker } from '@/components/keel/txn-picker';
import { AttachmentsSection } from '@/components/keel/attachments-section';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
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

/** Full claim row (list proc shape — settlements included). */
type ClaimRow = {
  claimId: string;
  counterpartyName: string;
  kind: string;
  originalTransactionId: string;
  amountMinor: string;
  remainingMinor: string;
  currency: string;
  status: 'open' | 'settled' | 'reversed';
  settlements: {
    settlementId: string;
    transactionId: string;
    allocatedMinor: string;
    status: 'active' | 'reversed';
  }[];
};

const CLAIM_KINDS = ['friend', 'employer', 'client', 'insurance', 'household'] as const;

/**
 * The reimbursement commands reject a transaction the ledger can't find a single
 * live real posting for (pending, voided, transfer/distribution, or a stale id)
 * with KEEL_SCOPE_VIOLATION, which the API returns as a terse "Not found." The
 * picker already hides ineligible rows, so this only fires on a race (a row that
 * changed state between load and submit) — translate it to something actionable
 * instead of the cryptic default.
 */
function tagErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : '';
  if (/not[\s_]?found/i.test(raw)) {
    return 'That transaction can’t be reimbursed — it must be a posted expense or deposit (not pending or a transfer). Try refreshing.';
  }
  return raw || fallback;
}

/** Expected (future-dated) reimbursement — an accounts-receivable line: money
 * owed to you, tracked BEFORE it arrives. Never an economic event. */
type ExpectedRow = {
  expectedId: string;
  counterpartyName: string;
  kind: string;
  sourceTransactionId: string | null;
  amountMinor: string;
  remainingMinor: string;
  currency: string;
  expectedDate: string;
  description: string;
  status: 'open' | 'received' | 'written_off';
  receipts: {
    receiptId: string;
    transactionId: string;
    allocatedMinor: string;
    status: 'active' | 'reversed';
    note: string;
  }[];
};

export default function ReimbursementsPage() {
  return (
    <>
      <PageHeader
        title="Reimbursements"
        description="Money someone owes you back — tracked against the original expense, never fake income."
      />
      <div className="p-6">
        <ReimbursementsBody />
      </div>
    </>
  );
}

function ReimbursementsBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<ClaimRow>(
    'reimbursements.list',
    householdId,
  );
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const [creating, setCreating] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [settling, setSettling] = useState<ClaimRow | null>(null);
  // When a suggested exact-amount inflow launches the settle flow, pre-fill it.
  const [settlePrefill, setSettlePrefill] = useState<{ txnId: string; amountMinor: string } | null>(
    null,
  );
  // Reimbursement claims have no entity_id of their own; same
  // first-entity fallback as paychecks (personal households have exactly one).
  const [entityId, setEntityId] = useState<string | null>(null);

  useEffect(() => {
    if (!householdId) return;
    void fetchEntities(householdId)
      .then((entities) => {
        setEntityId(entities[0]?.entityId ?? null);
      })
      .catch(() => {
        setEntityId(null);
      });
  }, [householdId]);

  const txnById = useMemo(
    () => new Map(txns.rows.map((t) => [t.transactionId, t])),
    [txns.rows],
  );

  // Suggest-approve (class B): an inflow whose amount exactly equals an open
  // claim's remaining balance is very likely that claim's repayment. Surface a
  // pre-filled settle action here — never auto-post. Inflows already consumed
  // by any active settlement are ineligible so we never double-suggest.
  // Computed above the early returns so hook order stays stable.
  const suggestions = useMemo(() => {
    const activeClaims = rows.filter((c) => c.status !== 'reversed');
    const settledTxnIds = new Set(
      activeClaims.flatMap((c) =>
        c.settlements.filter((s) => s.status === 'active').map((s) => s.transactionId),
      ),
    );
    const out: { claim: ClaimRow; txn: RichTransactionRow }[] = [];
    const claimed = new Set<string>();
    for (const c of activeClaims) {
      if (c.status !== 'open') continue;
      const remaining = BigInt(c.remainingMinor);
      if (remaining <= 0n) continue;
      const match = txns.rows.find(
        (t) =>
          t.currency === c.currency &&
          !t.amountMinor.startsWith('-') &&
          t.amountMinor !== '0' &&
          BigInt(t.amountMinor) === remaining &&
          !settledTxnIds.has(t.transactionId) &&
          !claimed.has(t.transactionId),
      );
      if (match) {
        claimed.add(match.transactionId);
        out.push({ claim: c, txn: match });
      }
    }
    return out;
  }, [rows, txns.rows]);

  if (!ready || loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<ArrowLeftRight className="size-6" />}
        title="Couldn't load reimbursements"
        description={error}
      />
    );
  }

  const active = rows.filter((c) => c.status !== 'reversed');

  return (
    <div className="space-y-8">
      <ExpectedReimbursements
        householdId={householdId}
        userId={userId}
        ready={ready}
        txns={txns.rows}
        txnById={txnById}
      />

      <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Split a bill, expect a refund, invoice a friend — the incoming money settles
          the claim instead of counting as income.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          New claim
        </Button>
      </div>

      {suggestions.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="size-4 text-muted-foreground" />
            Likely repayments
          </div>
          <p className="text-xs text-muted-foreground">
            These deposits match an open claim to the cent. Review and settle — nothing is
            recorded until you confirm.
          </p>
          {suggestions.map(({ claim: c, txn }) => (
            <div
              key={`${c.claimId}:${txn.transactionId}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0 text-sm">
                <span className="font-medium">{c.counterpartyName}</span>
                <span className="text-muted-foreground"> · {txn.description}</span>{' '}
                <Money amountMinor={txn.amountMinor} currency={txn.currency} />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSettlePrefill({ txnId: txn.transactionId, amountMinor: c.remainingMinor });
                  setSettling(c);
                }}
              >
                Record repayment
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {active.length === 0 ? (
        <EmptyState
          icon={<ArrowLeftRight className="size-6" />}
          title="No open claims yet"
          description="A reimbursement isn't income — it's money coming back for an expense you already paid. Create a claim from any expense (a shared dinner, a work cost, an expected refund) and when the money lands, settle the claim so it never inflates your income."
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              A claim tracks money owed against the original expense. When the repayment
              deposit arrives, &ldquo;record money received&rdquo; settles the claim — it
              reduces what&rsquo;s owed and is deliberately kept out of your income totals.
            </span>
          </div>
          {active.map((c) => (
            <ClaimCard
              key={c.claimId}
              claim={c}
              originTxn={txnById.get(c.originalTransactionId)}
              open={openDetail === c.claimId}
              onToggle={() => {
                setOpenDetail(openDetail === c.claimId ? null : c.claimId);
              }}
              onSettle={() => {
                setSettling(c);
              }}
              householdId={householdId}
              userId={userId}
              entityId={entityId}
              onChanged={() => {
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      <CreateClaimDialog
        open={creating}
        txns={txns.rows}
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
      <SettleDialog
        claim={settling}
        prefill={settlePrefill}
        txns={txns.rows}
        householdId={householdId}
        userId={userId}
        onClose={() => {
          setSettling(null);
          setSettlePrefill(null);
        }}
        onSettled={() => {
          setSettling(null);
          setSettlePrefill(null);
          void refetch();
        }}
      />
      </div>
    </div>
  );
}

function ClaimCard({
  claim: c,
  originTxn,
  open,
  onToggle,
  onSettle,
  householdId,
  userId,
  entityId,
  onChanged,
}: {
  claim: ClaimRow;
  originTxn: RichTransactionRow | undefined;
  open: boolean;
  onToggle: () => void;
  onSettle: () => void;
  householdId: string | null;
  userId: string | null;
  entityId: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | { kind: 'claim' | 'settlement'; id: string }>(
    null,
  );
  const [reason, setReason] = useState('');
  const hasActiveSettlement = c.settlements.some((s) => s.status === 'active');

  async function reverse() {
    if (!householdId || !userId || !confirming || reason.trim().length === 0) return;
    const { kind, id } = confirming;
    setBusy(id);
    try {
      await keelCommand({
        commandId: newId(),
        command:
          kind === 'claim' ? 'reimbursements.reverse_claim' : 'reimbursements.reverse_settlement',
        economicEventKey: `reimbursements.reverse_${kind}:${id}:${newId()}`,
        actor: { kind: 'user', userId },
        householdId,
        payload:
          kind === 'claim'
            ? { claimId: id, reason: reason.trim() }
            : { settlementId: id, reason: reason.trim() },
      });
      toast.success(kind === 'claim' ? 'Claim cancelled.' : 'Settlement undone.');
      setConfirming(null);
      setReason('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
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
          <p className="truncate text-sm font-medium">
            {c.counterpartyName}
            <span className="ml-2 text-xs capitalize text-muted-foreground">({c.kind})</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {originTxn ? `for ${originTxn.description}` : 'original expense'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <Money amountMinor={c.remainingMinor} currency={c.currency} className="text-sm" />
            <p className="text-[11px] text-muted-foreground">still owed</p>
          </div>
          <Badge variant="secondary" className="capitalize">
            {c.status}
          </Badge>
        </div>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          <AttachmentsSection
            householdId={householdId}
            userId={userId}
            entityId={entityId}
            targetType="reimbursement_claim"
            targetId={c.claimId}
            kind="receipt"
          />
          {c.settlements.length > 0 ? (
            <div className="space-y-1">
              {c.settlements.map((s) => (
                <div key={s.settlementId} className="flex items-center gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {s.status === 'active' ? 'Received' : 'Reversed'}
                  </span>
                  <Money amountMinor={s.allocatedMinor} currency={c.currency} />
                  {s.status === 'active' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirming({ kind: 'settlement', id: s.settlementId });
                        setReason('');
                      }}
                    >
                      <Undo2 className="size-3" />
                      Undo
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing received yet.</p>
          )}

          {confirming ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor={`reverse-${c.claimId}`}>
                  Reason for {confirming.kind === 'claim' ? 'cancelling' : 'undoing'}
                </Label>
                <Input
                  id={`reverse-${c.claimId}`}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirming(null);
                  }}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || reason.trim().length === 0}
                  onClick={() => {
                    void reverse();
                  }}
                >
                  {busy !== null ? <Loader2 className="size-4 animate-spin" /> : null}
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {c.status === 'open' ? (
                <Button size="sm" onClick={onSettle}>
                  Record money received
                </Button>
              ) : null}
              {!hasActiveSettlement ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirming({ kind: 'claim', id: c.claimId });
                    setReason('');
                  }}
                >
                  Cancel claim
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CreateClaimDialog({
  open,
  txns,
  householdId,
  userId,
  onClose,
  onCreated,
}: {
  open: boolean;
  txns: RichTransactionRow[];
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [txnId, setTxnId] = useState<string | null>(null);
  const [counterparty, setCounterparty] = useState('');
  const [kind, setKind] = useState<(typeof CLAIM_KINDS)[number]>('friend');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const chosen = txns.find((t) => t.transactionId === txnId);
  const maxMinor = chosen ? BigInt(chosen.amountMinor.replace('-', '') || '0') : 0n;

  async function create() {
    if (!householdId || !userId || !txnId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    if (BigInt(minor) > maxMinor) {
      toast.error('The claim cannot exceed the original expense.');
      return;
    }
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command: 'reimbursements.create_claim',
        economicEventKey: `reimbursements.create_claim:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          originalTransactionId: txnId,
          counterpartyName: counterparty.trim(),
          kind,
          amountMinor: minor,
          currency: chosen?.currency ?? 'USD',
          description: description.trim() || `Owed by ${counterparty.trim()}`,
        },
      });
      toast.success('Claim created.');
      setTxnId(null);
      setCounterparty('');
      setAmount('');
      setDescription('');
      onCreated();
    } catch (err) {
      toast.error(tagErrorMessage(err, 'Could not create the claim.'));
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
          <DialogTitle>New claim</DialogTitle>
          <DialogDescription>
            Pick the expense, who owes you, and how much of it is theirs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Original expense</Label>
            <TxnPicker
              rows={txns}
              direction="outflow"
              value={txnId}
              onChange={setTxnId}
              placeholder="Pick the expense transaction"
              eligibleOnly
            />
            <p className="text-xs text-muted-foreground">
              Pending charges appear here once they post.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="claim-who">Who owes you</Label>
              <Input
                id="claim-who"
                value={counterparty}
                maxLength={200}
                placeholder="e.g. Sam"
                onChange={(e) => {
                  setCounterparty(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Relationship</Label>
              <Select
                value={kind}
                items={Object.fromEntries(
                  CLAIM_KINDS.map((k) => [k, k.charAt(0).toUpperCase() + k.slice(1)]),
                )}
                onValueChange={(v) => {
                  if (v) setKind(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLAIM_KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-amount">Their share</Label>
            <Input
              id="claim-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
              }}
            />
            {chosen ? (
              <p className="text-xs text-muted-foreground">
                Expense total:{' '}
                <Money amountMinor={chosen.amountMinor} currency={chosen.currency} signed />
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-desc">Note</Label>
            <Input
              id="claim-desc"
              value={description}
              maxLength={500}
              placeholder="e.g. their half of dinner"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !txnId || counterparty.trim().length === 0 || !amount.trim()}
            onClick={() => {
              void create();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettleDialog({
  claim,
  prefill,
  txns,
  householdId,
  userId,
  onClose,
  onSettled,
}: {
  claim: ClaimRow | null;
  prefill: { txnId: string; amountMinor: string } | null;
  txns: RichTransactionRow[];
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [txnId, setTxnId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Never carry claim A's draft into claim B's dialog. When a suggestion
  // launched the dialog, seed the matched deposit + amount for one-click confirm.
  const prefillTxnId = prefill?.txnId ?? null;
  const prefillAmountMinor = prefill?.amountMinor ?? null;
  useEffect(() => {
    setTxnId(prefillTxnId);
    setAmount(prefillAmountMinor ? minorToDollars(prefillAmountMinor) : '');
    setNote('');
  }, [claim?.claimId, prefillTxnId, prefillAmountMinor]);

  async function settle() {
    if (!householdId || !userId || !claim || !txnId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    if (BigInt(minor) > BigInt(claim.remainingMinor)) {
      toast.error('More than is left on the claim.');
      return;
    }
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command: 'reimbursements.settle',
        economicEventKey: `reimbursements.settle:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          transactionId: txnId,
          allocations: [{ claimId: claim.claimId, amountMinor: minor }],
          note: note.trim() || `Settlement from ${claim.counterpartyName}`,
        },
      });
      toast.success('Settlement recorded — no fake income.');
      setTxnId(null);
      setAmount('');
      setNote('');
      onSettled();
    } catch (err) {
      toast.error(tagErrorMessage(err, 'Could not record the settlement.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={claim !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record money received</DialogTitle>
          <DialogDescription>
            Pick the deposit that pays this claim back. It reduces the claim instead of
            counting as income.
          </DialogDescription>
        </DialogHeader>
        {claim ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
              {claim.counterpartyName} still owes{' '}
              <Money amountMinor={claim.remainingMinor} currency={claim.currency} />
            </div>
            <div className="space-y-1.5">
              <Label>Deposit received</Label>
              <TxnPicker
                rows={txns}
                direction="inflow"
                value={txnId}
                onChange={setTxnId}
                placeholder="Pick the incoming transaction"
                eligibleOnly
              />
              <p className="text-xs text-muted-foreground">
                Pending deposits appear here once they post.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settle-amount">Amount applied to this claim</Label>
              <Input
                id="settle-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settle-note">Note</Label>
              <Input
                id="settle-note"
                value={note}
                maxLength={500}
                placeholder="e.g. Venmo from Sam"
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !txnId || !amount.trim()}
            onClick={() => {
              void settle();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Expected (future-dated) reimbursements — accounts-receivable lines.
// Money someone owes you, tracked BEFORE it arrives. Not income, not a ledger
// event: it only settles when a real inbound transaction is matched to it
// (suggest→approve). Ones that never arrive stay open or get written off.
// ===========================================================================

const STATUS_LABEL: Record<ExpectedRow['status'], string> = {
  open: 'Expected',
  received: 'Received',
  written_off: 'Written off',
};

function ExpectedReimbursements({
  householdId,
  userId,
  ready,
  txns,
  txnById,
}: {
  householdId: string | null;
  userId: string | null;
  ready: boolean;
  txns: RichTransactionRow[];
  txnById: Map<string, RichTransactionRow>;
}) {
  const { rows, loading, error, refetch } = useKeelQuery<ExpectedRow>(
    'expected_reimbursements.list',
    householdId,
  );
  const [creating, setCreating] = useState(false);
  const [receiptFor, setReceiptFor] = useState<ExpectedRow | null>(null);

  if (!ready || loading) {
    return <Skeleton className="h-24 w-full" />;
  }

  const open = rows.filter((r) => r.status === 'open');
  const resolved = rows.filter((r) => r.status !== 'open');
  const outstandingMinor = open
    .reduce((sum, r) => sum + BigInt(r.remainingMinor), 0n)
    .toString();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="size-4 text-muted-foreground" />
            Expected — money owed to you
          </h2>
          <p className="text-xs text-muted-foreground">
            Track what someone owes you before it lands. It stays out of your income until
            the repayment actually arrives and you match it.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          Expect a repayment
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">Couldn&rsquo;t load expected reimbursements.</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing expected yet. When you front money for someone — cruise tickets, a shared
          bill, a corporate transfer to your business — record it here so you don&rsquo;t forget
          it&rsquo;s coming.
        </div>
      ) : (
        <div className="space-y-2">
          {open.length > 0 ? (
            <div className="flex items-center justify-between rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Outstanding (expected to arrive)</span>
              <Money amountMinor={outstandingMinor} currency={open[0]?.currency ?? 'USD'} />
            </div>
          ) : null}
          {[...open, ...resolved].map((r) => (
            <ExpectedCard
              key={r.expectedId}
              row={r}
              sourceTxn={r.sourceTransactionId ? txnById.get(r.sourceTransactionId) : undefined}
              householdId={householdId}
              userId={userId}
              onRecordReceipt={() => {
                setReceiptFor(r);
              }}
              onChanged={() => {
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      <CreateExpectedDialog
        open={creating}
        txns={txns}
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
      <RecordReceiptDialog
        row={receiptFor}
        txns={txns}
        householdId={householdId}
        userId={userId}
        onClose={() => {
          setReceiptFor(null);
        }}
        onRecorded={() => {
          setReceiptFor(null);
          void refetch();
        }}
      />
    </div>
  );
}

function ExpectedCard({
  row: r,
  sourceTxn,
  householdId,
  userId,
  onRecordReceipt,
  onChanged,
}: {
  row: ExpectedRow;
  sourceTxn: RichTransactionRow | undefined;
  householdId: string | null;
  userId: string | null;
  onRecordReceipt: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<
    null | { kind: 'write_off' | 'reopen' | 'reverse_receipt'; id: string }
  >(null);
  const [reason, setReason] = useState('');

  async function run(command: string, payload: Record<string, unknown>, ok: string) {
    if (!householdId || !userId) return;
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command,
        economicEventKey: `${command}:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload,
      });
      toast.success(ok);
      setConfirming(null);
      setReason('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  const activeReceipts = r.receipts.filter((x) => x.status === 'active');

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {r.counterpartyName}
            <span className="ml-2 text-xs capitalize text-muted-foreground">({r.kind})</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {r.description} · expected {r.expectedDate}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <Money amountMinor={r.remainingMinor} currency={r.currency} className="text-sm" />
            <p className="text-[11px] text-muted-foreground">
              {r.status === 'open' ? 'still expected' : 'of ' }
              {r.status !== 'open' ? (
                <Money amountMinor={r.amountMinor} currency={r.currency} className="text-[11px]" />
              ) : null}
            </p>
          </div>
          <Badge variant={r.status === 'open' ? 'secondary' : 'outline'} className="capitalize">
            {STATUS_LABEL[r.status]}
          </Badge>
        </div>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {sourceTxn ? (
            <p className="text-xs text-muted-foreground">
              Carved from {sourceTxn.description}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Standalone — not tied to an expense.</p>
          )}
          {r.receipts.length > 0 ? (
            <div className="space-y-1">
              {r.receipts.map((x) => (
                <div key={x.receiptId} className="flex items-center gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {x.status === 'active' ? 'Received' : 'Reversed'}
                  </span>
                  <Money amountMinor={x.allocatedMinor} currency={r.currency} />
                  <span className="truncate text-xs text-muted-foreground">{x.note}</span>
                  {x.status === 'active' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={() => {
                        setConfirming({ kind: 'reverse_receipt', id: x.receiptId });
                        setReason('');
                      }}
                    >
                      <Undo2 className="size-3" />
                      Undo
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing received yet.</p>
          )}

          {confirming ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor={`reason-${r.expectedId}`}>Reason</Label>
                <Input
                  id={`reason-${r.expectedId}`}
                  value={reason}
                  maxLength={500}
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
                    setConfirming(null);
                  }}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => {
                    if (confirming.kind === 'write_off') {
                      void run(
                        'expected_reimbursements.write_off',
                        { expectedId: r.expectedId, reason: reason.trim() },
                        'Written off.',
                      );
                    } else if (confirming.kind === 'reopen') {
                      void run(
                        'expected_reimbursements.reopen',
                        { expectedId: r.expectedId, reason: reason.trim() },
                        'Reopened.',
                      );
                    } else {
                      void run(
                        'expected_reimbursements.reverse_receipt',
                        { receiptId: confirming.id, reason: reason.trim() },
                        'Receipt undone.',
                      );
                    }
                  }}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {r.status === 'open' ? (
                <>
                  <Button size="sm" onClick={onRecordReceipt}>
                    Record money received
                  </Button>
                  {activeReceipts.length === 0 ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setConfirming({ kind: 'write_off', id: r.expectedId });
                        setReason('');
                      }}
                    >
                      Write off
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirming({ kind: 'reopen', id: r.expectedId });
                    setReason('');
                  }}
                >
                  Reopen
                </Button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CreateExpectedDialog({
  open,
  txns,
  householdId,
  userId,
  onClose,
  onCreated,
}: {
  open: boolean;
  txns: RichTransactionRow[];
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [fromExpense, setFromExpense] = useState(false);
  const [txnId, setTxnId] = useState<string | null>(null);
  const [counterparty, setCounterparty] = useState('');
  const [kind, setKind] = useState<(typeof CLAIM_KINDS)[number]>('friend');
  const [amount, setAmount] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const chosen = fromExpense ? txns.find((t) => t.transactionId === txnId) : undefined;
  const maxMinor = chosen ? BigInt(chosen.amountMinor.replace('-', '') || '0') : null;

  async function create() {
    if (!householdId || !userId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    if (maxMinor !== null && BigInt(minor) > maxMinor) {
      toast.error('The expectation cannot exceed the source expense.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) {
      toast.error('Pick an expected date.');
      return;
    }
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command: 'expected_reimbursements.create',
        economicEventKey: `expected_reimbursements.create:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          counterpartyName: counterparty.trim(),
          kind,
          amountMinor: minor,
          currency: chosen?.currency ?? 'USD',
          expectedDate,
          description: description.trim() || `Expected from ${counterparty.trim()}`,
          ...(fromExpense && txnId ? { sourceTransactionId: txnId } : {}),
        },
      });
      toast.success('Expected reimbursement created.');
      setFromExpense(false);
      setTxnId(null);
      setCounterparty('');
      setAmount('');
      setExpectedDate('');
      setDescription('');
      onCreated();
    } catch (err) {
      toast.error(tagErrorMessage(err, 'Could not create it.'));
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
          <DialogTitle>Expect a repayment</DialogTitle>
          <DialogDescription>
            Record money someone owes you before it arrives. It won&rsquo;t count as income until
            the actual repayment lands and you match it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={fromExpense ? 'outline' : 'default'}
              onClick={() => {
                setFromExpense(false);
                setTxnId(null);
              }}
            >
              Standalone
            </Button>
            <Button
              type="button"
              size="sm"
              variant={fromExpense ? 'default' : 'outline'}
              onClick={() => {
                setFromExpense(true);
              }}
            >
              From an expense
            </Button>
          </div>
          {fromExpense ? (
            <div className="space-y-1.5">
              <Label>Source expense</Label>
              <TxnPicker
                rows={txns}
                direction="outflow"
                value={txnId}
                onChange={setTxnId}
                placeholder="Pick the expense you fronted"
                eligibleOnly
              />
              <p className="text-xs text-muted-foreground">
                Pending charges appear here once they post.
              </p>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-who">Who owes you</Label>
              <Input
                id="exp-who"
                value={counterparty}
                maxLength={200}
                placeholder="e.g. Leo"
                onChange={(e) => {
                  setCounterparty(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Relationship</Label>
              <Select
                value={kind}
                items={Object.fromEntries(
                  CLAIM_KINDS.map((k) => [k, k.charAt(0).toUpperCase() + k.slice(1)]),
                )}
                onValueChange={(v) => {
                  if (v) setKind(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLAIM_KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-amount">Amount owed</Label>
              <Input
                id="exp-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
              {chosen ? (
                <p className="text-xs text-muted-foreground">
                  Expense total:{' '}
                  <Money amountMinor={chosen.amountMinor} currency={chosen.currency} signed />
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-date">Expected by</Label>
              <Input
                id="exp-date"
                type="date"
                value={expectedDate}
                onChange={(e) => {
                  setExpectedDate(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp-desc">Note</Label>
            <Input
              id="exp-desc"
              value={description}
              maxLength={500}
              placeholder="e.g. his half of the cruise tickets"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              counterparty.trim().length === 0 ||
              !amount.trim() ||
              !expectedDate ||
              (fromExpense && !txnId)
            }
            onClick={() => {
              void create();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordReceiptDialog({
  row,
  txns,
  householdId,
  userId,
  onClose,
  onRecorded,
}: {
  row: ExpectedRow | null;
  txns: RichTransactionRow[];
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [txnId, setTxnId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const expectedId = row?.expectedId ?? null;
  useEffect(() => {
    setTxnId(null);
    setAmount(row ? minorToDollars(row.remainingMinor) : '');
    setNote('');
  }, [expectedId, row]);

  async function record() {
    if (!householdId || !userId || !row || !txnId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    if (BigInt(minor) > BigInt(row.remainingMinor)) {
      toast.error('More than is still expected.');
      return;
    }
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command: 'expected_reimbursements.record_receipt',
        economicEventKey: `expected_reimbursements.record_receipt:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          expectedId: row.expectedId,
          transactionId: txnId,
          amountMinor: minor,
          note: note.trim() || `Received from ${row.counterpartyName}`,
        },
      });
      toast.success('Receipt recorded — no fake income.');
      onRecorded();
    } catch (err) {
      toast.error(tagErrorMessage(err, 'Could not record it.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record money received</DialogTitle>
          <DialogDescription>
            Match the actual deposit that pays this back. It settles the expectation instead
            of counting as income.
          </DialogDescription>
        </DialogHeader>
        {row ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
              {row.counterpartyName} still owes{' '}
              <Money amountMinor={row.remainingMinor} currency={row.currency} />
            </div>
            <div className="space-y-1.5">
              <Label>Deposit received</Label>
              <TxnPicker
                rows={txns}
                direction="inflow"
                value={txnId}
                onChange={setTxnId}
                placeholder="Pick the incoming transaction"
                eligibleOnly
              />
              <p className="text-xs text-muted-foreground">
                Pending deposits appear here once they post.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcpt-amount">Amount applied</Label>
              <Input
                id="rcpt-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rcpt-note">Note</Label>
              <Input
                id="rcpt-note"
                value={note}
                maxLength={500}
                placeholder="e.g. Venmo from Leo"
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !txnId || !amount.trim()}
            onClick={() => {
              void record();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
