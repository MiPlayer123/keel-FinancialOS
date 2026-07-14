'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Plus, Loader2, ChevronRight, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import { keelCommand, newId, type RichTransactionRow } from '@/lib/keel-api';
import { TxnPicker } from '@/components/keel/txn-picker';
import { parseSignedDollars } from '@/lib/hash';
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

  const txnById = useMemo(
    () => new Map(txns.rows.map((t) => [t.transactionId, t])),
    [txns.rows],
  );

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

      {active.length === 0 ? (
        <EmptyState
          icon={<ArrowLeftRight className="size-6" />}
          title="No open claims"
          description="Create a claim from any expense — a shared dinner, a work cost, an expected refund."
        />
      ) : (
        <div className="space-y-2">
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
        txns={txns.rows}
        householdId={householdId}
        userId={userId}
        onClose={() => {
          setSettling(null);
        }}
        onSettled={() => {
          setSettling(null);
          void refetch();
        }}
      />
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
  onChanged,
}: {
  claim: ClaimRow;
  originTxn: RichTransactionRow | undefined;
  open: boolean;
  onToggle: () => void;
  onSettle: () => void;
  householdId: string | null;
  userId: string | null;
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
      toast.error(err instanceof Error ? err.message : 'Could not create the claim.');
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
            />
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
  txns,
  householdId,
  userId,
  onClose,
  onSettled,
}: {
  claim: ClaimRow | null;
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

  // Never carry claim A's draft into claim B's dialog.
  useEffect(() => {
    setTxnId(null);
    setAmount('');
    setNote('');
  }, [claim?.claimId]);

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
      toast.error(err instanceof Error ? err.message : 'Could not record the settlement.');
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
              />
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
