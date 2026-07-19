/**
 * Exact-only card-payment matcher tests (Law 1 deterministic). Mirror of the
 * SQL `keel_statement_suggest_payments` rules: exact amount, forward window,
 * eligibility, never resurrect rejected, single survivor → suggest, ≥2 → abstain.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decidePaymentMatch,
  rankPaymentSurvivors,
  type PaymentCandidate,
  type StatementPaymentContext,
} from '../src/statement/index.js';

const statement: StatementPaymentContext = {
  periodEnd: '2026-07-31',
  endingMinor: '-15210', // |ending| = 15210 is the payment to find
  currency: 'USD',
};

const cand = (over: Partial<PaymentCandidate>): PaymentCandidate => ({
  transactionId: 't1',
  amountMinor: '15210',
  currency: 'USD',
  effectiveDate: '2026-08-05',
  eligible: true,
  previouslyRejected: false,
  hasTransferLink: false,
  ...over,
});

describe('exact-only payment match', () => {
  it('single exact survivor in window → suggest, score 100', () => {
    const out = decidePaymentMatch(statement, [cand({})]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.match.transactionId).toBe('t1');
      expect(out.match.score).toBe(100);
      expect(out.match.reasonCodes).toContain('AMOUNT_EXACT');
    }
  });

  it('no exact amount → none', () => {
    const out = decidePaymentMatch(statement, [cand({ amountMinor: '15200' })]);
    expect(out.kind).toBe('none');
  });

  it('two exact survivors → abstain ambiguous', () => {
    const out = decidePaymentMatch(statement, [
      cand({ transactionId: 'a' }),
      cand({ transactionId: 'b', effectiveDate: '2026-08-06' }),
    ]);
    expect(out).toEqual({ kind: 'abstain', reason: 'ambiguous' });
  });

  it('outside the 35d forward window → none (before period end excluded)', () => {
    expect(decidePaymentMatch(statement, [cand({ effectiveDate: '2026-07-30' })]).kind).toBe('none');
    expect(decidePaymentMatch(statement, [cand({ effectiveDate: '2026-09-10' })]).kind).toBe('none');
  });

  it('includes both window endpoints', () => {
    expect(decidePaymentMatch(statement, [cand({ effectiveDate: '2026-07-31' })]).kind).toBe('suggest');
    expect(decidePaymentMatch(statement, [cand({ effectiveDate: '2026-09-04' })]).kind).toBe('suggest');
  });

  it('ineligible / previously-rejected / wrong-currency candidates excluded', () => {
    expect(decidePaymentMatch(statement, [cand({ eligible: false })]).kind).toBe('none');
    expect(decidePaymentMatch(statement, [cand({ previouslyRejected: true })]).kind).toBe('none');
    expect(decidePaymentMatch(statement, [cand({ currency: 'EUR' })]).kind).toBe('none');
  });

  it('a matched negative-signed candidate still matches on absolute value', () => {
    const out = decidePaymentMatch(statement, [cand({ amountMinor: '-15210' })]);
    expect(out.kind).toBe('suggest');
  });

  it('transfer-link survivor carries the reason code', () => {
    const out = decidePaymentMatch(statement, [cand({ hasTransferLink: true })]);
    if (out.kind === 'suggest') expect(out.match.reasonCodes).toContain('TRANSFER_LINK_PAIR');
  });
});

describe('rankPaymentSurvivors ordering', () => {
  it('prefers transfer-link pair, then nearest date, then lowest id', () => {
    const ranked = rankPaymentSurvivors(statement, [
      cand({ transactionId: 'z', effectiveDate: '2026-08-10' }),
      cand({ transactionId: 'a', effectiveDate: '2026-08-10' }),
      cand({ transactionId: 'link', effectiveDate: '2026-08-20', hasTransferLink: true }),
      cand({ transactionId: 'near', effectiveDate: '2026-08-01' }),
      // filtered out: wrong currency, ineligible, out of window, wrong amount
      cand({ transactionId: 'eur', currency: 'EUR' }),
      cand({ transactionId: 'inelig', eligible: false }),
      cand({ transactionId: 'far', effectiveDate: '2026-10-01' }),
      cand({ transactionId: 'off', amountMinor: '1' }),
    ]);
    expect(ranked.map((c) => c.transactionId)).toEqual(['link', 'near', 'a', 'z']);
  });

  it('breaks a pure id tie ascending, and equal keys return 0', () => {
    // Several survivors identical on link + date differ only by id → id ascending.
    // With 3+ elements the comparator is invoked with args in both orders,
    // exercising both the `<` and `>` branches of the id tie-break.
    const ranked = rankPaymentSurvivors(statement, [
      cand({ transactionId: 'c', effectiveDate: '2026-08-05' }),
      cand({ transactionId: 'a', effectiveDate: '2026-08-05' }),
      cand({ transactionId: 'b', effectiveDate: '2026-08-05' }),
    ]);
    expect(ranked.map((c) => c.transactionId)).toEqual(['a', 'b', 'c']);
    // and a fully-equal pair (same id + date) sorts stably (comparator → 0)
    const tie = rankPaymentSurvivors(statement, [
      cand({ transactionId: 'same', effectiveDate: '2026-08-05' }),
      cand({ transactionId: 'same', effectiveDate: '2026-08-05' }),
    ]);
    expect(tie).toHaveLength(2);
  });
});

describe('fuzz: never throws, never auto-confirms >1 exact', () => {
  it('property over random candidate sets', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            transactionId: fc.string({ minLength: 1, maxLength: 6 }),
            amountMinor: fc.integer({ min: -20000, max: 20000 }).map(String),
            effectiveDate: fc
              .integer({ min: 20260701, max: 20260930 })
              .map((n) => {
                const s = String(n);
                return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
              }),
            eligible: fc.boolean(),
            previouslyRejected: fc.boolean(),
            hasTransferLink: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        (raw) => {
          const cands = raw.map((r) => ({ ...r, currency: 'USD' }));
          const out = decidePaymentMatch(statement, cands);
          const exactCount = rankPaymentSurvivors(statement, cands).length;
          if (exactCount === 0) expect(out.kind).toBe('none');
          else if (exactCount === 1) expect(out.kind).toBe('suggest');
          else expect(out.kind).toBe('abstain');
        },
      ),
    );
  });
});
