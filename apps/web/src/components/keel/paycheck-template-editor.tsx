'use client';

// Paycheck split-template editor + three-state autonomy toggle.
// Slice C of docs/harness/plans/paycheck-split-templates-v2.md §4.
//
// Laws honoured here:
//  - Law 2 (suggest→approve / explicit grant): authoring a template is an
//    explicit, immutable versioned write; the autonomy toggle is a policy grant
//    the OWNER confirms in plain language before it takes effect. Nothing is
//    auto-applied from this file — it only sets policy + the active template.
//  - Law 4 (money = BIGINT minor units, enums over strings, no floats): every
//    amount is a canonical minor-unit string; percents are integer bps
//    (0 < bps < 10000); the live preview uses the exact-bigint port in
//    lib/paycheck-template-math (the SERVER re-validates on save).
//  - Law 8 (desktop-first, usable at 390px; red = negative money ONLY; status
//    adjacent to the number): rows stack on narrow screens; validation and the
//    autonomy control are calm text/segments, never red/green; red is reserved
//    for the <Money> component's own negative styling.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, ChevronRight, History, Info } from 'lucide-react';
import { toast } from 'sonner';

import {
  fetchPaycheckTemplates,
  savePaycheckTemplate,
  setPaycheckSeriesSettings,
  fetchCategories,
  fetchAccounts,
  fetchEntities,
  createManualAccount,
  // NOTE: keel-api.ts currently declares the template read-model types twice —
  // the Slice-B pair (PaycheckTemplate / PaycheckSeriesSettings, role typed as a
  // plain string) and the Slice-C `…Dto` pair (role typed as the exact union).
  // `fetchPaycheckTemplates` resolves to the Slice-B return shape, so this
  // component consumes `PaycheckTemplate` / `PaycheckSeriesSettings` (structurally
  // a superset of the Dto — role is just wider) and narrows role at the row
  // level. The SavePaycheckTemplateLine wire type is unambiguous and used as-is.
  type PaycheckTemplate,
  type PaycheckTemplateLine,
  type SavePaycheckTemplateLine,
  type CategoryRow,
  type AccountRow,
  type EntityRow,
} from '@/lib/keel-api';
import {
  previewPaycheckTemplate,
  type PreviewLine,
  type PreviewRejection,
} from '@/lib/paycheck-template-math';
import { Money } from '@/components/keel/money';
import { parseSignedDollars, minorToDollars } from '@/lib/hash';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// ---------------------------------------------------------------------------
// Role / kind vocabulary. Kinds are constrained to their role (§4.1) — enums
// over strings (Law 4). `earning` and `net_deposit` are the two structural
// remainder markers and are never user-removable.
// ---------------------------------------------------------------------------

type LineRole = SavePaycheckTemplateLine['role'];
type LineAmountKind = SavePaycheckTemplateLine['amountKind'];

const ROLE_LABELS: Record<LineRole, string> = {
  earning: 'Earning',
  tax: 'Tax',
  pretax_transfer: 'Pre-tax transfer',
  posttax_deduction: 'Post-tax deduction',
  net_deposit: 'Take-home (deposit)',
};

const KINDS_BY_ROLE: Record<LineRole, string[]> = {
  earning: ['gross_salary', 'bonus', 'commission'],
  tax: [
    'federal_withholding',
    'state_withholding',
    'local_withholding',
    'fica_withholding',
    'rsu_withholding',
  ],
  pretax_transfer: ['retirement_401k', 'employer_match', 'hsa', 'fsa', 'espp'],
  posttax_deduction: ['benefit', 'garnishment'],
  net_deposit: ['direct_deposit'],
};

const KIND_LABELS: Record<string, string> = {
  gross_salary: 'Salary / wages',
  bonus: 'Bonus',
  commission: 'Commission',
  federal_withholding: 'Federal tax',
  state_withholding: 'State tax',
  local_withholding: 'Local tax',
  fica_withholding: 'Social Security / Medicare',
  rsu_withholding: 'RSU withholding',
  retirement_401k: '401(k)',
  employer_match: 'Employer match',
  hsa: 'HSA',
  fsa: 'FSA',
  espp: 'ESPP',
  benefit: 'Benefit',
  garnishment: 'Garnishment',
  direct_deposit: 'Direct deposit',
};

/** Roles that reference an expense category (the deduction lands there). */
const CATEGORY_ROLES: ReadonlySet<LineRole> = new Set<LineRole>([
  'tax',
  'posttax_deduction',
]);
/** Roles that move money into a manual asset account. */
const DESTINATION_ROLES: ReadonlySet<LineRole> = new Set<LineRole>([
  'pretax_transfer',
]);

