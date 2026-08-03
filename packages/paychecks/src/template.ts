// Slice A of docs/harness/plans/paycheck-split-templates-v2.md — §D4 deterministic
// split-template math. Pure, exact BIGINT, no floats (Law 1, Law 4). The output
// components MUST reconcile through reconcilePaycheck (index.ts).
//
// This is the CORRECTED (v2) gross-up algorithm. The v1 bug was deriving gross by a
// single divide of the net and then rounding each percent line independently, which
// accumulated an off-by-one residue (Codex's −1 remainder). Here we SELECT the unique
// integer gross G and let the single remainder line absorb the residue exactly.

import {
  reconcilePaycheck,
  type PaycheckComponentInput,
  type PaycheckComponentKind,
  type PaycheckInput,
} from './index.js';

export const PAYCHECK_TEMPLATE_FORMULA_VERSION = 'paycheck-split-template-v2' as const;

const BPS_DENOMINATOR = 10_000n;
// int64 max — every intermediate BIGINT product/sum is guarded against exceeding this
// so the SQL parity implementation (bigint columns) can never silently wrap (§D4).
const INT64_MAX = 9_223_372_036_854_775_807n;

export type PaycheckLineRole =
  | 'earning'
  | 'tax'
  | 'pretax_transfer'
  | 'posttax_deduction'
  | 'net_deposit';

export type PaycheckAmountKind = 'fixed_minor' | 'percent_of_gross_bps' | 'remainder';

/**
 * A single ordered line of a paycheck split template. Wire-shaped: amounts are canonical
 * decimal strings (minor units), bps is an integer. Exactly one line across the template
 * MUST have amountKind 'remainder' (validated). The remainder line is the take-home
 * net_deposit that absorbs the residue.
 */
export interface PaycheckTemplateLine {
  readonly lineKey: string;
  readonly role: PaycheckLineRole;
  readonly kind: PaycheckComponentKind;
  readonly amountKind: PaycheckAmountKind;
  /** Required iff amountKind === 'fixed_minor'. Canonical non-negative minor units. */
  readonly amountMinor?: string;
  /** Required iff amountKind === 'percent_of_gross_bps'. Integer, 0 < bps < 10000. */
  readonly bps?: number;
  readonly destinationAccountId?: string;
  readonly categoryLedgerAccountId?: string;
}

export interface PaycheckTemplate {
  readonly templateId: string;
  readonly version: number;
  readonly lines: readonly PaycheckTemplateLine[];
}

export interface PaycheckTemplateApplyInput {
  readonly template: PaycheckTemplate;
  /** Observed bank deposit N (net take-home), canonical non-negative minor units. */
  readonly netDepositMinor: string;
  /**
   * Optional per-line transaction ids for the emitted destination/deposit matches. Keyed by
   * lineKey; when absent a deterministic synthetic id `tpl:<lineKey>` is used so the emitted
   * components still reconcile through reconcilePaycheck.
   */
  readonly transactionIdByLineKey?: Readonly<Record<string, string>>;
}

export type TemplateApplyRejection =
  | { readonly code: 'no_remainder_line' }
  | { readonly code: 'multiple_remainder_lines'; readonly count: number }
  | { readonly code: 'invalid_line'; readonly lineKey: string; readonly detail: string }
  | { readonly code: 'aggregate_percent_out_of_range'; readonly totalBps: string }
  | { readonly code: 'reimbursement_exceeds_seed'; readonly reimbursementMinor: string }
  | { readonly code: 'bigint_overflow'; readonly detail: string }
  | { readonly code: 'does_not_reconcile'; readonly detail: string };

export class TemplateApplyError extends Error {
  readonly rejection: TemplateApplyRejection;
  constructor(rejection: TemplateApplyRejection) {
    super(`paycheck template does not apply: ${rejection.code}`);
    this.name = 'TemplateApplyError';
    this.rejection = rejection;
  }
}

export interface TemplateApplyLineResult {
  readonly lineKey: string;
  readonly role: PaycheckLineRole;
  readonly kind: PaycheckComponentKind;
  readonly amountMinor: string;
}

