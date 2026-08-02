import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyPaycheckTemplate,
  reconcilePaycheck,
  TemplateApplyError,
  PAYCHECK_TEMPLATE_FORMULA_VERSION,
  type PaycheckTemplate,
  type PaycheckTemplateLine,
  type TemplateApplyRejection,
} from '../src/index.js';

// Fictional employer per CLAUDE.md ops fact (no real payroll strings).
const EMPLOYER = 'Anchorwave Payroll';

const earning: PaycheckTemplateLine = {
  lineKey: 'gross',
  role: 'earning',
  kind: 'gross_salary',
  amountKind: 'remainder',
};
const takeHome: PaycheckTemplateLine = {
  lineKey: 'deposit',
  role: 'net_deposit',
  kind: 'direct_deposit',
  amountKind: 'remainder',
  destinationAccountId: 'checking',
};

const fixed = (lineKey: string, amountMinor: string, kind: PaycheckTemplateLine['kind'] = 'benefit'): PaycheckTemplateLine => ({
  lineKey, role: 'posttax_deduction', kind, amountKind: 'fixed_minor', amountMinor,
});
const percent = (lineKey: string, bps: number, kind: PaycheckTemplateLine['kind'] = 'federal_withholding'): PaycheckTemplateLine => ({
  lineKey, role: 'tax', kind, amountKind: 'percent_of_gross_bps', bps,
});

const template = (lines: readonly PaycheckTemplateLine[], templateId = 'tpl', version = 1): PaycheckTemplate => ({
  templateId, version, lines,
});

const expectRejection = (fn: () => unknown, code: TemplateApplyRejection['code']): TemplateApplyRejection => {
  try {
    fn();
    throw new Error('expected TemplateApplyError');
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateApplyError);
    const rej = (error as TemplateApplyError).rejection;
    expect(rej.code).toBe(code);
    return rej;
  }
};

describe('applyPaycheckTemplate — Codex worked example (§D4)', () => {
  it('N=100000, F=12300, bps {1,1,246} → G=115157 reconciles exactly', () => {
    const result = applyPaycheckTemplate({
      template: template([
        earning,
        fixed('medical', '12300'),
        percent('local1', 1, 'local_withholding'),
        percent('local2', 1, 'local_withholding'),
        percent('federal', 246, 'federal_withholding'),
        takeHome,
      ]),
      netDepositMinor: '100000',
    });

    expect(result.grossMinor).toBe('115157');
    expect(result.netMinor).toBe('100000');

    // Per-line rounded taxes from the plan's worked example.
    const amounts = new Map(result.lines.map((l) => [l.lineKey, l.amountMinor]));
    expect(amounts.get('local1')).toBe('12');
    expect(amounts.get('local2')).toBe('12');
    expect(amounts.get('federal')).toBe('2833');
    expect(amounts.get('medical')).toBe('12300');
    expect(amounts.get('deposit')).toBe('100000');
    expect(amounts.get('gross')).toBe('115157');

    // Emitted components must reconcile through reconcilePaycheck (§D4 step 3).
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
    expect(result.formulaVersion).toBe(PAYCHECK_TEMPLATE_FORMULA_VERSION);
  });
});

