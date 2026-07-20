'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Plus, Loader2, ChevronRight, Pencil, Trash2, Undo2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchEntities,
  fetchRecurringClassification,
  fetchDetectedPaycheckDismissals,
  fetchPaycheckTemplates,
  dismissDetectedPaycheck,
  unapplyPaycheck,
  applyPaycheckTemplate,
  keelCommand,
  newId,
  type RecurringClassificationRow,
  type DetectedPaycheckDismissal,
  type RecurringSeriesRow,
  type RichTransactionRow,
  type PaycheckTemplatesResult,
} from '@/lib/keel-api';
import {
  PaycheckTemplateEditor,
  PaycheckAutonomyToggle,
} from '@/components/keel/paycheck-template-editor';
import {
  previewPaycheckTemplate,
  type PreviewLine,
} from '@/lib/paycheck-template-math';
import type { PaycheckTemplate } from '@/lib/keel-api';
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
  supersededByPaycheckId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  templateApplied: boolean;
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
/**
 * Kinds this v1 form can safely round-trip. A paycheck with a component
 * outside this set (retirement_401k/hsa/fsa/espp/employer_match -- only
 * reachable via a direct API/payroll-provider write, never this UI) can't
 * be edited here: save() only rebuilds a single direct_deposit match and
 * sums deductions from DEDUCTION_KINDS, so it would silently drop that
 * component's data and/or fail the backend's net-reconciliation check.
 */
const V1_EDITABLE_KINDS: readonly string[] = [...EARNING_KINDS, 'reimbursement', ...DEDUCTION_KINDS, 'direct_deposit'];
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

type PaycheckPrefill = {
  employer: string;
  netDollars: string;
  depositTxnId: string | null;
  /** Full gross→net breakdown (F-025 template), already scaled to the deposit. */
  components?: DraftComponent[];
};

/**
 * Per-employer paycheck template (F-025): the non-deposit component lines of an
 * employer's most recent active paycheck. Kept as minor-unit bigints so scaling
 * is exact integer arithmetic (no floats, no LLM — the existing math-checked
 * proc re-validates on save).
 */
type EmployerTemplate = {
  employer: string;
  netMinor: bigint;
  lines: { kind: string; amountMinor: bigint }[];
};

/**
 * Scale a template's lines so the resulting NET equals `targetNetMinor`, then
 * pin any rounding drift onto the largest earning line so the server equation
 * (gross = Σ earnings; net = gross + reimbursements − deductions = deposit)
 * reconciles exactly. Returns draft components (dollar strings) for the form, or
 * null when it can't produce a positive, reconciling breakdown.
 */