export interface TemplateApplyResult {
  readonly formulaVersion: typeof PAYCHECK_TEMPLATE_FORMULA_VERSION;
  readonly grossMinor: string;
  readonly netMinor: string;
  readonly lines: readonly TemplateApplyLineResult[];
  /** keel_paycheck_create-shaped components (gross earning + deductions + one direct_deposit=N). */
  readonly components: readonly PaycheckComponentInput[];
  /** The reconcilePaycheck input built from `components`; already verified ok. */
  readonly paycheckInput: PaycheckInput;
}

const CANONICAL_NONNEG = /^(0|[1-9][0-9]*)$/u;

const parseFixed = (line: PaycheckTemplateLine): bigint => {
  const wire = line.amountMinor;
  if (wire === undefined || !CANONICAL_NONNEG.test(wire)) {
    throw new TemplateApplyError({
      code: 'invalid_line',
      lineKey: line.lineKey,
      detail: 'fixed_minor line requires canonical non-negative amountMinor',
    });
  }
  return BigInt(wire);
};

const parseBps = (line: PaycheckTemplateLine): bigint => {
  const bps = line.bps;
  if (bps === undefined || !Number.isInteger(bps) || bps <= 0 || bps >= 10_000) {
    throw new TemplateApplyError({
      code: 'invalid_line',
      lineKey: line.lineKey,
      detail: 'percent_of_gross_bps line requires integer bps in (0, 10000)',
    });
  }
  return BigInt(bps);
};

const parseNet = (wire: string): bigint => {
  if (!CANONICAL_NONNEG.test(wire)) {
    throw new TemplateApplyError({
      code: 'does_not_reconcile',
      detail: 'netDepositMinor must be canonical non-negative minor units',
    });
  }
  return BigInt(wire);
};

/** Guarded multiply — rejects if the product would exceed int64 (§D4 overflow guard). */
const mulGuarded = (a: bigint, b: bigint, detail: string): bigint => {
  const product = a * b;
  if (product > INT64_MAX) throw new TemplateApplyError({ code: 'bigint_overflow', detail });
  return product;
};

const addGuarded = (a: bigint, b: bigint, detail: string): bigint => {
  const total = a + b;
  if (total > INT64_MAX) throw new TemplateApplyError({ code: 'bigint_overflow', detail });
  return total;
};

/** round_half_up(value·bps, 10000) in exact bigint: (value·bps + 5000) / 10000. */
const percentHalfUp = (gross: bigint, bps: bigint): bigint => {
  const product = mulGuarded(gross, bps, 'gross*bps');
  return addGuarded(product, 5_000n, 'gross*bps + 5000') / BPS_DENOMINATOR;
};

