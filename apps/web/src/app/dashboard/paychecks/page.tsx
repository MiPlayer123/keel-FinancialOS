'use client';

import { useEffect, useMemo, useState } from 'react';
import { Banknote, Plus, Loader2, ChevronRight, Pencil, Trash2, Undo2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchEntities,
  keelCommand,
  newId,
  type RecurringSeriesRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import { TxnPicker } from '@/components/keel/txn-picker';
import { AttachmentsSection } from '@/components/keel/attachments-section';
import { sha256Hex, parseSignedDollars, minorToDollars } from '@/lib/hash';
import { relativeDueLabel } from '@/lib/relative-date';
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

/** Full paycheck row (list proc shape). */
type PaycheckFull = {
  paycheckId: string;
  employerName: string;
  payDate: string;
  grossMinor: string;
  netMinor: string;
  currency: string;
  status: 'active' | 'reversed';
  components: { componentId: string; key: string; kind: string; amountMinor: string }[];
  matches: { componentId: string; transactionId: string }[];
};

/**
 * v1 component kinds. Destination kinds other than direct_deposit
 * (401k/HSA/FSA/ESPP/employer match) require full transaction matching per
 * component and are deferred — `benefit` covers them economically.
 */
const EARNING_KINDS = ['gross_salary', 'bonus', 'commission'] as const;
const DEDUCTION_KINDS = [
  'federal_withholding',
  'state_withholding',
  'local_withholding',
  'fica_withholding',
  'benefit',
  'rsu_withholding',
  'garnishment',
] as const;
const KIND_LABELS: Record<string, string> = {
  gross_salary: 'Salary / wages',
  bonus: 'Bonus',
  commission: 'Commission',
  reimbursement: 'Expense reimbursement',
  federal_withholding: 'Federal tax',
  state_withholding: 'State tax',
  local_withholding: 'Local tax',
  fica_withholding: 'Social Security / Medicare',
  benefit: 'Benefits (health, 401k, HSA…)',
  rsu_withholding: 'RSU withholding',
  garnishment: 'Garnishment',
  direct_deposit: 'Direct deposit',
};

type DraftComponent = { kind: string; amount: string };

type PaycheckPrefill = { employer: string; netDollars: string; depositTxnId: string | null };

/** Human cadence label from the gaps between expected occurrence dates. */
function cadenceLabel(dates: string[]): string {
  if (dates.length < 2) return 'recurring';
  const sorted = [...dates].sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1] ?? '');
    const b = new Date(sorted[i] ?? '');
    // Dates are civil midnights; the gap is an exact whole number of days.
    gaps.push(Math.trunc((b.getTime() - a.getTime()) / 86400000));
  }
  gaps.sort((x, y) => x - y);
  const g = gaps[Math.floor(gaps.length / 2)] ?? 30;
  if (g <= 8) return 'weekly';
  if (g <= 15) return 'every two weeks';
  if (g <= 17) return 'twice a month';
  if (g <= 32) return 'monthly';
  return `about every ${String(g)} days`;
}

export default function PaychecksPage() {
  return (
    <>
      <PageHeader
        title="Paychecks"
        description="Gross to net, every deduction accounted for, reconciled to the deposit."
      />
      <div className="p-6">
        <PaychecksBody />
      </div>
    </>
  );
}

