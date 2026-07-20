import { describe, expect, it } from 'vitest';

import { classifyCashFlow, type CategoryPosting } from './cash-flow-classify';

const p = (amountMinor: bigint): CategoryPosting => ({ amountMinor });

describe('classifyCashFlow (cash-flow graph split, sign-classified)', () => {
  it('a received payment tagged to a spend category is MONEY IN, never negative money OUT', () => {
    // Reproduces the founder-reported bug: a $7,470 "POSH Event Payout" (an
    // income RECEIPT, so a credit → amount_minor < 0) that the user overlaid to
    // an EXPENSE category, alongside $200 of genuine spend (a debit → > 0).
    const posts = [p(-747000n), p(20000n)];
    const { inflowMinor, outflowMinor, netMinor } = classifyCashFlow(posts);

    expect(inflowMinor).toBe(747000n); // the receipt counts as money in
    expect(outflowMinor).toBe(20000n); // only the real spend is money out
    expect(outflowMinor >= 0n).toBe(true); // the bug: outflow can never be < 0
    // net is the ledger net: −Σ amount = 747000 − 20000
    expect(netMinor).toBe(727000n);
  });

  it('outflow is non-negative even when receipts-into-expense exceed real spend', () => {
    // The exact live shape that drove Oct-2025 outflow to −$3,528 under v6:
    // expense-side postings summing to a large NEGATIVE (credits) plus a
    // smaller positive (real debits). Sign-classified, the credits become
    // inflow and outflow stays ≥ 0.
    const posts = [p(-791562n), p(438737n)]; // −$7,915.62 credits, +$4,387.37 debits
    const { inflowMinor, outflowMinor, netMinor } = classifyCashFlow(posts);

    expect(outflowMinor).toBe(438737n);
    expect(outflowMinor >= 0n).toBe(true);
    expect(inflowMinor).toBe(791562n);
    expect(inflowMinor >= 0n).toBe(true);
    // net unchanged vs any prior formula: −Σ amount
    expect(netMinor).toBe(791562n - 438737n);
  });

  it('net equals −Σ(amount_minor) for an arbitrary mix (invariant preserved)', () => {
    const posts = [p(-100n), p(250n), p(-40n), p(0n), p(9n)];
    const sum = posts.reduce((acc, x) => acc + x.amountMinor, 0n);
    const { netMinor, inflowMinor, outflowMinor } = classifyCashFlow(posts);
    expect(netMinor).toBe(-sum);
    expect(inflowMinor).toBe(140n);
    expect(outflowMinor).toBe(259n);
    expect(inflowMinor - outflowMinor).toBe(netMinor);
  });

  it('both sides are zero for an empty bucket', () => {
    expect(classifyCashFlow([])).toEqual({ inflowMinor: 0n, outflowMinor: 0n, netMinor: 0n });
  });

  it('a pure-spend month has zero inflow and positive outflow', () => {
    const { inflowMinor, outflowMinor } = classifyCashFlow([p(500n), p(1200n)]);
    expect(inflowMinor).toBe(0n);
    expect(outflowMinor).toBe(1700n);
  });
});