function scaleTemplate(
  tpl: EmployerTemplate,
  targetNetMinor: bigint,
): DraftComponent[] | null {
  if (tpl.netMinor <= 0n || targetNetMinor <= 0n) return null;
  const scaled = tpl.lines.map((l) => ({
    kind: l.kind,
    // round-half-up on a positive rational: (a*t + net/2) / net
    amountMinor:
      (l.amountMinor * targetNetMinor + tpl.netMinor / 2n) / tpl.netMinor,
  }));
  const earningKinds: readonly string[] = EARNING_KINDS;
  const deductionKinds: readonly string[] = DEDUCTION_KINDS;
  const sum = (kinds: readonly string[]): bigint =>
    scaled.filter((l) => kinds.includes(l.kind)).reduce((t, l) => t + l.amountMinor, 0n);
  const net = sum(earningKinds) + sum(['reimbursement']) - sum(deductionKinds);
  const delta = targetNetMinor - net;
  if (delta !== 0n) {
    // Pin drift onto the largest earning line (delta is a few cents at most).
    let idx = -1;
    for (let i = 0; i < scaled.length; i++) {
      const l = scaled[i];
      if (l && earningKinds.includes(l.kind) && (idx === -1 || l.amountMinor > (scaled[idx]?.amountMinor ?? 0n))) {
        idx = i;
      }
    }
    if (idx === -1) return null;
    const target = scaled[idx];
    if (target) target.amountMinor += delta;
  }
  if (scaled.some((l) => l.amountMinor <= 0n)) return null;
  return scaled.map((l) => ({ kind: l.kind, amount: minorToDollars(l.amountMinor.toString()) }));
}

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
  // Classification (paycheck vs plain income) + declined occurrences. The
  // "detected paychecks" section shows ONLY payroll (bucket==='paycheck'),
  // never all inflows — dividends/interest never appear here.
  const [classification, setClassification] = useState<RecurringClassificationRow[]>([]);
  const [dismissals, setDismissals] = useState<DetectedPaycheckDismissal[]>([]);
  // Paycheck split templates (SLICE C, paycheck-split-templates-v2.md §4): the
  // per-series template editor + autonomy grant. Templates are keyed by employer;
  // a detected series resolves its employer by matching its counterparty to a
  // known template's employer name, else (no template yet) employerId is null and
  // the editor prompts the user to record a paycheck first.
  const [templatesData, setTemplatesData] = useState<PaycheckTemplatesResult | null>(null);
  const [editorSeries, setEditorSeries] = useState<
    { seriesId: string; employerId: string | null; employerName: string; depositMinor: string | null } | null
  >(null);

  const reloadTemplates = useCallback(() => {
    if (!householdId) return;
    void fetchPaycheckTemplates(householdId)
      .then(setTemplatesData)
      .catch(() => {
        setTemplatesData(null);
      });
  }, [householdId]);

  const reloadDismissals = useCallback(() => {
    if (!householdId) return;
    void fetchDetectedPaycheckDismissals(householdId)
      .then(setDismissals)
      .catch(() => {
        setDismissals([]);
      });
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    void fetchEntities(householdId)
      .then((entities) => {
        setEntityId(entities[0]?.entityId ?? null);
      })
      .catch(() => {
        setEntityId(null);
      });
    void fetchRecurringClassification(householdId)
      .then(setClassification)
      .catch(() => {
        setClassification([]);
      });
    reloadDismissals();
    reloadTemplates();
  }, [householdId, reloadDismissals, reloadTemplates]);

  // Resolve a detected series' employer + its per-series settings from the
  // templates read model. Employer match is by name (the read model has no
  // series→employer link until a template exists); null employerId ⇒ the editor
  // prompts to record a paycheck first (which creates the employer).
  const seriesSettingsById = useMemo(
    () => new Map((templatesData?.seriesSettings ?? []).map((s) => [s.seriesId, s])),
    [templatesData],
  );
  const employerIdByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of templatesData?.templates ?? []) {
      m.set(t.employerName.trim().toLowerCase(), t.employerId);
    }
    return m;
  }, [templatesData]);

  const bucketBySeries = useMemo(
    () => new Map(classification.map((c) => [c.seriesId, c.bucket])),
    [classification],
  );
  // A dismissal is keyed by (employerKey = lower(trim(counterpartyKey)),
  // occurrenceDate). Build a set for O(1) exclusion of declined occurrences.
  const dismissedKeys = useMemo(
    () => new Set(dismissals.map((d) => `${d.employerKey}|${d.occurrenceDate}`)),
    [dismissals],
  );

  // Detected PAYCHECKS = recurring INFLOW series the deterministic classifier
  // marked 'paycheck' (payroll/wages only — dividends/interest are plain
  // 'income' and are NOT shown here). Recording stays explicit (suggest→approve).
  const detectedIncome = useMemo(
    () =>
      recurring.rows.filter(
        (r) =>
          r.sign === 'inflow' &&
          (r.status === 'confirmed' || r.status === 'suggested') &&
          bucketBySeries.get(r.seriesId) === 'paycheck',
      ),
    [recurring.rows, bucketBySeries],
  );

  // The occurrence each detected-paycheck card surfaces (next upcoming, else the
  // latest). Hide a card whose surfaced occurrence has been DECLINED — but keep
  // the series if it has a different, non-declined occurrence to offer.
  const detectedPaychecks = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    return detectedIncome.filter((series) => {
      const upcoming = series.occurrences
        .filter((o) => o.status === 'expected')
        .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
      const shown = upcoming.find((o) => o.expectedDate >= todayIso) ?? upcoming[0];
      if (!shown) return true; // no dated occurrence to decline; still show it
      const employerKey = series.counterpartyKey.trim().toLowerCase();
      return !dismissedKeys.has(`${employerKey}|${shown.expectedDate}`);
    });
  }, [detectedIncome, dismissedKeys]);

  // F-025: derive a per-employer template from that employer's most recent
  // ACTIVE paycheck (rows are pay_date-desc), keyed by lowercased name so a
  // detected series' counterparty can find it. Excludes the auto-derived
  // direct_deposit line — it's recomputed from the other lines.
  const templatesByEmployer = useMemo(() => {
    const map = new Map<string, EmployerTemplate>();
    for (const p of rows) {
      if (p.status !== 'active') continue;
      const key = p.employerName.trim().toLowerCase();
      if (map.has(key)) continue; // first = most recent (rows are pay_date desc)
      // Skip employers whose latest paycheck carries a kind the v1 form can't
      // handle: scaleTemplate + save() only rebuild EARNING/reimbursement/
      // DEDUCTION/direct_deposit lines, so any other kind (retirement_401k, hsa,
      // employer_match, …) would make keel_paycheck_create reject the prefilled
      // command. No template = no broken "usual breakdown" button.
      if (!p.components.every((c) => V1_EDITABLE_KINDS.includes(c.kind))) continue;
      const lines = p.components
        .filter((c) => c.kind !== 'direct_deposit')
        .map((c) => ({ kind: c.kind, amountMinor: BigInt(c.amountMinor) }));
      if (lines.length === 0) continue;
      map.set(key, { employer: p.employerName, netMinor: BigInt(p.netMinor), lines });
    }
    return map;
  }, [rows]);

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

      {detectedPaychecks.length > 0 ? (
        <section className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4" />
            Detected paychecks
          </h2>
          <div className="space-y-2">
            {detectedPaychecks.map((series) => {
              const todayIso = new Date().toISOString().slice(0, 10);
              const upcoming = series.occurrences
                .filter((o) => o.status === 'expected')
                .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
              const next = upcoming.find((o) => o.expectedDate >= todayIso);
              const amount = next ?? upcoming[0];
              const template = templatesByEmployer.get(series.counterpartyKey.trim().toLowerCase());
              // The occurrence this card surfaces. Declining hides THIS one; the
              // employer + latest detected deposit stay for the next paycheck.
              const occurrenceDate = amount?.expectedDate ?? null;
              const employerKey = series.counterpartyKey.trim().toLowerCase();
              const resolvedEmployerId = employerIdByName.get(employerKey) ?? null;
              const settings = seriesSettingsById.get(series.seriesId) ?? null;
              const seriesDepositMinor = amount?.expectedAmountMinor ?? null;
              return (
                <div
                  key={series.seriesId}
                  className="flex flex-col gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {template ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          const netMinor = amount?.expectedAmountMinor ?? '';
                          const match = txns.rows.find(
                            (t) => netMinor !== '' && t.amountMinor === netMinor,
                          );
                          // Scale the usual breakdown to this deposit; fall back
                          // to the template as-is if scaling can't reconcile.
                          const scaled =
                            netMinor !== ''
                              ? scaleTemplate(template, BigInt(netMinor))
                              : null;
                          const lines =
                            scaled ??
                            template.lines.map((l) => ({
                              kind: l.kind,
                              amount: minorToDollars(l.amountMinor.toString()),
                            }));
                          setPrefill({
                            employer: series.counterpartyKey,
                            netDollars: netMinor ? minorToDollars(netMinor) : '',
                            depositTxnId: match?.transactionId ?? null,
                            components: lines,
                          });
                          setCreating(true);
                        }}
                      >
                        Record with your usual breakdown
                      </Button>
                    ) : null}
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
                      {template ? 'Start blank' : 'Record this paycheck'}
                    </Button>
                    <DeclineDetectedButton
                      disabled={!householdId || !userId || occurrenceDate === null}
                      onDecline={async () => {
                        if (!householdId || !userId || occurrenceDate === null) return;
                        await dismissDetectedPaycheck({
                          householdId,
                          userId,
                          seriesId: series.seriesId,
                          occurrenceDate,
                        });
                        reloadDismissals();
                      }}
                    />
                  </div>
                  </div>

                  {/* Split template + autonomy grant (SLICE C, §4). The editor
                      authors an immutable template version; the toggle sets the
                      OWNER-only per-series autonomy. */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setEditorSeries({
                          seriesId: series.seriesId,
                          employerId: resolvedEmployerId,
                          employerName: series.counterpartyKey,
                          depositMinor: seriesDepositMinor,
                        });
                      }}
                    >
                      <Pencil className="size-3.5" />
                      {settings?.activeTemplateId ? 'Edit split template' : 'Set up split template'}
                    </Button>
                    {resolvedEmployerId && settings ? (
                      <PaycheckAutonomyToggle
                        householdId={householdId ?? ''}
                        userId={userId ?? ''}
                        seriesId={series.seriesId}
                        employerId={resolvedEmployerId}
                        employerName={series.counterpartyKey}
                        activeTemplateId={settings.activeTemplateId}
                        bookingEnabled={settings.bookingEnabled}
                        incomeCategoryLedgerAccountId={settings.incomeCategoryLedgerAccountId}
                        autonomy={settings.autonomy}
                        onChanged={reloadTemplates}
                      />
                    ) : null}
                    {settings?.activeTemplateId ? (
                      <ApplyTemplateButton
                        householdId={householdId}
                        userId={userId}
                        seriesId={series.seriesId}
                        serverTemplate={
                          (templatesData?.templates ?? []).find(
                            (t) => t.templateId === settings.activeTemplateId,
                          ) ?? null
                        }
                        hasIncomeCategory={settings.incomeCategoryLedgerAccountId !== null}
                        deposit={(() => {
                          const netMinor = amount?.expectedAmountMinor ?? '';
                          const match =
                            netMinor !== ''
                              ? txns.rows.find((t) => t.amountMinor === netMinor)
                              : undefined;
                          return match
                            ? {
                                depositTxnId: match.transactionId,
                                netMinor,
                                currency: amount?.currency ?? 'USD',
                              }
                            : null;
                        })()}
                        onApplied={() => {
                          reloadTemplates();
                          void refetch();
                        }}
                      />
                    ) : null}
                  </div>
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

      {editorSeries ? (
        <PaycheckTemplateEditor
          open
          onOpenChange={(o) => {
            if (!o) setEditorSeries(null);
          }}
          householdId={householdId ?? ''}
          userId={userId ?? ''}
          seriesId={editorSeries.seriesId}
          employerId={editorSeries.employerId}
          employerName={editorSeries.employerName}
          latestDepositMinor={editorSeries.depositMinor}
          onSaved={() => {
            reloadTemplates();
            setEditorSeries(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Decline a detected paycheck occurrence: hides it from this section while
 * KEEPING the employer + latest detected deposit as the prefill template (the
 * command persists a soft-state dismissal; it never mutes the series). Class-B
 * suggest→approve — the user is approving "not this one".
 */
function DeclineDetectedButton({
  disabled,
  onDecline,
}: {
  disabled: boolean;
  onDecline: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled || busy}
      onClick={() => {
        setBusy(true);
        void onDecline()
          .then(() => {
            toast.success("Hidden. We'll still prefill from the latest deposit next time.");
          })
          .catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Could not decline.');
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
      Decline
    </Button>
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
  // The v1 form always prefills/rebuilds a single deposit-1 match (see
  // save() below), so a paycheck with more than one direct_deposit
  // component (split across accounts -- only reachable via a direct
  // API/payroll-provider write) would have its extra deposit match
  // silently collapsed away on save. Require exactly one.
  const editable =
    p.components.every((c) => V1_EDITABLE_KINDS.includes(c.kind)) &&
    p.components.filter((c) => c.kind === 'direct_deposit').length === 1;

  // A template-applied paycheck's undo must go through paychecks.unapply (it also
  // reverses the set_splits booking); a plain paychecks.reverse is blocked by the
  // DB guard. Unapply needs no reason (the reversal is the whole action).
  const templateApplied = p.templateApplied && !reversed;

  async function transition() {
    if (!householdId || !userId) return;
    if (!templateApplied && reason.trim().length === 0) return;
    setBusy(true);
    try {
      if (templateApplied) {
        await unapplyPaycheck({ householdId, userId, paycheckId: p.paycheckId });
        toast.success('Template unapplied — booking reversed.');
      } else {
        await keelCommand({
          commandId: newId(),
          command: reversed ? 'paychecks.restore' : 'paychecks.reverse',
          economicEventKey: `paychecks.${reversed ? 'restore' : 'reverse'}:${p.paycheckId}:${newId()}`,
          actor: { kind: 'user', userId },
          householdId,
          payload: { paycheckId: p.paycheckId, reason: reason.trim() },
        });
        toast.success(reversed ? 'Paycheck restored.' : 'Paycheck reversed.');
      }
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
          {p.templateApplied && !reversed ? (
            <Badge variant="secondary" className="whitespace-nowrap">
              Booked{p.templateVersion ? ` · v${p.templateVersion.toString()}` : ''}
            </Badge>
          ) : (
            <Badge variant={reversed ? 'outline' : 'secondary'} className="capitalize">
              {p.status}
            </Badge>
          )}
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

          {templateApplied ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Booked to the ledger from a split template (gross income + taxes
                {p.components.some((c) => c.kind === 'retirement_401k') ? ' + 401(k) transfer' : ''}).
                Undo reverses the booking and this record.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void transition();
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
                Undo
              </Button>
            </div>
          ) : confirming ? (
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
          ) : reversed && p.supersededByPaycheckId ? (
            <p className="text-xs text-muted-foreground">
              Corrected — replaced by a newer entry. Restoring this one back would double-count
              the deposit, so it stays in history only.
            </p>
          ) : (
            <div className="flex gap-2">
              {/* Paychecks are immutable once recorded (correction is
                  reverse + recreate, not an in-place edit) -- so editing
                  only makes sense for an ACTIVE paycheck; a reversed one
                  has nothing to reverse-and-replace. Paychecks with
                  components outside the v1 form's supported kinds (only
                  reachable via direct API/payroll-provider writes) also
                  can't be edited here -- the form can't round-trip them. */}
              {reversed || !editable ? null : (
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
    // F-025: apply the scaled "usual breakdown" when the template button was used.
    if (prefill.components && prefill.components.length > 0) {
      setComponents(prefill.components);
    }
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

  const kindOptions = V1_EDITABLE_KINDS.filter((k) => k !== 'direct_deposit');

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

/**
 * SLICE D — "Apply template to deposit" (class B, token-bound). Shows a live
 * gross→net breakdown (the EXACT §D4 math via previewPaycheckTemplate, the same
 * algorithm the server computes) and, on confirm, runs the issue→apply two-step
 * (applyPaycheckTemplate): mint an approval token bound to the server-computed
 * split payload, then apply with the redeemed token — the server books it via
 * set_splits (Law 7). The client never sends the leg amounts.
 */
function ApplyTemplateButton({
  householdId,
  userId,
  seriesId,
  serverTemplate,
  hasIncomeCategory,
  deposit,
  onApplied,
}: {
  householdId: string | null;
  userId: string | null;
  seriesId: string;
  serverTemplate: PaycheckTemplate | null;
  hasIncomeCategory: boolean;
  deposit: { depositTxnId: string; netMinor: string; currency: string } | null;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Not applicable without a template, a matched deposit, or an income category.
  if (serverTemplate === null || deposit === null || !hasIncomeCategory) return null;

  const previewLines: PreviewLine[] = serverTemplate.lines.map((l) => ({
    lineKey: l.lineKey,
    role: l.role as PreviewLine['role'],
    kind: l.kind,
    amountKind: l.amountKind as PreviewLine['amountKind'],
    ...(l.amountMinor !== null ? { amountMinor: l.amountMinor } : {}),
    ...(l.bps !== null ? { bps: l.bps } : {}),
  }));
  const preview = previewPaycheckTemplate(previewLines, deposit.netMinor);

  async function apply() {
    if (!householdId || !userId || serverTemplate === null || deposit === null) return;
    setBusy(true);
    try {
      await applyPaycheckTemplate({
        householdId,
        userId,
        seriesId,
        depositTxnId: deposit.depositTxnId,
        templateId: serverTemplate.templateId,
        templateVersion: serverTemplate.templateVersion,
      });
      toast.success('Template applied — booked to the ledger.');
      setOpen(false);
      onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Apply failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setOpen(true); }}>
        <Banknote className="size-3.5" />
        Apply template to deposit
      </Button>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Apply split template</DialogTitle>
          <DialogDescription>
            Books this deposit as gross income, taxes, and any 401(k)/HSA transfer —
            one ledger line, undoable. Reviewed before it posts (Law 11).
          </DialogDescription>
        </DialogHeader>
        {preview.ok ? (
          <div className="space-y-1.5 rounded-lg border border-border px-3 py-2 text-sm">
            <div className="flex items-center justify-between font-medium">
              <span>Gross income</span>
              <Money amountMinor={preview.grossMinor} currency={deposit.currency} />
            </div>
            {preview.lines
              .filter((l) => l.role !== 'earning' && l.role !== 'net_deposit')
              .map((l) => (
                <div key={l.lineKey} className="flex items-center justify-between text-muted-foreground">
                  <span>{KIND_LABELS[l.kind] ?? l.kind}</span>
                  <span>
                    −<Money amountMinor={l.amountMinor} currency={deposit.currency} className="text-muted-foreground" />
                  </span>
                </div>
              ))}
            <div className="flex items-center justify-between border-t border-border/60 pt-1.5 font-medium">
              <span>Net deposit</span>
              <Money amountMinor={preview.netMinor} currency={deposit.currency} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-destructive">
            This template does not reconcile to the deposit amount. Edit the template first.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOpen(false); }} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => { void apply(); }} disabled={busy || !preview.ok}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Apply &amp; book
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