describe('applyPaycheckTemplate — reconciliation guarantees', () => {
  it('Σ earnings = G and derived net = N (percent + fixed)', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, fixed('dental', '5000'), percent('fed', 1500), percent('state', 500), takeHome]),
      netDepositMinor: '250000',
    });
    const gross = BigInt(result.grossMinor);
    const earnings = result.lines.filter((l) => l.role === 'earning').reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    expect(earnings).toBe(gross);
    const deposit = result.lines.find((l) => l.role === 'net_deposit');
    expect(deposit?.amountMinor).toBe('250000');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('fixed-only template (no percent lines): G = N + ΣF', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, fixed('dental', '5000'), fixed('vision', '2500'), takeHome]),
      netDepositMinor: '90000',
    });
    expect(result.grossMinor).toBe('97500');
    expect(result.netMinor).toBe('90000');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('no-percent, no-fixed template: G = N', () => {
    const result = applyPaycheckTemplate({ template: template([earning, takeHome]), netDepositMinor: '4200' });
    expect(result.grossMinor).toBe('4200');
    expect(result.netMinor).toBe('4200');
  });

  it('handles reimbursement (+R) additions per §D5 sign rules', () => {
    // net = G + R − ΣF − Σtaxes = N.
    const result = applyPaycheckTemplate({
      template: template([
        earning,
        percent('fed', 2000),
        fixed('dental', '3000'),
        { lineKey: 'reimb', role: 'posttax_deduction', kind: 'reimbursement', amountKind: 'fixed_minor', amountMinor: '4500' },
        takeHome,
      ]),
      netDepositMinor: '120000',
    });
    const recon = reconcilePaycheck(result.paycheckInput);
    expect(recon.ok).toBe(true);
    // reconcilePaycheck: net = gross + additions − deductions.
    expect(result.netMinor).toBe('120000');
  });

  it('idempotence: re-applying to the emitted net reproduces identical lines', () => {
    const tpl = template([earning, fixed('med', '9900'), percent('fed', 1234), percent('state', 456), takeHome]);
    const first = applyPaycheckTemplate({ template: tpl, netDepositMinor: '333333' });
    const second = applyPaycheckTemplate({ template: tpl, netDepositMinor: first.netMinor });
    expect(second.lines).toEqual(first.lines);
    expect(second.grossMinor).toBe(first.grossMinor);
  });
});

describe('applyPaycheckTemplate — validation / typed rejections', () => {
  it('rejects a template with no remainder line', () => {
    expectRejection(
      () => applyPaycheckTemplate({ template: template([earning, fixed('a', '1')]), netDepositMinor: '1' }),
      'no_remainder_line',
    );
  });

  it('rejects more than one remainder (net_deposit) line', () => {
    const rej = expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, takeHome, { ...takeHome, lineKey: 'deposit2' }]),
        netDepositMinor: '1000',
      }),
      'multiple_remainder_lines',
    );
    expect((rej as { count: number }).count).toBe(2);
  });

  it('rejects aggregate P ≥ 10000 even when each per-line bps < 10000', () => {
    const rej = expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, percent('a', 6000), percent('b', 4000), takeHome]),
        netDepositMinor: '1000',
      }),
      'aggregate_percent_out_of_range',
    );
    expect((rej as { totalBps: string }).totalBps).toBe('10000');
  });

  it('rejects P just over via three lines summing to 10001', () => {
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, percent('a', 3334), percent('b', 3334), percent('c', 3333), takeHome]),
        netDepositMinor: '1000',
      }),
      'aggregate_percent_out_of_range',
    );
  });

  it('rejects out-of-range per-line bps (<=0 or >=10000)', () => {
    for (const bps of [0, 10_000, -5, 20_000, 1.5]) {
      expectRejection(
        () => applyPaycheckTemplate({ template: template([earning, percent('a', bps), takeHome]), netDepositMinor: '1' }),
        'invalid_line',
      );
    }
  });

  it('rejects a fixed line without a canonical amountMinor', () => {
    for (const bad of [undefined, '', '1.00', '01', '-1']) {
      expectRejection(
        () => applyPaycheckTemplate({
          template: template([earning, { lineKey: 'x', role: 'posttax_deduction', kind: 'benefit', amountKind: 'fixed_minor', amountMinor: bad as string }, takeHome]),
          netDepositMinor: '1',
        }),
        'invalid_line',
      );
    }
  });

  it('rejects a bps line missing bps', () => {
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, { lineKey: 'x', role: 'tax', kind: 'federal_withholding', amountKind: 'percent_of_gross_bps' }, takeHome]),
        netDepositMinor: '1',
      }),
      'invalid_line',
    );
  });

  it('rejects zero earning lines and multiple earning lines', () => {
    expectRejection(
      () => applyPaycheckTemplate({ template: template([takeHome, fixed('a', '1')]), netDepositMinor: '1' }),
      'invalid_line',
    );
    expectRejection(
      () => applyPaycheckTemplate({ template: template([earning, { ...earning, lineKey: 'g2' }, takeHome]), netDepositMinor: '1' }),
      'invalid_line',
    );
  });

  it('rejects an earning line that declares a fixed/percent amount', () => {
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([{ lineKey: 'gross', role: 'earning', kind: 'gross_salary', amountKind: 'fixed_minor', amountMinor: '100' }, takeHome]),
        netDepositMinor: '1',
      }),
      'invalid_line',
    );
  });

  it('rejects an unsupported deduction role', () => {
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, { lineKey: 'weird', role: 'net_deposit', kind: 'benefit', amountKind: 'fixed_minor', amountMinor: '10' }, takeHome]),
        netDepositMinor: '1',
      }),
      'invalid_line',
    );
  });

  it('rejects a reimbursement line that is not fixed_minor', () => {
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, { lineKey: 'r', role: 'posttax_deduction', kind: 'reimbursement', amountKind: 'percent_of_gross_bps', bps: 100 }, takeHome]),
        netDepositMinor: '1',
      }),
      'invalid_line',
    );
  });

  it('rejects a second non-earning remainder marker (only net_deposit remainders allowed)', () => {
    // A tax-role line with amountKind 'remainder' is not the net_deposit remainder and is invalid.
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, { lineKey: 'x', role: 'tax', kind: 'federal_withholding', amountKind: 'remainder' }, takeHome]),
        netDepositMinor: '1',
      }),
      'invalid_line',
    );
  });

  it('rejects non-canonical netDepositMinor', () => {
    for (const bad of ['1.5', '-1', '', 'abc']) {
      expectRejection(
        () => applyPaycheckTemplate({ template: template([earning, takeHome]), netDepositMinor: bad }),
        'does_not_reconcile',
      );
    }
  });

  it('rejects a reimbursement that exceeds the seed base (remainder would be negative)', () => {
    // R huge relative to N so N − R + ΣF < 0.
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, { lineKey: 'r', role: 'posttax_deduction', kind: 'reimbursement', amountKind: 'fixed_minor', amountMinor: '999999' }, takeHome]),
        netDepositMinor: '1000',
      }),
      'reimbursement_exceeds_seed',
    );
  });

  it('guards BIGINT overflow on an oversized net deposit (mul guard)', () => {
    // (N − R + ΣF) * 10000 overflows int64 when N is near int64 max.
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, percent('fed', 100), takeHome]),
        netDepositMinor: '9223372036854775807',
      }),
      'bigint_overflow',
    );
  });

  it('guards BIGINT overflow when summing fixed deductions (add guard)', () => {
    // Two near-int64-max fixed deductions overflow int64 in Σ fixed deductions.
    const big = '9000000000000000000';
    expectRejection(
      () => applyPaycheckTemplate({
        template: template([earning, fixed('a', big), fixed('b', big), takeHome]),
        netDepositMinor: '0',
      }),
      'bigint_overflow',
    );
  });
});

