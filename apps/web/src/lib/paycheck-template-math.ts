// Live-preview math for the paycheck split-template editor (SLICE C).
//
// This is a FAITHFUL browser-local port of the authoritative Slice-A algorithm
// (packages/paychecks/src/template.ts, §D4 of docs/harness/plans/
// paycheck-split-templates-v2.md). apps/web deliberately does not depend on the
// @keel/paychecks workspace package (it re-declares its wire types locally, like
// every other read model), so the exact exact-gross-selection algorithm is
// mirrored here for the UI preview ONLY. The SERVER remains the source of truth:
// keel_cmd_paycheck_save_template re-validates ΣP<10000 / exactly-one-remainder /
// scope at save, and Slice D's SQL apply is the reconciling truth. If the
// authoritative algorithm changes, update BOTH (parity is a Slice-D test).
//
// All arithmetic is exact BIGINT (Law 1, Law 4). Every multiply/add is guarded
// against exceeding int64 so this preview can never show a number the bigint SQL
// columns couldn't hold.

const BPS_DENOMINATOR = 10_000n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const CANONICAL_NONNEG = /^(0|[1-9][0-9]*)$/u;

export type PreviewRole =
  | 'earning'
  | 'tax'
  | 'pretax_transfer'
  | 'posttax_deduction'
  | 'net_deposit';
export type PreviewAmountKind = 'fixed_minor' | 'percent_of_gross_bps' | 'remainder';

export interface PreviewLine {
  readonly lineKey: string;
  readonly role: PreviewRole;
  readonly kind: string;
  readonly amountKind: PreviewAmountKind;
  readonly amountMinor?: string;
  readonly bps?: number;
}

export type PreviewRejection =
  | { readonly code: 'no_remainder_line' }
  | { readonly code: 'multiple_remainder_lines' }
  | { readonly code: 'no_earning_line' }
  | { readonly code: 'multiple_earning_lines' }
  | { readonly code: 'earning_must_be_remainder' }
  | { readonly code: 'invalid_line'; readonly lineKey: string; readonly detail: string }
  | { readonly code: 'aggregate_percent_out_of_range'; readonly totalBps: string }
  | { readonly code: 'reimbursement_exceeds_seed' }
  | { readonly code: 'bigint_overflow' }
  | { readonly code: 'does_not_reconcile' };

class PreviewError extends Error {
  readonly rejection: PreviewRejection;
  constructor(rejection: PreviewRejection) {
    super(rejection.code);
    this.name = 'PreviewError';
    this.rejection = rejection;
  }
}

export interface PreviewLineResult {
  readonly lineKey: string;
  readonly role: PreviewRole;
  readonly kind: string;
  readonly amountMinor: string;
}
export interface PreviewResult {
  readonly ok: true;
  readonly grossMinor: string;
  readonly netMinor: string;
  readonly lines: readonly PreviewLineResult[];
}
export type PreviewOutcome = PreviewResult | { readonly ok: false; readonly rejection: PreviewRejection };

const mulGuarded = (a: bigint, b: bigint): bigint => {
  const p = a * b;
  if (p > INT64_MAX) throw new PreviewError({ code: 'bigint_overflow' });
  return p;
};
const addGuarded = (a: bigint, b: bigint): bigint => {
  const s = a + b;
  if (s > INT64_MAX) throw new PreviewError({ code: 'bigint_overflow' });
  return s;
};
const percentHalfUp = (gross: bigint, bps: bigint): bigint =>
  addGuarded(mulGuarded(gross, bps), 5_000n) / BPS_DENOMINATOR;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

interface Partitioned {
  earning: PreviewLine;
  percentLines: { line: PreviewLine; bps: bigint }[];
  fixedDeductionLines: { line: PreviewLine; amount: bigint }[];
  fixedDeductionTotal: bigint;
  reimbursement: bigint;
  aggregateBps: bigint;
  remainder: PreviewLine;
}

const DEDUCTION_ROLES = new Set<PreviewRole>(['tax', 'pretax_transfer', 'posttax_deduction']);

const parseFixed = (line: PreviewLine): bigint => {
  if (line.amountMinor === undefined || !CANONICAL_NONNEG.test(line.amountMinor)) {
    throw new PreviewError({ code: 'invalid_line', lineKey: line.lineKey, detail: 'fixed line needs a non-negative amount' });
  }
  return BigInt(line.amountMinor);
};
const parseBps = (line: PreviewLine): bigint => {
  const b = line.bps;
  if (b === undefined || !Number.isInteger(b) || b <= 0 || b >= 10_000) {
    throw new PreviewError({ code: 'invalid_line', lineKey: line.lineKey, detail: 'percent line needs bps in (0, 10000)' });
  }
  return BigInt(b);
};