/** Exact positive ceil division: ceil(a / b) = (a + b − 1) / b for a >= 0, b > 0. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

interface PartitionedTemplate {
  readonly earning: PaycheckTemplateLine;
  readonly percentLines: readonly { readonly line: PaycheckTemplateLine; readonly bps: bigint }[];
  readonly fixedDeductionLines: readonly { readonly line: PaycheckTemplateLine; readonly amount: bigint }[];
  readonly fixedDeductionTotal: bigint;
  readonly reimbursement: bigint;
  readonly aggregateBps: bigint;
  readonly remainder: PaycheckTemplateLine;
}

const DEDUCTION_ROLES = new Set<PaycheckLineRole>(['tax', 'pretax_transfer', 'posttax_deduction']);

const partition = (template: PaycheckTemplate): PartitionedTemplate => {
  // "The remainder line" (§D3/§D4) is the take-home net_deposit that absorbs residue. The
  // earning line also uses amountKind 'remainder' as a derive-me marker but is role 'earning',
  // so it is NOT one of the residue-absorbing remainder lines and does not count here.
  const remainderLines = template.lines.filter(
    (l) => l.amountKind === 'remainder' && l.role === 'net_deposit',
  );
  if (remainderLines.length === 0) throw new TemplateApplyError({ code: 'no_remainder_line' });
  if (remainderLines.length > 1) {
    throw new TemplateApplyError({ code: 'multiple_remainder_lines', count: remainderLines.length });
  }
  const [remainder] = remainderLines as [PaycheckTemplateLine];

  const earningLines = template.lines.filter((l) => l.role === 'earning');
  if (earningLines.length !== 1) {
    throw new TemplateApplyError({
      code: 'invalid_line',
      lineKey: earningLines[0]?.lineKey ?? '(none)',
      detail: 'template requires exactly one earning line carrying gross',
    });
  }
  const [earning] = earningLines as [PaycheckTemplateLine];
  // Gross is derived: the earning line carries G, so it must not declare a fixed/percent
  // amount of its own. It is expected to use amountKind 'remainder' as a "derive me" marker
  // while still being role 'earning' (distinct from the net_deposit remainder line).
  if (earning.amountKind !== 'remainder') {
    throw new TemplateApplyError({
      code: 'invalid_line',
      lineKey: earning.lineKey,
      detail: 'earning line carries the derived gross; it must use amountKind remainder',
    });
  }

  const percentLines: { line: PaycheckTemplateLine; bps: bigint }[] = [];
  const fixedDeductionLines: { line: PaycheckTemplateLine; amount: bigint }[] = [];
  let fixedDeductionTotal = 0n;
  let reimbursement = 0n;
  let aggregateBps = 0n;

  for (const line of template.lines) {
    // earning (there is exactly one, already validated) and the single net_deposit remainder
    // are the only role-'earning'/derived lines; everything else is a deduction/addition.
    if (line === earning || line === remainder) continue;

    // Reimbursement additions (§D5 +R): a fixed_minor line whose kind is 'reimbursement'.
    if (line.kind === 'reimbursement') {
      if (line.amountKind !== 'fixed_minor') {
        throw new TemplateApplyError({
          code: 'invalid_line',
          lineKey: line.lineKey,
          detail: 'reimbursement lines must be fixed_minor',
        });
      }
      reimbursement = addGuarded(reimbursement, parseFixed(line), 'Σ reimbursements');
      continue;
    }

    if (!DEDUCTION_ROLES.has(line.role)) {
      throw new TemplateApplyError({
        code: 'invalid_line',
        lineKey: line.lineKey,
        detail: `role ${line.role} is not a supported deduction role`,
      });
    }

    if (line.amountKind === 'percent_of_gross_bps') {
      const bps = parseBps(line);
      aggregateBps = addGuarded(aggregateBps, bps, 'Σ bps');
      percentLines.push({ line, bps });
    } else if (line.amountKind === 'fixed_minor') {
      const amount = parseFixed(line);
      fixedDeductionTotal = addGuarded(fixedDeductionTotal, amount, 'Σ fixed deductions');
      fixedDeductionLines.push({ line, amount });
    } else {
      throw new TemplateApplyError({
        code: 'invalid_line',
        lineKey: line.lineKey,
        detail: 'a second remainder line is not allowed',
      });
    }
  }

  if (aggregateBps >= BPS_DENOMINATOR) {
    throw new TemplateApplyError({
      code: 'aggregate_percent_out_of_range',
      totalBps: aggregateBps.toString(),
    });
  }

  return {
    earning,
    percentLines,
    fixedDeductionLines,
    fixedDeductionTotal,
    reimbursement,
    aggregateBps,
    remainder,
  };
};

/**
 * net(G) = G + R − ΣF − Σ round_half_up(G·p_i, 10000). The single remainder (take-home
 * net_deposit) line is defined to equal net(G); we select the unique G with net(G) = N and
 * remainder ≥ 0.
 */
const netAtGross = (gross: bigint, p: PartitionedTemplate): bigint => {
  let taxes = 0n;
  for (const { bps } of p.percentLines) taxes = addGuarded(taxes, percentHalfUp(gross, bps), 'Σ taxes');
  return gross + p.reimbursement - p.fixedDeductionTotal - taxes;
};

/**
 * Exact integer gross selection (§D4 step 1, corrected). Let k = #percent lines. As G→G+1
 * each per-line half-up tax rises by 0 or 1, so Σtaxes rises by 0..k and thus
 * net(G+1) − net(G) = 1 − (0..k) ∈ [1−k, 1]. When k ≥ 2 net(G) is therefore NOT globally
 * monotone (it can dip locally), which invalidates both the plan's "unique G / ±2 window"
 * claim AND a naive binary search (see NOTES). But net trends upward with true slope
 * (10000−P)/10000 > 0, and each rounding term deviates from the exact linear model by < 1, so
 * every exact solution G lies within a provable window of the closed-form seed. We linearly
 * scan that exact window, collect all reconciling G, and return the SMALLEST (the minimal
 * gross producing this take-home) — deterministic and canonical regardless of k. All bigint.
 */