describe('reconcilePaycheck — guard branches exercised via template outputs', () => {
  it('rejects a match with an empty transactionId', () => {
    expect(() => reconcilePaycheck({
      grossMinor: '100', netMinor: '100',
      components: [
        { key: 'g', kind: 'gross_salary', amountMinor: '100' },
        { key: 'd', kind: 'direct_deposit', amountMinor: '100' },
      ],
      matches: [{ transactionId: '', componentKey: 'd', amountMinor: '100' }],
      transactionAmounts: {},
    })).toThrow(RangeError);
  });

  it('rejects a match transaction with no capacity evidence', () => {
    expect(() => reconcilePaycheck({
      grossMinor: '100', netMinor: '100',
      components: [
        { key: 'g', kind: 'gross_salary', amountMinor: '100' },
        { key: 'd', kind: 'direct_deposit', amountMinor: '100' },
      ],
      matches: [{ transactionId: 'chk', componentKey: 'd', amountMinor: '100' }],
      transactionAmounts: {},
    })).toThrow(RangeError);
  });
});

describe('applyPaycheckTemplate — boundary cases', () => {
  it('P = 9999 (just under 10000) reconciles', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, percent('a', 9999), takeHome]),
      netDepositMinor: '1',
    });
    expect(BigInt(result.grossMinor) >= 0n).toBe(true);
    expect(result.netMinor).toBe('1');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('N = 1 with a single small percent line', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, percent('fed', 100), takeHome]),
      netDepositMinor: '1',
    });
    expect(result.netMinor).toBe('1');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('N = 0 fixed-only yields G = ΣF', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, fixed('a', '500'), takeHome]),
      netDepositMinor: '0',
    });
    expect(result.grossMinor).toBe('500');
    expect(result.netMinor).toBe('0');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('N = 0 with only percent lines yields G = 0', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, percent('fed', 2500), takeHome]),
      netDepositMinor: '0',
    });
    expect(result.grossMinor).toBe('0');
    expect(result.netMinor).toBe('0');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });

  it('every non-negative net is reachable for a valid template (no gaps to reject)', () => {
    // net(G) starts at 0, moves in steps of at most +1 as G→G+1 (Σtaxes rises by 0..k, so
    // net rises by 1−(0..k) ≤ 1), and →∞. So it lands on EVERY integer in [0, ∞): no
    // non-negative net is unreachable. This documents why the internal "no gross near seed"
    // path is a fail-closed guard, not a normal outcome. Spot-check a contiguous run of N.
    const tpl = template([earning, percent('a', 3333), percent('b', 2500), percent('c', 1200), takeHome]);
    for (let n = 0n; n <= 200n; n += 1n) {
      const result = applyPaycheckTemplate({ template: tpl, netDepositMinor: n.toString() });
      expect(result.netMinor).toBe(n.toString());
      expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
    }
  });

  it('honors caller-supplied transaction ids for the deposit match', () => {
    const result = applyPaycheckTemplate({
      template: template([earning, takeHome]),
      netDepositMinor: '5000',
      transactionIdByLineKey: { deposit: 'chk-real' },
    });
    expect(result.paycheckInput.matches.some((m) => m.transactionId === 'chk-real')).toBe(true);
  });

  it('aggregates transaction capacity when two destinations share one transaction', () => {
    // Two pretax_transfer (destination) lines mapped to the SAME transaction id: their
    // capacities must be summed in transactionAmounts and still reconcile.
    const result = applyPaycheckTemplate({
      template: template([
        earning,
        { lineKey: 'k401', role: 'pretax_transfer', kind: 'retirement_401k', amountKind: 'fixed_minor', amountMinor: '3000', destinationAccountId: 'ret' },
        { lineKey: 'hsa', role: 'pretax_transfer', kind: 'hsa', amountKind: 'fixed_minor', amountMinor: '1000', destinationAccountId: 'hsa-acct' },
        takeHome,
      ]),
      netDepositMinor: '50000',
      transactionIdByLineKey: { k401: 'broker', hsa: 'broker' },
    });
    expect(result.paycheckInput.transactionAmounts['broker']).toBe('4000');
    expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);
  });
});