const partition = (lines: readonly PreviewLine[]): Partitioned => {
  const remainderLines = lines.filter((l) => l.amountKind === 'remainder' && l.role === 'net_deposit');
  const remainder = remainderLines[0];
  if (remainder === undefined) throw new PreviewError({ code: 'no_remainder_line' });
  if (remainderLines.length > 1) throw new PreviewError({ code: 'multiple_remainder_lines' });

  const earningLines = lines.filter((l) => l.role === 'earning');
  const earning = earningLines[0];
  if (earning === undefined) throw new PreviewError({ code: 'no_earning_line' });
  if (earningLines.length > 1) throw new PreviewError({ code: 'multiple_earning_lines' });
  if (earning.amountKind !== 'remainder') throw new PreviewError({ code: 'earning_must_be_remainder' });

  const percentLines: { line: PreviewLine; bps: bigint }[] = [];
  const fixedDeductionLines: { line: PreviewLine; amount: bigint }[] = [];
  let fixedDeductionTotal = 0n;
  let reimbursement = 0n;
  let aggregateBps = 0n;

  for (const line of lines) {
    if (line === earning || line === remainder) continue;
    if (line.kind === 'reimbursement') {
      if (line.amountKind !== 'fixed_minor') {
        throw new PreviewError({ code: 'invalid_line', lineKey: line.lineKey, detail: 'reimbursement must be a fixed amount' });
      }
      reimbursement = addGuarded(reimbursement, parseFixed(line));
      continue;
    }
    if (!DEDUCTION_ROLES.has(line.role)) {
      throw new PreviewError({ code: 'invalid_line', lineKey: line.lineKey, detail: `role ${line.role} is not a deduction` });
    }
    if (line.amountKind === 'percent_of_gross_bps') {
      const bps = parseBps(line);
      aggregateBps = addGuarded(aggregateBps, bps);
      percentLines.push({ line, bps });
    } else if (line.amountKind === 'fixed_minor') {
      const amount = parseFixed(line);
      fixedDeductionTotal = addGuarded(fixedDeductionTotal, amount);
      fixedDeductionLines.push({ line, amount });
    } else {
      throw new PreviewError({ code: 'invalid_line', lineKey: line.lineKey, detail: 'a second remainder line is not allowed' });
    }
  }

  if (aggregateBps >= BPS_DENOMINATOR) {
    throw new PreviewError({ code: 'aggregate_percent_out_of_range', totalBps: aggregateBps.toString() });
  }
  return { earning, percentLines, fixedDeductionLines, fixedDeductionTotal, reimbursement, aggregateBps, remainder };
};

const netAtGross = (gross: bigint, p: Partitioned): bigint => {
  let taxes = 0n;
  for (const { bps } of p.percentLines) taxes = addGuarded(taxes, percentHalfUp(gross, bps));
  return gross + p.reimbursement - p.fixedDeductionTotal - taxes;
};

const selectGross = (net: bigint, p: Partitioned): bigint => {
  const seedNumeratorBase = net - p.reimbursement + p.fixedDeductionTotal;
  if (seedNumeratorBase < 0n) throw new PreviewError({ code: 'reimbursement_exceeds_seed' });
  const seedNumerator = mulGuarded(seedNumeratorBase, BPS_DENOMINATOR);
  const denominator = BPS_DENOMINATOR - p.aggregateBps;
  const seed = seedNumerator === 0n ? 0n : ceilDiv(seedNumerator, denominator);
  const k = BigInt(p.percentLines.length);
  const pad = k === 0n ? 2n : ceilDiv(mulGuarded(k, BPS_DENOMINATOR), denominator) + 2n;
  const lo = seed - pad < 0n ? 0n : seed - pad;
  const hi = seed + pad;
  for (let gross = lo; gross <= hi; gross += 1n) {
    if (netAtGross(gross, p) === net) return gross;
  }
  throw new PreviewError({ code: 'does_not_reconcile' });
};

/**
 * Compute the live preview for a set of authored lines against an observed net
 * deposit. Returns { ok:true, grossMinor, netMinor, lines } or { ok:false,
 * rejection } (never throws — the editor renders the typed rejection inline).
 */
export function previewPaycheckTemplate(
  lines: readonly PreviewLine[],
  netDepositMinor: string,
): PreviewOutcome {
  try {
    if (!CANONICAL_NONNEG.test(netDepositMinor)) {
      return { ok: false, rejection: { code: 'does_not_reconcile' } };
    }
    const net = BigInt(netDepositMinor);
    const p = partition(lines);
    const gross = selectGross(net, p);
    const remainderAmount = netAtGross(gross, p);

    const out: PreviewLineResult[] = [];
    out.push({ lineKey: p.earning.lineKey, role: 'earning', kind: p.earning.kind, amountMinor: gross.toString() });
    for (const line of lines) {
      if (line === p.earning || line === p.remainder) continue;
      if (line.kind === 'reimbursement') {
        out.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: parseFixed(line).toString() });
      }
    }
    for (const { line, amount } of p.fixedDeductionLines) {
      out.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: amount.toString() });
    }
    for (const { line, bps } of p.percentLines) {
      out.push({ lineKey: line.lineKey, role: line.role, kind: line.kind, amountMinor: percentHalfUp(gross, bps).toString() });
    }
    out.push({ lineKey: p.remainder.lineKey, role: 'net_deposit', kind: 'direct_deposit', amountMinor: remainderAmount.toString() });

    return { ok: true, grossMinor: gross.toString(), netMinor: remainderAmount.toString(), lines: out };
  } catch (err) {
    if (err instanceof PreviewError) return { ok: false, rejection: err.rejection };
    return { ok: false, rejection: { code: 'does_not_reconcile' } };
  }
}