const selectGross = (net: bigint, p: PartitionedTemplate): bigint => {
  // Seed G0 = ceil((N − R + ΣF)·10000 / (10000 − P)). N − R + ΣF is the fixed+percent
  // "grossed-down" target; when R > that target the paycheck is nonsensical (reimbursement
  // alone would exceed gross) — reject explicitly rather than seed a negative gross.
  const seedNumeratorBase = net - p.reimbursement + p.fixedDeductionTotal;
  if (seedNumeratorBase < 0n) {
    throw new TemplateApplyError({
      code: 'reimbursement_exceeds_seed',
      reimbursementMinor: p.reimbursement.toString(),
    });
  }
  const seedNumerator = mulGuarded(seedNumeratorBase, BPS_DENOMINATOR, '(N−R+ΣF)*10000');
  const denominator = BPS_DENOMINATOR - p.aggregateBps; // > 0, guaranteed by aggregate check
  const seed = seedNumerator === 0n ? 0n : ceilDiv(seedNumerator, denominator);

  // Window bound: the linear (unrounded) model gives net_lin(G) = G·(10000−P)/10000 − ΣF + R.
  // The exact net differs from net_lin by the sum of k per-line rounding residues, each in
  // (−1, 1), so |net(G) − net_lin(G)| < k. Solving net_lin(G) = N gives G* = seed exactly (up
  // to the ceil), and to move net by the < k rounding slack requires |ΔG| < k·10000/(10000−P).
  // pad = ceil(k·10000/(10000−P)) + 2 strictly contains every exact solution around the seed.
  const k = BigInt(p.percentLines.length);
  const pad = k === 0n
    ? 2n
    : ceilDiv(mulGuarded(k, BPS_DENOMINATOR, 'k*10000'), denominator) + 2n;
  const lo = seed - pad < 0n ? 0n : seed - pad;
  const hi = seed + pad;

  let selected: bigint | undefined;
  for (let gross = lo; gross <= hi; gross += 1n) {
    if (netAtGross(gross, p) === net) { selected = gross; break; } // ascending ⇒ smallest first
  }
  /* c8 ignore start — fail-closed guard: net(G) starts at 0, changes by at most +1 per unit
     of G (Σtaxes rises by 0..k so net rises by 1−(0..k) ≤ 1) and grows to ∞, hence lands on
     every non-negative integer — every valid non-negative net IS reachable and the window
     provably contains its smallest gross. This branch is retained as a safety net (Law 1:
     never emit a silently-wrong output if the window/seed math ever regresses). */
  if (selected === undefined) {
    throw new TemplateApplyError({
      code: 'does_not_reconcile',
      detail: `no integer gross near seed ${String(seed)} yields net ${String(net)}`,
    });
  }
  /* c8 ignore stop */
  return selected;
};

/**
 * Apply a split template to an observed net deposit N. Returns keel_paycheck_create-shaped
 * components (gross earning + every deduction + one direct_deposit = N), the derived gross,
 * and the reconcilePaycheck input — already verified to reconcile. Throws TemplateApplyError
 * with a typed rejection on any invalid template or non-reconciling case (never a silent
 * wrong output).
 */