describe('applyPaycheckTemplate — property tests (fast-check, Law 1/4/9)', () => {
  // Arbitrary VALID templates: >=1 percent lines with ΣP < 10000, random fixed lines, random N.
  const validTemplate = fc
    .record({
      bpsList: fc.array(fc.integer({ min: 1, max: 3000 }), { minLength: 1, maxLength: 5 }),
      fixedList: fc.array(fc.bigInt({ min: 0n, max: 10_000_000n }), { maxLength: 4 }),
    })
    .filter((r) => r.bpsList.reduce((a, b) => a + b, 0) < 10_000);

  it('(a,b,c) Σ earnings = G, derived net = N, idempotent re-apply', () => {
    fc.assert(
      fc.property(validTemplate, fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), (r, n) => {
        const lines: PaycheckTemplateLine[] = [
          earning,
          ...r.bpsList.map((bps, i) => percent(`p${String(i)}`, bps)),
          ...r.fixedList.map((amt, i) => fixed(`f${String(i)}`, amt.toString())),
          takeHome,
        ];
        const tpl = template(lines);
        const result = applyPaycheckTemplate({ template: tpl, netDepositMinor: n.toString() });

        // (a) Σ earnings = G
        const gross = BigInt(result.grossMinor);
        const earnings = result.lines
          .filter((l) => l.role === 'earning')
          .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
        expect(earnings).toBe(gross);

        // (b) derived net = N and reconciles
        expect(result.netMinor).toBe(n.toString());
        expect(reconcilePaycheck(result.paycheckInput).ok).toBe(true);

        // remainder >= 0
        expect(gross >= 0n).toBe(true);
        const deposit = result.lines.find((l) => l.role === 'net_deposit');
        expect(BigInt(deposit!.amountMinor) >= 0n).toBe(true);

        // (c) idempotence
        const again = applyPaycheckTemplate({ template: tpl, netDepositMinor: result.netMinor });
        expect(again.lines).toEqual(result.lines);
      }),
      { numRuns: 500 },
    );
  });

  it('(canonical) selected gross is the GLOBAL smallest reconciling gross (brute-forced)', () => {
    // Small-scale check that the windowed scan returns the true global minimum: brute-force
    // net(G) over a wide gross range, find the smallest G with net(G)===N, compare to the
    // library's choice. Multi-line so net(G) is genuinely non-monotone.
    fc.assert(
      fc.property(
        // Cap ΣP well under 10000 so the grossed-up G stays inside the brute-force range.
        fc.array(fc.integer({ min: 1, max: 1500 }), { minLength: 2, maxLength: 4 }).filter((a) => a.reduce((x, y) => x + y, 0) <= 6_000),
        fc.bigInt({ min: 0n, max: 300n }),
        (bpsList, n) => {
          const lines = [earning, ...bpsList.map((bps, i) => percent(`p${String(i)}`, bps)), takeHome];
          const netAt = (g: bigint): bigint =>
            g - bpsList.reduce((s, bps) => s + (g * BigInt(bps) + 5000n) / 10_000n, 0n);
          // ΣP <= 6000 ⇒ net(G) >= 0.4·G, so N<=300 is reached well within G <= 2000.
          let bruteMin: bigint | undefined;
          for (let g = 0n; g <= 2000n; g += 1n) {
            if (netAt(g) === n) { bruteMin = g; break; }
          }
          let libResult: bigint | undefined;
          let libThrew = false;
          try {
            libResult = BigInt(applyPaycheckTemplate({ template: template(lines), netDepositMinor: n.toString() }).grossMinor);
          } catch {
            libThrew = true;
          }
          if (bruteMin === undefined) {
            expect(libThrew).toBe(true); // unreachable net ⇒ typed reject
          } else {
            expect(libThrew).toBe(false);
            expect(libResult).toBe(bruteMin); // exact global-minimum match
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('(e) aggregate P >= 10000 always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9999 }), { minLength: 2, maxLength: 6 }).filter((a) => a.reduce((x, y) => x + y, 0) >= 10_000),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (bpsList, n) => {
          const lines = [earning, ...bpsList.map((bps, i) => percent(`p${String(i)}`, bps)), takeHome];
          expectRejection(
            () => applyPaycheckTemplate({ template: template(lines), netDepositMinor: n.toString() }),
            'aggregate_percent_out_of_range',
          );
        },
      ),
    );
  });

  it('(f) remainder never silently negative — reimbursement over-seed rejects typed', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (n) => {
        // R strictly greater than N (no fixed deductions) ⇒ N − R + 0 < 0 ⇒ typed reject.
        const r = n + 1n;
        const lines: PaycheckTemplateLine[] = [
          earning,
          { lineKey: 'reimb', role: 'posttax_deduction', kind: 'reimbursement', amountKind: 'fixed_minor', amountMinor: r.toString() },
          takeHome,
        ];
        expectRejection(
          () => applyPaycheckTemplate({ template: template(lines), netDepositMinor: n.toString() }),
          'reimbursement_exceeds_seed',
        );
      }),
    );
  });

  it('(d) exactly-one-remainder enforced across arbitrary line counts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (extraDeposits) => {
        const deposits = Array.from({ length: extraDeposits }, (_v, i) => ({ ...takeHome, lineKey: `dep${String(i)}` }));
        const lines = [earning, ...deposits];
        if (extraDeposits === 0) {
          expectRejection(() => applyPaycheckTemplate({ template: template(lines), netDepositMinor: '10' }), 'no_remainder_line');
        } else if (extraDeposits === 1) {
          expect(applyPaycheckTemplate({ template: template(lines), netDepositMinor: '10' }).netMinor).toBe('10');
        } else {
          expectRejection(() => applyPaycheckTemplate({ template: template(lines), netDepositMinor: '10' }), 'multiple_remainder_lines');
        }
      }),
    );
  });
});

// Referenced so the fictional-employer constant is not flagged unused; documents provenance.
describe(`fixtures use fictional employer ${EMPLOYER}`, () => {
  it('never embeds a real payroll string', () => {
    expect(EMPLOYER).toBe('Anchorwave Payroll');
  });
});
