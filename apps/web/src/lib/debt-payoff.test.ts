import { describe, expect, it } from 'vitest';

import { parseAprBps, simulatePayoff } from './debt-payoff';

describe('simulatePayoff', () => {
  it('reaches zero in exactly N months at 0% APR with a clean division', () => {
    // $1200 balance, $100/mo, no interest — exactly 12 months, no interest.
    const r = simulatePayoff({
      balanceMinor: 120_000n,
      aprBps: 0,
      minPaymentMinor: 10_000n,
    });
    expect(r).toEqual({ ok: true, months: 12, totalInterestMinor: 0n });
  });

  it('handles an uneven final payment at 0% APR (13th month is a partial payment)', () => {
    // $1250 balance, $100/mo: 12 full payments ($1200) then a final $50 payment.
    const r = simulatePayoff({
      balanceMinor: 125_000n,
      aprBps: 0,
      minPaymentMinor: 10_000n,
    });
    expect(r).toEqual({ ok: true, months: 13, totalInterestMinor: 0n });
  });

  it('amortizes a realistic balance/rate/payment to payoff, floor-dividing interest', () => {
    // $2400 balance, 12% APR (1% monthly, exact — no floor rounding needed to
    // confirm the arithmetic), $200/mo minimum, no extra.
    // Hand-verified month 1: interest = 240000 * 1200 / 120000 = 2400 exactly
    // (1% of 240000); month 2: interest = 222400 * 1% = 2224 exactly.
    const r = simulatePayoff({
      balanceMinor: 240_000n,
      aprBps: 1200,
      minPaymentMinor: 20_000n,
    });
    expect(r).toEqual({ ok: true, months: 13, totalInterestMinor: 16_951n });
  });

  it('an extra payment on the same debt finishes sooner and pays less total interest', () => {
    // Same debt as above, $100/mo extra on top of the $200 minimum.
    const r = simulatePayoff({
      balanceMinor: 240_000n,
      aprBps: 1200,
      minPaymentMinor: 20_000n,
      extraMinor: 10_000n,
    });
    expect(r).toEqual({ ok: true, months: 9, totalInterestMinor: 11_427n });
  });

  it('pays off in exactly 1 month when the payment covers balance + interest outright', () => {
    // $500 balance at 19.99% APR: one month's interest = floor(50000*1999/120000) = 832.
    // A huge extra payment settles the whole thing in month 1.
    const r = simulatePayoff({
      balanceMinor: 50_000n,
      aprBps: 1999,
      minPaymentMinor: 2_500n,
      extraMinor: 10_000_000n,
    });
    expect(r).toEqual({ ok: true, months: 1, totalInterestMinor: 832n });
  });

  it('reports negative amortization (payment never covers interest) distinctly, not an infinite loop', () => {
    // $1000 at 24% APR: month-1 interest = 100000*2400/120000 = 2000. A $0.01
    // payment can never even cover interest, let alone shrink principal —
    // no finite schedule exists at ANY horizon.
    const r = simulatePayoff({
      balanceMinor: 100_000n,
      aprBps: 2400,
      minPaymentMinor: 1n,
    });
    expect(r).toEqual({ ok: false, reason: 'negative_amortization' });
  });

  it('reports a payment exceeding the 50-year horizon distinctly from negative amortization (review r3604731467)', () => {
    // $10,000 at 0% APR with a $10/mo payment pays off in exactly 1000
    // months — a REAL, finite, payoff-eventually schedule, just longer than
    // the 600-month cap. This must NOT read the same as "never gets ahead
    // of interest" (negative_amortization) — the debt IS payable, just slowly.
    const r = simulatePayoff({
      balanceMinor: 1_000_000n,
      aprBps: 0,
      minPaymentMinor: 1_000n,
    });
    expect(r).toEqual({ ok: false, reason: 'exceeds_horizon' });
  });

  it('property: more extra payment never finishes later and never costs more interest', () => {
    const base = { balanceMinor: 240_000n, aprBps: 1200, minPaymentMinor: 20_000n };
    const extras = [0n, 5_000n, 10_000n, 20_000n, 50_000n];
    const results = extras.map((extraMinor) => simulatePayoff({ ...base, extraMinor }));

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
    const ok = results as { ok: true; months: number; totalInterestMinor: bigint }[];

    for (let i = 1; i < ok.length; i++) {
      const prev = ok[i - 1]!;
      const cur = ok[i]!;
      // Strictly better (this scenario's extras are all large enough to move
      // the needle), and never worse in either dimension.
      expect(cur.months).toBeLessThanOrEqual(prev.months);
      expect(cur.totalInterestMinor).toBeLessThanOrEqual(prev.totalInterestMinor);
      expect(cur.months < prev.months || cur.totalInterestMinor < prev.totalInterestMinor).toBe(
        true,
      );
    }
  });

  it('rejects invalid inputs rather than guessing', () => {
    expect(simulatePayoff({ balanceMinor: 0n, aprBps: 1000, minPaymentMinor: 10_000n })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(simulatePayoff({ balanceMinor: -1n, aprBps: 1000, minPaymentMinor: 10_000n })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(
      simulatePayoff({ balanceMinor: 10_000n, aprBps: 1000, minPaymentMinor: 0n }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      simulatePayoff({
        balanceMinor: 10_000n,
        aprBps: 1000,
        minPaymentMinor: 100n,
        extraMinor: -1n,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      simulatePayoff({ balanceMinor: 10_000n, aprBps: -5, minPaymentMinor: 100n }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('never overstates interest: floor division on a fractional monthly rate', () => {
    // 19.99% APR month-1 interest on $500: 50000*1999/120000 = 832.9166... → floors to 832,
    // never rounds up to 833 (Law 4 — same convention as utilizationPercent).
    const r = simulatePayoff({
      balanceMinor: 50_000n,
      aprBps: 1999,
      minPaymentMinor: 50_832n, // exactly covers month 1's principal + floored interest
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.months).toBe(1);
      expect(r.totalInterestMinor).toBe(832n);
    }
  });
});

describe('parseAprBps', () => {
  it('parses whole and fractional percents into basis points', () => {
    expect(parseAprBps('19.99')).toBe(1999);
    expect(parseAprBps('0')).toBe(0);
    expect(parseAprBps('5')).toBe(500);
    expect(parseAprBps('.5')).toBe(50);
    expect(parseAprBps('24.9')).toBe(2490);
  });

  it('rejects negative or unparseable input', () => {
    expect(parseAprBps('-1')).toBeNull();
    expect(parseAprBps('abc')).toBeNull();
    expect(parseAprBps('19.999')).toBeNull();
    expect(parseAprBps('')).toBeNull();
    expect(parseAprBps('1e5')).toBeNull();
  });
});