export const applyPaycheckTemplate = (input: PaycheckTemplateApplyInput): TemplateApplyResult => {
  const net = parseNet(input.netDepositMinor);
  const p = partition(input.template);
  const gross = selectGross(net, p);

  // The single remainder line absorbs the residue: remainder = net(G) = N by construction.
  const remainderAmount = netAtGross(gross, p);
  /* c8 ignore start — fail-closed invariant guard: selectGross returns G with net(G)===N and
     N was validated non-negative, so remainder is provably >= 0 here. Kept as a safety net
     (Law 1: never emit a silently-wrong / negative deposit line) but unreachable by design. */
  if (remainderAmount < 0n) {
    throw new TemplateApplyError({
      code: 'does_not_reconcile',
      detail: `remainder ${String(remainderAmount)} is negative`,
    });
  }
  /* c8 ignore stop */

  const lines: TemplateApplyLineResult[] = [];
  const components: PaycheckComponentInput[] = [];

  // Gross earning line carries G.
  lines.push({ lineKey: p.earning.lineKey, role: 'earning', kind: p.earning.kind, amountMinor: gross.toString() });
  components.push({ key: p.earning.lineKey, kind: p.earning.kind, amountMinor: gross.toString() });

  // Reimbursement additions (§D5): emit each as its own component so reconcilePaycheck counts it.
  for (const line of input.template.lines) {
    if (line === p.earning || line === p.remainder) continue;
    if (line.kind === 'reimbursement') {
      const amount = parseFixed(line);
      lines.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: amount.toString() });
      components.push({ key: line.lineKey, kind: line.kind, amountMinor: amount.toString() });
    }
  }

  // Fixed deductions.
  for (const { line, amount } of p.fixedDeductionLines) {
    lines.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: amount.toString() });
    components.push({ key: line.lineKey, kind: line.kind, amountMinor: amount.toString() });
  }

  // Percent deductions — round_half_up(G·bps, 10000).
  for (const { line, bps } of p.percentLines) {
    const amount = percentHalfUp(gross, bps);
    lines.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: amount.toString() });
    components.push({ key: line.lineKey, kind: line.kind, amountMinor: amount.toString() });
  }

  // Single direct_deposit (remainder) = net = N.
  lines.push({ lineKey: p.remainder.lineKey, role: 'net_deposit', kind: 'direct_deposit', amountMinor: remainderAmount.toString() });
  components.push({ key: p.remainder.lineKey, kind: 'direct_deposit', amountMinor: remainderAmount.toString() });

  // Build reconcilePaycheck input: match the single direct_deposit and every destination
  // component (pretax_transfer legs) to a (synthetic-by-default) transaction id.
  const txnOf = (lineKey: string): string => input.transactionIdByLineKey?.[lineKey] ?? `tpl:${lineKey}`;
  const DESTINATION_KINDS = new Set<PaycheckComponentKind>([
    'retirement_401k', 'employer_match', 'hsa', 'fsa', 'espp', 'direct_deposit',
  ]);
  const matches = components
    .filter((c) => DESTINATION_KINDS.has(c.kind))
    .map((c) => ({ transactionId: txnOf(c.key), componentKey: c.key, amountMinor: c.amountMinor }));
  const transactionAmounts: Record<string, string> = {};
  for (const m of matches) {
    const prior = transactionAmounts[m.transactionId];
    transactionAmounts[m.transactionId] = (
      (prior === undefined ? 0n : BigInt(prior)) + BigInt(m.amountMinor)
    ).toString();
  }

  const paycheckInput: PaycheckInput = {
    grossMinor: gross.toString(),
    netMinor: remainderAmount.toString(),
    components,
    matches,
    transactionAmounts,
  };

  // §D4 step 3: validate the emitted components through reconcilePaycheck. This must pass —
  // if the deterministic math is right, it always does. Fail closed otherwise (no silent
  // wrong output).
  const reconciliation = reconcilePaycheck(paycheckInput);
  /* c8 ignore start — cross-check backstop: the emitted components are constructed to satisfy
     every reconcilePaycheck invariant (Σ earnings=G, net=N, single deposit=N, destinations
     matched), so this always passes when the math is correct. Retained as a fail-closed guard
     against a future regression; unreachable by construction today. */
  if (!reconciliation.ok) {
    throw new TemplateApplyError({
      code: 'does_not_reconcile',
      detail: `reconcilePaycheck rejected the emitted components: ${JSON.stringify(reconciliation.violations)}`,
    });
  }
  /* c8 ignore stop */

  return {
    formulaVersion: PAYCHECK_TEMPLATE_FORMULA_VERSION,
    grossMinor: gross.toString(),
    netMinor: remainderAmount.toString(),
    lines,
    components,
    paycheckInput,
  };
};