// The two amountKinds a deduction line may take. Earning + net_deposit are
// always `remainder` (the derive-me markers).
const DEDUCTION_AMOUNT_KINDS: LineAmountKind[] = ['fixed_minor', 'percent_of_gross_bps'];

// ---------------------------------------------------------------------------
// Editor line model. Kept as a UI draft (amounts as dollar/percent strings the
// user typed); serialised to SavePaycheckTemplateLine only at save time.
// ---------------------------------------------------------------------------

type EditorLine = {
  lineKey: string;
  role: LineRole;
  kind: string;
  amountKind: LineAmountKind;
  /** Dollars string when amountKind === 'fixed_minor' (e.g. "150.00"). */
  dollars: string;
  /** Percent string when amountKind === 'percent_of_gross_bps' (e.g. "6.00"). */
  percent: string;
  categoryLedgerAccountId: string | null;
  destinationAccountId: string | null;
};

let keyCounter = 0;
function newLineKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}_${String(Date.now())}_${String(keyCounter)}`;
}

function starterLines(): EditorLine[] {
  return [
    {
      lineKey: newLineKey('earning'),
      role: 'earning',
      kind: 'gross_salary',
      amountKind: 'remainder',
      dollars: '',
      percent: '',
      categoryLedgerAccountId: null,
      destinationAccountId: null,
    },
    {
      lineKey: newLineKey('net'),
      role: 'net_deposit',
      kind: 'direct_deposit',
      amountKind: 'remainder',
      dollars: '',
      percent: '',
      categoryLedgerAccountId: null,
      destinationAccountId: null,
    },
  ];
}

/** Seed the editor from an existing active template's lines (§4.1). */
function linesFromTemplate(tpl: PaycheckTemplate): EditorLine[] {
  return [...tpl.lines]
    .sort((a, b) => a.position - b.position)
    .map((l: PaycheckTemplateLine) => ({
      lineKey: l.lineKey || newLineKey(l.role),
      role: l.role as LineRole,
      kind: l.kind,
      amountKind: l.amountKind as LineAmountKind,
      dollars:
        l.amountKind === 'fixed_minor' && l.amountMinor
          ? minorToDollars(l.amountMinor)
          : '',
      percent:
        l.amountKind === 'percent_of_gross_bps' && l.bps !== null
          ? (l.bps / 100).toFixed(2)
          : '',
      categoryLedgerAccountId: l.categoryLedgerAccountId,
      destinationAccountId: l.destinationAccountId,
    }));
}

/** User percent string ("6" / "6.5" / "6.00") → integer bps, or null if unparseable. */
function percentToBps(percent: string): number | null {
  const cleaned = percent.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  return Number.isInteger(bps) ? bps : null;
}

/** Build the PreviewLine[] the math port consumes from the editor draft. */
function toPreviewLines(lines: EditorLine[]): PreviewLine[] {
  return lines.map((l): PreviewLine => {
    const base = { lineKey: l.lineKey, role: l.role, kind: l.kind };
    if (l.amountKind === 'fixed_minor') {
      const minor = parseSignedDollars(l.dollars);
      // Omit amountMinor entirely when unparseable (exactOptionalPropertyTypes:
      // the math port treats a missing amount as an invalid_line rejection).
      return minor && !minor.startsWith('-')
        ? { ...base, amountKind: 'fixed_minor', amountMinor: minor }
        : { ...base, amountKind: 'fixed_minor' };
    }
    if (l.amountKind === 'percent_of_gross_bps') {
      const bps = percentToBps(l.percent);
      return bps !== null
        ? { ...base, amountKind: 'percent_of_gross_bps', bps }
        : { ...base, amountKind: 'percent_of_gross_bps' };
    }
    return { ...base, amountKind: 'remainder' };
  });
}

/** Friendly, calm copy for a preview rejection (§4.1 — never red for text). */
function rejectionMessage(rej: PreviewRejection): string {
  switch (rej.code) {
    case 'aggregate_percent_out_of_range':
      return 'Your percentage lines add up to 100% or more — leave room for take-home.';
    case 'no_remainder_line':
      return 'Add a take-home (direct deposit) line.';
    case 'multiple_remainder_lines':
      return 'Only one take-home (direct deposit) line is allowed.';
    case 'no_earning_line':
      return 'Add an earning line so KEEL can derive gross pay.';
    case 'multiple_earning_lines':
      return 'Only one earning line is allowed.';
    case 'earning_must_be_remainder':
      return 'The earning line represents gross pay and is derived automatically.';
    case 'reimbursement_exceeds_seed':
      return 'Reimbursements are larger than the deposit — check the amounts.';
    case 'invalid_line':
      return 'One of your lines is missing an amount or percentage.';
    case 'bigint_overflow':
      return 'Those amounts are too large to compute.';
    case 'does_not_reconcile':
    default:
      return "Enter a preview deposit and complete each line to see the gross-to-net breakdown.";
  }
}

// ===========================================================================
// Category / account combobox (cmdk in a Popover), following
// add-budget-category-picker.tsx. Entity-scoped options are pre-filtered by the
// caller; this just renders + selects.
// ===========================================================================

function ComboPicker({
  value,
  options,
  placeholder,
  emptyText,
  disabled,
  onSelect,
}: {
  value: string | null;
  options: { id: string; label: string }[];
  placeholder: string;
  emptyText: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={selected ? 'truncate' : 'truncate text-muted-foreground'}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={o.label}
                  onSelect={() => {
                    onSelect(o.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ===========================================================================
// PaycheckTemplateEditor
// ===========================================================================

export function PaycheckTemplateEditor({
  open,
  onOpenChange,
  householdId,
  userId,
  seriesId,
  employerId,
  employerName,
  latestDepositMinor,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  householdId: string;
  userId: string;
  seriesId: string;
  employerId: string | null;
  employerName: string;
  latestDepositMinor?: string | null;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<EditorLine[]>(() => starterLines());
  const [bookingEnabled, setBookingEnabled] = useState(false);
  const [templates, setTemplates] = useState<PaycheckTemplate[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Manual "preview against this deposit" input (dollars) — used when there is
  // no observed latest deposit to anchor the live preview.
  const [previewDollars, setPreviewDollars] = useState('');
  const [creatingAccount, setCreatingAccount] = useState(false);

  const reloadAccounts = useCallback(async () => {
    const rows = await fetchAccounts(householdId);
    setAccounts(rows);
    return rows;
  }, [householdId]);

  // Load templates + settings + pickers when the dialog opens. The dialog is
  // mounted only while open (the parent unmounts it on close), so a late
  // resolution after close can't set state on an unmounted tree.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void (async () => {
      try {
        const [tpls, cats, accts, ents] = await Promise.all([
          fetchPaycheckTemplates(householdId),
          fetchCategories(householdId),
          fetchAccounts(householdId),
          fetchEntities(householdId),
        ]);
        setTemplates(tpls.templates);
        setCategories(cats);
        setAccounts(accts);
        setEntities(ents);

        const settings = tpls.seriesSettings.find((s) => s.seriesId === seriesId);
        setBookingEnabled(settings?.bookingEnabled ?? false);
        const active = settings?.activeTemplateId
          ? tpls.templates.find((t) => t.templateId === settings.activeTemplateId)
          : undefined;
        setLines(active ? linesFromTemplate(active) : starterLines());
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load templates.');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, householdId, seriesId]);

  // Entity scoping (§4.1): once ANY scoped line (category or destination) has
  // picked an entity, every other scoped line must stay in that entity. Derive
  // the locked entity from the first chosen category/account.
  const scopedEntityId = useMemo(() => {
    for (const l of lines) {
      if (CATEGORY_ROLES.has(l.role) && l.categoryLedgerAccountId) {
        const c = categories.find((x) => x.ledgerAccountId === l.categoryLedgerAccountId);
        if (c) return c.entityId;
      }
      if (DESTINATION_ROLES.has(l.role) && l.destinationAccountId) {
        const a = accounts.find((x) => x.id === l.destinationAccountId);
        if (a) return a.entityId;
      }
    }
    return null;
  }, [lines, categories, accounts]);

  // Whether identical category/account names need an entity suffix to
  // disambiguate (only when more than one entity is represented).
  const multiEntity = entities.length > 1;

  const expenseCategoryOptions = useMemo(() => {
    return categories
      .filter((c) => c.kind === 'expense')
      .filter((c) => scopedEntityId === null || c.entityId === scopedEntityId)
      .map((c) => ({
        id: c.ledgerAccountId,
        label: multiEntity && c.entityName ? `${c.name} · ${c.entityName}` : c.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [categories, scopedEntityId, multiEntity]);

  // Manual ASSET accounts (§4.1): a manual account has NO connection
  // (connectionId === null; fetchAccounts maps accounts.connection_id, which is
  // null exactly for manually-created accounts). Asset accounts are created via
  // createManualAccount({ kind: 'asset' }); the AccountRow shape doesn't expose
  // ledger kind directly, so we approximate "asset" by (a) it being manual and
  // (b) the entity-scoped list — retirement/HSA placeholders live here. The
  // server re-validates the destination is a manual asset on save (§D3), so an
  // over-broad option is rejected there rather than silently mis-booked.
  const manualAssetAccounts = useMemo(
    () => accounts.filter((a) => a.connectionId === null && a.archivedAt == null),
    [accounts],
  );

  const destinationOptions = useMemo(() => {
    return manualAssetAccounts
      .filter((a) => scopedEntityId === null || a.entityId === scopedEntityId)
      .map((a) => {
        const ent = entities.find((e) => e.entityId === a.entityId);
        return {
          id: a.id,
          label: multiEntity && ent ? `${a.name} · ${ent.name}` : a.name,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [manualAssetAccounts, scopedEntityId, multiEntity, entities]);

  // ---- Live preview -------------------------------------------------------
  // Observed net N: manual preview input if present, else the latest deposit.
  const previewNetMinor = useMemo(() => {
    const typed = previewDollars.trim();
    if (typed.length > 0) {
      const minor = parseSignedDollars(typed);
      return minor && !minor.startsWith('-') ? minor : null;
    }
    if (latestDepositMinor && !latestDepositMinor.startsWith('-')) return latestDepositMinor;
    return null;
  }, [previewDollars, latestDepositMinor]);

  const preview = useMemo(() => {
    if (previewNetMinor === null) return null;
    return previewPaycheckTemplate(toPreviewLines(lines), previewNetMinor);
  }, [lines, previewNetMinor]);

  // ---- Inline validation (mirror the server) ------------------------------
  const runningBps = useMemo(() => {
    let total = 0;
    for (const l of lines) {
      if (l.amountKind === 'percent_of_gross_bps') {
        const bps = percentToBps(l.percent);
        if (bps !== null) total += bps;
      }
    }
    return total;
  }, [lines]);

  const earningCount = lines.filter((l) => l.role === 'earning').length;
  const remainderNetCount = lines.filter(
    (l) => l.role === 'net_deposit' && l.amountKind === 'remainder',
  ).length;

  const validationError = useMemo((): string | null => {
    if (earningCount !== 1) return 'Add exactly one earning line.';
    if (remainderNetCount !== 1) return 'Add exactly one take-home (direct deposit) line.';
    if (runningBps >= 10000) {
      return 'Percentage lines sum to 100% or more (ΣP < 10000 required).';
    }
    for (const l of lines) {
      if (l.amountKind === 'fixed_minor') {
        const minor = parseSignedDollars(l.dollars);
        if (!minor || minor.startsWith('-') || minor === '0') {
          return 'Enter a positive amount on every fixed-dollar line.';
        }
      }
      if (l.amountKind === 'percent_of_gross_bps') {
        const bps = percentToBps(l.percent);
        if (bps === null || bps <= 0 || bps >= 10000) {
          return 'Enter a percentage between 0% and 100% on every percent line.';
        }
      }
      if (CATEGORY_ROLES.has(l.role) && !l.categoryLedgerAccountId) {
        return 'Pick a category for every tax and post-tax line.';
      }
      if (DESTINATION_ROLES.has(l.role) && !l.destinationAccountId) {
        return 'Pick a destination account for every pre-tax transfer line.';
      }
    }
    return null;
  }, [lines, earningCount, remainderNetCount, runningBps]);

  const canSave = employerId !== null && validationError === null && !saving && !loading;

  // ---- Line mutation helpers ---------------------------------------------
  function patchLine(lineKey: string, patch: Partial<EditorLine>) {
    setLines((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  }

  function changeRole(lineKey: string, role: LineRole) {
    setLines((prev) =>
      prev.map((l) => {
        if (l.lineKey !== lineKey) return l;
        const kinds = KINDS_BY_ROLE[role];
        const kind = kinds.includes(l.kind) ? l.kind : (kinds[0] ?? l.kind);
        // earning + net_deposit are always remainder; deductions default to fixed.
        const amountKind: LineAmountKind =
          role === 'earning' || role === 'net_deposit' ? 'remainder' : 'fixed_minor';
        return {
          ...l,
          role,
          kind,
          amountKind,
          categoryLedgerAccountId: CATEGORY_ROLES.has(role) ? l.categoryLedgerAccountId : null,
          destinationAccountId: DESTINATION_ROLES.has(role) ? l.destinationAccountId : null,
        };
      }),
    );
  }

  function addLine() {
    const nl: EditorLine = {
      lineKey: newLineKey('tax'),
      role: 'tax',
      kind: KINDS_BY_ROLE.tax[0] ?? 'federal_withholding',
      amountKind: 'fixed_minor',
      dollars: '',
      percent: '',
      categoryLedgerAccountId: null,
      destinationAccountId: null,
    };
    // Insert before the trailing net_deposit line so it reads top-to-bottom.
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.role === 'net_deposit');
      if (idx === -1) return [...prev, nl];
      return [...prev.slice(0, idx), nl, ...prev.slice(idx)];
    });
  }

  function removeLine(lineKey: string) {
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
  }

  async function handleCreatePlaceholder(lineKey: string) {
    if (creatingAccount) return;
    const entityId = scopedEntityId ?? entities[0]?.entityId ?? null;
    if (!entityId) {
      toast.error('No entity available to create the account.');
      return;
    }
    setCreatingAccount(true);
    try {
      await createManualAccount({
        householdId,
        entityId,
        userId,
        name: 'Retirement (placeholder)',
        kind: 'asset',
        subtype: 'retirement',
      });
      const rows = await reloadAccounts();
      // Auto-select the newest manual asset in that entity for this line.
      const created = rows
        .filter((a) => a.connectionId === null && a.entityId === entityId)
        .sort((a, b) => a.name.localeCompare(b.name));
      const pick = created.find((a) => a.name === 'Retirement (placeholder)') ?? created[0];
      if (pick) patchLine(lineKey, { destinationAccountId: pick.id });
      toast.success('Created a retirement placeholder account.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the account.');
    } finally {
      setCreatingAccount(false);
    }
  }

  // ---- Save ---------------------------------------------------------------
  async function handleSave() {
    if (employerId === null || validationError !== null) return;
    setSaving(true);
    try {
      const payloadLines: SavePaycheckTemplateLine[] = lines.map((l, i) => {
        const base: SavePaycheckTemplateLine = {
          lineKey: l.lineKey,
          kind: l.kind,
          role: l.role,
          amountKind: l.amountKind,
          position: i,
        };
        if (l.amountKind === 'fixed_minor') {
          base.amountMinor = parseSignedDollars(l.dollars) ?? '0';
        }
        if (l.amountKind === 'percent_of_gross_bps') {
          const bps = percentToBps(l.percent);
          if (bps !== null) base.bps = bps;
        }
        if (CATEGORY_ROLES.has(l.role) && l.categoryLedgerAccountId) {
          base.categoryLedgerAccountId = l.categoryLedgerAccountId;
        }
        if (DESTINATION_ROLES.has(l.role) && l.destinationAccountId) {
          base.destinationAccountId = l.destinationAccountId;
        }
        return base;
      });

      const result = await savePaycheckTemplate({
        householdId,
        userId,
        seriesId,
        employerId,
        bookingEnabled,
        lines: payloadLines,
      });
      // Surface the new immutable version number when the server returns it.
      const effects = result.effects as { templateVersion?: number } | undefined;
      const v = effects?.templateVersion;
      toast.success(v ? `Saved template v${String(v)}` : 'Saved template');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the template.');
    } finally {
      setSaving(false);
    }
  }

  // ---- Version history (read-only) ---------------------------------------
  const versionHistory = useMemo(() => {
    if (employerId === null) return [];
    return templates
      .filter((t) => t.employerId === employerId)
      .sort((a, b) => b.templateVersion - a.templateVersion);
  }, [templates, employerId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Split template — {employerName}</DialogTitle>
          <DialogDescription>
            Describe how each {employerName} paycheck breaks down from gross pay to
            take-home. KEEL derives the gross that reconciles to the deposit — you never
            do the arithmetic.
          </DialogDescription>
        </DialogHeader>

        {employerId === null ? (
          <div className="rounded-md border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
            Record a paycheck for this employer first to author a split template.
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading template…
          </div>
        ) : (
          <div className="space-y-4">
            {/* ---- Line rows ---- */}
            <div className="space-y-2">
              <Label>Paystub lines</Label>
              <div className="space-y-2">
                {lines.map((l) => {
                  const structural = l.role === 'earning' || l.role === 'net_deposit';
                  const kinds = KINDS_BY_ROLE[l.role];
                  return (
                    <div
                      key={l.lineKey}
                      className="rounded-lg border border-border px-3 py-2.5"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        {/* Role */}
                        <Select
                          value={l.role}
                          onValueChange={(v) => {
                            if (v) changeRole(l.lineKey, v);
                          }}
                        >
                          <SelectTrigger className="w-full sm:w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(ROLE_LABELS) as LineRole[]).map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {/* Kind */}
                        <Select
                          value={l.kind}
                          onValueChange={(v) => {
                            if (v) patchLine(l.lineKey, { kind: v });
                          }}
                        >
                          <SelectTrigger className="w-full sm:flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {kinds.map((k) => (
                              <SelectItem key={k} value={k}>
                                {KIND_LABELS[k] ?? k}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {!structural ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove line"
                            className="hidden shrink-0 sm:inline-flex"
                            onClick={() => {
                              removeLine(l.lineKey);
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </div>

                      {/* Amount controls (only for deduction lines) */}
                      {structural ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {l.role === 'earning'
                            ? 'Gross pay — derived from the deposit and the lines below.'
                            : 'Take-home — the remainder deposited to your account.'}
                        </p>
                      ) : (
                        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Select
                            value={l.amountKind}
                            onValueChange={(v) => {
                              if (v) patchLine(l.lineKey, { amountKind: v });
                            }}
                          >
                            <SelectTrigger className="w-full sm:w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DEDUCTION_AMOUNT_KINDS.map((ak) => (
                                <SelectItem key={ak} value={ak}>
                                  {ak === 'fixed_minor' ? 'Fixed $' : 'Percent of gross %'}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          {l.amountKind === 'fixed_minor' ? (
                            <Input
                              className="w-full sm:w-32"
                              inputMode="decimal"
                              placeholder="0.00"
                              aria-label="Fixed amount in dollars"
                              value={l.dollars}
                              onChange={(e) => {
                                patchLine(l.lineKey, { dollars: e.target.value });
                              }}
                            />
                          ) : (
                            <Input
                              className="w-full sm:w-28"
                              inputMode="decimal"
                              placeholder="0.00%"
                              aria-label="Percent of gross"
                              value={l.percent}
                              onChange={(e) => {
                                patchLine(l.lineKey, { percent: e.target.value });
                              }}
                            />
                          )}

                          {/* Category picker (tax / post-tax) */}
                          {CATEGORY_ROLES.has(l.role) ? (
                            <div className="w-full sm:flex-1">
                              <ComboPicker
                                value={l.categoryLedgerAccountId}
                                options={expenseCategoryOptions}
                                placeholder="Category…"
                                emptyText="No expense categories."
                                onSelect={(id) => {
                                  patchLine(l.lineKey, { categoryLedgerAccountId: id });
                                }}
                              />
                            </div>
                          ) : null}

                          {/* Destination picker (pre-tax transfer) */}
                          {DESTINATION_ROLES.has(l.role) ? (
                            <div className="flex w-full flex-col gap-1 sm:flex-1">
                              <ComboPicker
                                value={l.destinationAccountId}
                                options={destinationOptions}
                                placeholder="Destination account…"
                                emptyText="No manual asset accounts."
                                onSelect={(id) => {
                                  patchLine(l.lineKey, { destinationAccountId: id });
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto justify-start px-1 py-0.5 text-xs text-muted-foreground"
                                disabled={creatingAccount}
                                onClick={() => {
                                  void handleCreatePlaceholder(l.lineKey);
                                }}
                              >
                                {creatingAccount ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Plus className="size-3" />
                                )}
                                Create retirement placeholder account
                              </Button>
                            </div>
                          ) : null}

                          {/* Narrow-screen remove button */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-muted-foreground sm:hidden"
                            onClick={() => {
                              removeLine(l.lineKey);
                            }}
                          >
                            <Trash2 className="size-4" />
                            Remove line
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button variant="outline" size="sm" onClick={addLine}>
                  <Plus className="size-4" />
                  Add line
                </Button>
                <span className="text-xs text-muted-foreground">
                  ΣP {(runningBps / 100).toFixed(2)}% of 100%
                </span>
              </div>
            </div>

            {/* ---- Live preview ---- */}
            <div className="space-y-2 rounded-lg border border-border bg-secondary/30 px-3 py-3">
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Live preview
                </Label>
                {!latestDepositMinor ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Preview against deposit</span>
                    <Input
                      className="h-7 w-28"
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label="Preview deposit amount"
                      value={previewDollars}
                      onChange={(e) => {
                        setPreviewDollars(e.target.value);
                      }}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Against latest deposit{' '}
                    <Money amountMinor={latestDepositMinor} className="text-xs" />
                  </span>
                )}
              </div>

              {preview === null ? (
                <p className="text-sm text-muted-foreground">
                  Enter a deposit amount to preview the gross-to-net breakdown.
                </p>
              ) : preview.ok ? (
                <div className="space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Gross</span>
                    <Money amountMinor={preview.grossMinor} />
                  </div>
                  {preview.lines
                    .filter((pl) => pl.role !== 'earning' && pl.role !== 'net_deposit')
                    .map((pl) => (
                      <div key={pl.lineKey} className="flex items-center justify-between">
                        <span className="text-muted-foreground">
                          {KIND_LABELS[pl.kind] ?? pl.kind}
                        </span>
                        <Money amountMinor={pl.amountMinor} />
                      </div>
                    ))}
                  <div className="flex items-center justify-between border-t border-border pt-1 font-medium">
                    <span>Take-home</span>
                    <Money amountMinor={preview.netMinor} />
                  </div>
                </div>
              ) : (
                <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {rejectionMessage(preview.rejection)}
                </p>
              )}
            </div>

            {/* ---- Booking + validation ---- */}
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-border accent-foreground"
                checked={bookingEnabled}
                onChange={(e) => {
                  setBookingEnabled(e.target.checked);
                }}
              />
              <span>
                Record this paycheck in the ledger when applied.
                <span className="block text-xs text-muted-foreground">
                  When off, KEEL computes the split but doesn&apos;t post it.
                </span>
              </span>
            </label>

            {validationError !== null ? (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                {validationError}
              </p>
            ) : null}

            {/* ---- Version history ---- */}
            {versionHistory.length > 0 ? (
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-secondary/40"
                  onClick={() => {
                    setShowHistory((s) => !s);
                  }}
                >
                  <ChevronRight
                    className={`size-4 shrink-0 transition-transform ${showHistory ? 'rotate-90' : ''}`}
                  />
                  <History className="size-4 shrink-0" />
                  Version history ({versionHistory.length})
                </button>
                {showHistory ? (
                  <div className="space-y-1 border-t border-border px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      Immutable — a change saves a new version.
                    </p>
                    {versionHistory.map((t) => (
                      <div
                        key={t.templateId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="font-medium">v{t.templateVersion}</span>
                        <span className="text-xs text-muted-foreground">
                          {t.lines.length} line{t.lines.length === 1 ? '' : 's'} ·{' '}
                          {t.createdAt.slice(0, 10)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              void handleSave();
            }}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// PaycheckAutonomyToggle
// ===========================================================================

type AutonomyState = 'off' | 'suggest' | 'auto_with_log';

const AUTONOMY_SEGMENTS: { value: AutonomyState; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'suggest', label: 'Suggest' },
  { value: 'auto_with_log', label: 'Auto-apply' },
];

function autonomyGrantCopy(state: AutonomyState, employerName: string): string {
  switch (state) {
    case 'off':
      return `KEEL will not suggest or apply splits for ${employerName}.`;
    case 'suggest':
      return `KEEL will suggest a split for each ${employerName} paycheck. You approve each one before anything is recorded.`;
    case 'auto_with_log':
      return `KEEL will automatically apply your active template to each ${employerName} paycheck as it arrives, and record it. Every application is logged and can be undone. Requires an active template.`;
  }
}

export function PaycheckAutonomyToggle({
  householdId,
  userId,
  seriesId,
  employerId,
  employerName,
  activeTemplateId,
  bookingEnabled,
  incomeCategoryLedgerAccountId,
  autonomy,
  onChanged,
}: {
  householdId: string;
  userId: string;
  seriesId: string;
  employerId: string;
  employerName: string;
  activeTemplateId: string | null;
  bookingEnabled: boolean;
  incomeCategoryLedgerAccountId: string | null;
  autonomy: AutonomyState;
  onChanged: () => void;
}) {
  // Pending selection awaiting confirmation (null = no dialog open).
  const [pending, setPending] = useState<AutonomyState | null>(null);
  const [saving, setSaving] = useState(false);
  // Income category = the gross-pay anchor the server booking requires
  // (keel_paycheck_apply_payload raises without it). There was no UI to set it,
  // so it stayed null and silently disabled "Apply template to deposit". Owners
  // pick it here, alongside the autonomy grant that turns booking on.
  const [incomeCats, setIncomeCats] = useState<CategoryRow[]>([]);
  const [selectedIncomeCat, setSelectedIncomeCat] = useState<string | null>(
    incomeCategoryLedgerAccountId,
  );
  const [catsLoading, setCatsLoading] = useState(false);

  const autoDisabled = activeTemplateId === null;
  // Only booking states (Suggest / Auto-apply) need the anchor; Off never books.
  const needsIncomeCat = pending !== null && pending !== 'off';

  // Load income categories + seed the current selection when the confirm dialog
  // opens for a booking state (not needed just to turn automation off).
  useEffect(() => {
    if (!needsIncomeCat) return;
    setSelectedIncomeCat(incomeCategoryLedgerAccountId);
    if (incomeCats.length > 0 || catsLoading) return;
    setCatsLoading(true);
    void (async () => {
      try {
        const rows = await fetchCategories(householdId);
        setIncomeCats(rows.filter((c) => c.kind === 'income'));
      } catch {
        toast.error('Could not load income categories.');
      } finally {
        setCatsLoading(false);
      }
    })();
  }, [needsIncomeCat, householdId, incomeCategoryLedgerAccountId, incomeCats.length, catsLoading]);

  async function confirm() {
    if (pending === null) return;
    // Booking states need the income anchor or the server apply rejects (§D4).
    if (needsIncomeCat && !selectedIncomeCat) {
      toast.error('Pick the income category KEEL should record the gross pay under.');
      return;
    }
    setSaving(true);
    try {
      await setPaycheckSeriesSettings({
        householdId,
        userId,
        seriesId,
        employerId,
        activeTemplateId,
        bookingEnabled,
        // Off preserves whatever anchor was set; booking states use the picked one.
        incomeCategoryLedgerAccountId:
          pending === 'off' ? incomeCategoryLedgerAccountId : selectedIncomeCat,
        autonomy: pending,
      });
      toast.success(
        pending === 'off'
          ? 'Autonomy turned off.'
          : pending === 'suggest'
            ? 'KEEL will suggest splits for approval.'
            : 'Auto-apply enabled (every application is logged and undoable).',
      );
      setPending(null);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/not_authorized/i.test(msg)) {
        toast.error('Only the household owner can change autonomy.');
      } else {
        toast.error(msg || 'Could not change autonomy.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {/* Provenance/policy control — deliberately calm (never red/green). */}
      <div className="inline-flex rounded-lg border border-border bg-secondary/30 p-0.5">
        {AUTONOMY_SEGMENTS.map((seg) => {
          const selected = autonomy === seg.value;
          const disabled = seg.value === 'auto_with_log' && autoDisabled;
          return (
            <button
              key={seg.value}
              type="button"
              disabled={disabled || saving}
              aria-pressed={selected}
              className={[
                'rounded-md px-3 py-1 text-sm transition-colors',
                selected
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
                disabled ? 'cursor-not-allowed opacity-50' : '',
              ].join(' ')}
              onClick={() => {
                if (!selected) setPending(seg.value);
              }}
            >
              {seg.label}
            </button>
          );
        })}
      </div>
      {autoDisabled ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Save a template first to enable auto-apply.
        </p>
      ) : null}

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending === 'off'
                ? 'Turn off automation'
                : pending === 'suggest'
                  ? 'Suggest splits'
                  : 'Auto-apply splits'}
            </DialogTitle>
            <DialogDescription>
              {pending !== null ? autonomyGrantCopy(pending, employerName) : ''}
            </DialogDescription>
          </DialogHeader>
          {needsIncomeCat ? (
            <div className="space-y-1.5">
              <Label htmlFor="paycheck-income-cat">Record gross pay as</Label>
              <Select
                value={selectedIncomeCat ?? ''}
                onValueChange={(v) => {
                  setSelectedIncomeCat(v);
                }}
              >
                <SelectTrigger id="paycheck-income-cat">
                  <SelectValue
                    placeholder={catsLoading ? 'Loading…' : 'Pick an income category'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {incomeCats.map((c) => (
                    <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                      {c.name}
                      {c.entityName ? ` · ${c.entityName}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The gross-income anchor KEEL books each paycheck under. Taxes and any
                401(k)/HSA transfer come from the template.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={saving || (needsIncomeCat && !selectedIncomeCat)}
              onClick={() => {
                void confirm();
              }}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
