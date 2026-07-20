// SLICE D — TS↔SQL parity corpus. These are the EXACT fixtures the SQL pgTAP
// (tests/pgtap/paycheck_template_compute.sql) asserts against keel_paycheck_
// template_compute. This file asserts the TS applyPaycheckTemplate produces the
// SAME gross / per-leg / remainder numbers on that shared corpus, so TS == SQL by
// transitivity (both == the frozen expected values). The correctness linchpin
// (docs/harness/plans/paycheck-split-templates-v2.md §D4): the template MATH is
// what set_splits does NOT do; it must be identical on both sides.

import { describe, expect, it } from 'vitest';
import {
  applyPaycheckTemplate,
  type PaycheckTemplate,
  type PaycheckTemplateLine,
} from '../src/index.js';

const earning: PaycheckTemplateLine = {
  lineKey: 'gross', role: 'earning', kind: 'gross_salary', amountKind: 'remainder',
};
const deposit = (dest: string): PaycheckTemplateLine => ({
  lineKey: 'deposit', role: 'net_deposit', kind: 'direct_deposit', amountKind: 'remainder',
  destinationAccountId: dest,
});
const percent = (
  lineKey: string, bps: number, kind: PaycheckTemplateLine['kind'] = 'federal_withholding',
): PaycheckTemplateLine => ({
  lineKey, role: 'tax', kind, amountKind: 'percent_of_gross_bps', bps,
  categoryLedgerAccountId: 'cat',
});
const pretax = (lineKey: string, bps: number, dest: string): PaycheckTemplateLine => ({
  lineKey, role: 'pretax_transfer', kind: 'retirement_401k', amountKind: 'percent_of_gross_bps', bps,
  destinationAccountId: dest,
});
const fixed = (lineKey: string, amountMinor: string): PaycheckTemplateLine => ({
  lineKey, role: 'posttax_deduction', kind: 'benefit', amountKind: 'fixed_minor', amountMinor,
  categoryLedgerAccountId: 'cat',
});
const tpl = (lines: readonly PaycheckTemplateLine[]): PaycheckTemplate => ({
  templateId: 'tpl', version: 1, lines,
});
const legOf = (result: ReturnType<typeof applyPaycheckTemplate>, key: string) =>
  result.lines.find((l) => l.lineKey === key)?.amountMinor;

describe('SLICE D TS↔SQL parity corpus (shared with pgTAP paycheck_template_compute.sql)', () => {
  it('Fixture A — Codex example N=100000 F=12300 bps{1,1,246} → G=115157', () => {
    const r = applyPaycheckTemplate({
      netDepositMinor: '100000',
      template: tpl([
        earning,
        fixed('medical', '12300'),
        percent('local1', 1, 'local_withholding'),
        percent('local2', 1, 'local_withholding'),
        percent('fed', 246),
        deposit('checking'),
      ]),
    });
    expect(r.grossMinor).toBe('115157');
    expect(r.netMinor).toBe('100000');
    expect(legOf(r, 'fed')).toBe('2833');
    expect(legOf(r, 'local1')).toBe('12');
    expect(legOf(r, 'deposit')).toBe('100000');
  });

  it('Fixture B — 401k pretax_transfer: fed 2000bps + 401k 500bps, net 750000 → G=1000000', () => {
    const r = applyPaycheckTemplate({
      netDepositMinor: '750000',
      template: tpl([earning, percent('fed', 2000), pretax('r401k', 500, 'roth'), deposit('checking')]),
    });
    expect(r.grossMinor).toBe('1000000');
    expect(legOf(r, 'r401k')).toBe('50000');
    expect(legOf(r, 'fed')).toBe('200000');
    // the pretax_transfer leg names its destination (the 401k distribution target).
    expect(r.lines.find((l) => l.lineKey === 'r401k')?.role).toBe('pretax_transfer');
  });

  it('Fixture C — N=0 → G=0', () => {
    const r = applyPaycheckTemplate({
      netDepositMinor: '0',
      template: tpl([earning, percent('fed', 2500), deposit('checking')]),
    });
    expect(r.grossMinor).toBe('0');
  });

  it('Fixture E — single-cent residue bps=1 N=1 → G=1', () => {
    const r = applyPaycheckTemplate({
      netDepositMinor: '1',
      template: tpl([earning, percent('fed', 1), deposit('checking')]),
    });
    expect(r.grossMinor).toBe('1');
  });
});
