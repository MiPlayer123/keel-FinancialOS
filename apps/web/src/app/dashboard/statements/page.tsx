'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileCheck2, Plus, Trash2, Loader2, ChevronRight, LockOpen } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  keelCommand,
  keelQuery,
  newId,
  type AccountRow,
  type RichTransactionRow,
  type StatementRow,
} from '@/lib/keel-api';
import { sha256Hex, parseSignedDollars, minorToDollars } from '@/lib/hash';
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
        description="Enter a bank statement, reconcile it against the ledger, lock the period."
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
  const [creating, setCreating] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!householdId) return;
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
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
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          A statement is the bank&apos;s own record for a period. Enter one and KEEL
          checks it line-by-line against your ledger.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          New statement
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<FileCheck2 className="size-6" />}
          title="No statements yet"
          description="Enter your first bank statement to reconcile a period — the Quicken habit, kept."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <StatementCard
              key={s.statementId}
              statement={s}
              accountName={accountName(s.accountId)}
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
    </div>
  );
}

function StatementCard({
  statement: s,
  accountName,
  open,
  onToggle,
  householdId,
  userId,
  onChanged,
}: {
  statement: StatementRow;
  accountName: string;
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
      `${t.effectiveDate.slice(5)} · ${t.description.slice(0, 36)}`,
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
                                  {t.effectiveDate.slice(5)} · {t.description.slice(0, 36)}
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