function PaychecksBody() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<PaycheckFull>(
    'paychecks.list',
    householdId,
  );
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const recurring = useKeelQuery<RecurringSeriesRow>('recurring.list', householdId);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<PaycheckPrefill | null>(null);
  const [editing, setEditing] = useState<PaycheckFull | null>(null);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  // Paychecks have no entity_id of their own; a paystub attachment needs
  // SOME entity, so the household's first (personal households only ever
  // have one) stands in — same fallback pattern as the Plaid connect flow.
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

  // Detected income = recurring INFLOW series (the detector already found
  // the payday cadence); recording stays explicit (suggest→approve).
  const detectedIncome = useMemo(
    () =>
      recurring.rows.filter(
        (r) => r.sign === 'inflow' && (r.status === 'confirmed' || r.status === 'suggested'),
      ),
    [recurring.rows],
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
        icon={<Banknote className="size-6" />}
        title="Couldn't load paychecks"
        description={error}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Record a paycheck from your paystub — KEEL checks the math (gross − deductions
          = net = deposit) and ties it to the real bank deposit.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus className="size-4" />
          Record paycheck
        </Button>
      </div>

      {detectedIncome.length > 0 ? (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4" />
            Detected income
          </h2>
          <div className="space-y-2">
            {detectedIncome.map((series) => {
              const todayIso = new Date().toISOString().slice(0, 10);
              const upcoming = series.occurrences
                .filter((o) => o.status === 'expected')
                .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
              const next = upcoming.find((o) => o.expectedDate >= todayIso);
              const amount = next ?? upcoming[0];
              return (
                <div
                  key={series.seriesId}
                  className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{series.counterpartyKey}</p>
                    <p className="text-xs text-muted-foreground">
                      Pays {cadenceLabel(series.occurrences.map((o) => o.expectedDate))}
                      {amount ? (
                        <>
                          {' · '}
                          <Money
                            amountMinor={amount.expectedAmountMinor}
                            currency={amount.currency}
                            className="text-xs"
                          />
                          {next ? (
                            <>
                              {' '}next on <span className="font-mono">{next.expectedDate}</span>
                              {relativeDueLabel(next.expectedDate, todayIso) ? (
                                <span> ({relativeDueLabel(next.expectedDate, todayIso)})</span>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const netMinor = amount?.expectedAmountMinor ?? '';
                      const match = txns.rows.find(
                        (t) => netMinor !== '' && t.amountMinor === netMinor,
                      );
                      setPrefill({
                        employer: series.counterpartyKey,
                        netDollars: netMinor ? minorToDollars(netMinor) : '',
                        depositTxnId: match?.transactionId ?? null,
                      });
                      setCreating(true);
                    }}
                  >
                    Record this paycheck
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Banknote className="size-6" />}
          title="No paychecks yet"
          description="Record your first paycheck to see gross-to-net and where the withholding goes."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <PaycheckCard
              key={p.paycheckId}
              paycheck={p}
              open={openDetail === p.paycheckId}
              onToggle={() => {
                setOpenDetail(openDetail === p.paycheckId ? null : p.paycheckId);
              }}
              householdId={householdId}
              userId={userId}
              entityId={entityId}
              onEdit={() => {
                setEditing(p);
              }}
              onChanged={() => {
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      <PaycheckFormDialog
        open={creating || editing !== null}
        editing={editing}
        txns={txns.rows}
        prefill={prefill}
        householdId={householdId}
        userId={userId}
        onClose={() => {
          setCreating(false);
          setPrefill(null);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setPrefill(null);
          setEditing(null);
          void refetch();
        }}
      />
    </div>
  );
}

function PaycheckCard({
  paycheck: p,
  open,
  onToggle,
  householdId,
  userId,
  entityId,
  onEdit,
  onChanged,
}: {
  paycheck: PaycheckFull;
  open: boolean;
  onToggle: () => void;
  householdId: string | null;
  userId: string | null;
  entityId: string | null;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reversed = p.status === 'reversed';

  async function transition() {
    if (!householdId || !userId || reason.trim().length === 0) return;
    setBusy(true);
    try {
      await keelCommand({
        commandId: newId(),
        command: reversed ? 'paychecks.restore' : 'paychecks.reverse',
        economicEventKey: `paychecks.${reversed ? 'restore' : 'reverse'}:${p.paycheckId}:${newId()}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: { paycheckId: p.paycheckId, reason: reason.trim() },
      });
      toast.success(reversed ? 'Paycheck restored.' : 'Paycheck reversed.');
      setConfirming(false);
      setReason('');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed.');
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
          <p className="truncate text-sm font-medium">{p.employerName}</p>
          <p className="font-mono text-xs text-muted-foreground">{p.payDate}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right text-sm">
            <Money amountMinor={p.netMinor} currency={p.currency} />
            <p className="text-[11px] text-muted-foreground">
              net of <Money amountMinor={p.grossMinor} currency={p.currency} className="text-[11px]" />
            </p>
          </div>
          <Badge variant={reversed ? 'outline' : 'secondary'} className="capitalize">
            {p.status}
          </Badge>
        </div>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          <div className="space-y-1">
            {p.components.map((c) => (
              <div key={c.componentId} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{KIND_LABELS[c.kind] ?? c.kind}</span>
                <Money amountMinor={c.amountMinor} currency={p.currency} />
              </div>
            ))}
          </div>

          <AttachmentsSection
            householdId={householdId}
            userId={userId}
            entityId={entityId}
            targetType="paycheck"
            targetId={p.paycheckId}
            kind="receipt"
          />

          {confirming ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor={`pc-reason-${p.paycheckId}`}>
                  Reason for {reversed ? 'restoring' : 'reversing'}
                </Label>
                <Input
                  id={`pc-reason-${p.paycheckId}`}
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
                    setConfirming(false);
                  }}
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => {
                    void transition();
                  }}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {/* Paychecks are immutable once recorded (correction is
                  reverse + recreate, not an in-place edit) -- so editing
                  only makes sense for an ACTIVE paycheck; a reversed one
                  has nothing to reverse-and-replace. */}
              {reversed ? null : (
                <Button variant="outline" size="sm" onClick={onEdit}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirming(true);
                  setReason('');
                }}
              >
                <Undo2 className="size-4" />
                {reversed ? 'Restore' : 'Reverse'}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function sumMinor(items: DraftComponent[], kinds: readonly string[]): bigint {
  let total = 0n;
  for (const c of items) {
    if (!kinds.includes(c.kind)) continue;
    const v = parseSignedDollars(c.amount);
    if (v === null || v.startsWith('-')) continue;
    total += BigInt(v);
  }
  return total;
}

function PaycheckFormDialog({
  open,
  editing,
  txns,
  prefill,
  householdId,
  userId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Non-null = editing this paycheck (reverse + recreate); null = a fresh record. */
  editing: PaycheckFull | null;
  txns: RichTransactionRow[];
  prefill: PaycheckPrefill | null;
  householdId: string | null;
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [employer, setEmployer] = useState('');
  const [payDate, setPayDate] = useState('');
  const [components, setComponents] = useState<DraftComponent[]>([
    { kind: 'gross_salary', amount: '' },
    { kind: 'federal_withholding', amount: '' },
  ]);
  const [depositTxnId, setDepositTxnId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefill from a detected income series when the dialog opens for a NEW
  // paycheck. Editing takes priority when both happen to be set.
  useEffect(() => {
    if (!open || !prefill || editing) return;
    setEmployer(prefill.employer);
    setDepositTxnId(prefill.depositTxnId);
    const deposit = txns.find((t) => t.transactionId === prefill.depositTxnId);
    if (deposit) setPayDate(deposit.effectiveDate);
    // Keyed on `open` only by design: apply the prefill once per open.
  }, [open, prefill, editing, txns]);

  // Prefill every field from the paycheck being edited. Paychecks always
  // carry exactly one auto-derived direct_deposit line (see `create`/`save`
  // below) — that one is excluded here since it's re-computed from the
  // other lines, not user-editable.
  useEffect(() => {
    if (!open || !editing) return;
    setEmployer(editing.employerName);
    setPayDate(editing.payDate);
    setComponents(
      editing.components
        .filter((c) => c.kind !== 'direct_deposit')
        .map((c) => ({ kind: c.kind, amount: minorToDollars(c.amountMinor) })),
    );
    const depositComponent = editing.components.find((c) => c.kind === 'direct_deposit');
    const depositMatch = depositComponent
      ? editing.matches.find((m) => m.componentId === depositComponent.componentId)
      : undefined;
    setDepositTxnId(depositMatch?.transactionId ?? null);
    setReason('');
    // Deliberately keyed on the paycheck ID, not the `editing` object
    // itself: the parent re-renders with a fresh object reference for the
    // same underlying paycheck on every refetch, and re-running this
    // effect then would silently discard whatever the user had already
    // typed. Only actually switching WHICH paycheck is being edited (or
    // opening the dialog) should re-prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [open, editing?.paycheckId]);

  // Server equations (keel_paycheck_create): gross = Σ earnings;
  // net = gross + reimbursements − deductions; Σ direct_deposit = net.
  // v1 keeps exactly one auto-computed direct_deposit component.
  const math = useMemo(() => {
    const gross = sumMinor(components, EARNING_KINDS);
    const additions = sumMinor(components, ['reimbursement']);
    const deductions = sumMinor(components, DEDUCTION_KINDS);
    const net = gross + additions - deductions;
    const valid =
      components.every((c) => {
        const v = parseSignedDollars(c.amount);
        return v !== null && !v.startsWith('-') && v !== '0';
      }) &&
      gross > 0n &&
      net > 0n;
    return { gross, net, valid };
  }, [components]);

  const deposit = txns.find((t) => t.transactionId === depositTxnId);
  const depositTooSmall =
    deposit !== undefined && math.valid && BigInt(deposit.amountMinor) < math.net;

  function setComponent(i: number, patch: Partial<DraftComponent>) {
    setComponents((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  async function save() {
    if (!householdId || !userId || !depositTxnId || !math.valid) return;
    if (editing && reason.trim().length === 0) return;
    setBusy(true);
    try {
      const payloadComponents = [
        ...components.map((c, i) => ({
          key: `${c.kind}-${String(i + 1)}`,
          kind: c.kind,
          amountMinor: parseSignedDollars(c.amount) ?? '0',
        })),
        { key: 'deposit-1', kind: 'direct_deposit', amountMinor: math.net.toString() },
      ];
      const body = {
        employerName: employer.trim(),
        payDate,
        grossMinor: math.gross.toString(),
        netMinor: math.net.toString(),
        currency: 'USD',
        components: payloadComponents,
        matches: [
          { transactionId: depositTxnId, componentKey: 'deposit-1', amountMinor: math.net.toString() },
        ],
      };
      const contentHash = await sha256Hex(JSON.stringify(body));
      const source = {
        kind: 'manual' as const,
        ref: `manual:${employer.trim()}:${payDate}`,
        contentHash,
      };
      await keelCommand({
        commandId: newId(),
        command: editing ? 'paychecks.edit' : 'paychecks.create',
        economicEventKey: editing
          ? `paychecks.edit:${editing.paycheckId}:${contentHash}`
          : `paychecks.create:${contentHash}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: editing
          ? { ...body, source, paycheckId: editing.paycheckId, reason: reason.trim() }
          : { ...body, source },
      });
      toast.success(
        editing ? 'Paycheck corrected — the old record stays as reversed history.' : 'Paycheck recorded and reconciled to the deposit.',
      );
      setEmployer('');
      setPayDate('');
      setComponents([
        { kind: 'gross_salary', amount: '' },
        { kind: 'federal_withholding', amount: '' },
      ]);
      setDepositTxnId(null);
      setReason('');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the paycheck.');
    } finally {
      setBusy(false);
    }
  }

  const kindOptions = [...EARNING_KINDS, 'reimbursement', ...DEDUCTION_KINDS];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit paycheck' : 'Record a paycheck'}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Paychecks are immutable once recorded, so saving reverses the old one and records this as its replacement — the original stays in history, marked reversed."
              : 'Copy the lines from your paystub. KEEL derives gross and net and ties the net to your actual bank deposit.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {editing ? (
            <div className="space-y-1.5">
              <Label htmlFor="pc-edit-reason">Reason for the correction</Label>
              <Input
                id="pc-edit-reason"
                value={reason}
                maxLength={500}
                placeholder="e.g. Fixed a typo in the withholding amount"
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pc-employer">Employer</Label>
              <Input
                id="pc-employer"
                value={employer}
                maxLength={200}
                onChange={(e) => {
                  setEmployer(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pc-date">Pay date</Label>
              <Input
                id="pc-date"
                type="date"
                value={payDate}
                onChange={(e) => {
                  setPayDate(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Paystub lines</Label>
            {components.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={c.kind}
                  items={Object.fromEntries(kindOptions.map((k) => [k, KIND_LABELS[k] ?? k]))}
                  onValueChange={(v) => {
                    if (v) setComponent(i, { kind: v });
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kindOptions.map((k) => (
                      <SelectItem key={k} value={k}>
                        {KIND_LABELS[k] ?? k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="w-28 shrink-0"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={c.amount}
                  onChange={(e) => {
                    setComponent(i, { amount: e.target.value });
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove line"
                  disabled={components.length <= 1}
                  onClick={() => {
                    setComponents((prev) => prev.filter((_, idx) => idx !== i));
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
                setComponents((prev) => [...prev, { kind: 'benefit', amount: '' }]);
              }}
            >
              <Plus className="size-4" />
              Add line
            </Button>
          </div>

          <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
            {math.valid ? (
              <span>
                Gross <Money amountMinor={math.gross.toString()} /> → Net{' '}
                <Money amountMinor={math.net.toString()} />
              </span>
            ) : (
              <span className="text-muted-foreground">
                Enter earnings and deductions to derive gross and net.
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Bank deposit for this paycheck</Label>
            <TxnPicker
              rows={txns}
              direction="inflow"
              value={depositTxnId}
              onChange={setDepositTxnId}
              placeholder="Pick the deposit transaction"
            />
            {depositTooSmall ? (
              <p className="text-xs text-keel-negative">
                That deposit is smaller than the computed net — check the paystub lines.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !math.valid ||
              !depositTxnId ||
              employer.trim().length === 0 ||
              !payDate ||
              (editing !== null && reason.trim().length === 0)
            }
            onClick={() => {
              void save();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {editing ? 'Save correction' : 'Record paycheck'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
