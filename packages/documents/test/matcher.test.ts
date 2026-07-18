import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  decideMatch,
  DEFAULT_MATCHER_CONFIG,
  scoreCandidates,
  type CandidateTransaction,
  type ReceiptExtraction,
} from '../src/index.js';

const extraction = (over: Partial<ReceiptExtraction> = {}): ReceiptExtraction => ({
  merchant: 'Blue Bottle Coffee',
  totalMinor: '4217',
  currency: 'USD',
  txnDate: '2026-07-12',
  confidence: 0.95,
  ...over,
});

const candidate = (over: Partial<CandidateTransaction> = {}): CandidateTransaction => ({
  transactionId: '00000000-0000-4000-8000-000000000001',
  amountMinor: '-4217',
  currency: 'USD',
  effectiveDate: '2026-07-14',
  description: 'SQ *BLUE BOTTLE 4421',
  hasConfirmedMatch: false,
  previouslyRejected: false,
  ...over,
});

describe('decideMatch — single suggestion', () => {
  it('exact amount + same day + exact-normalized merchant → suggestion scoring 100', () => {
    // Receipt merchant normalizes to the SAME stem as the descriptor.
    const out = decideMatch(extraction({ merchant: 'Blue Bottle' }), [
      candidate({ effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.candidate.reasonCodes).toContain('AMOUNT_EXACT');
      expect(out.candidate.reasonCodes).toContain('DATE_SAME_DAY');
      expect(out.candidate.reasonCodes).toContain('MERCHANT_EXACT');
      expect(out.candidate.score).toBe(100);
    }
  });

  it('exact amount + same day + FUZZY merchant still suggests (≥75)', () => {
    // "Blue Bottle Coffee" vs descriptor stem "BLUE BOTTLE" → fuzzy, not exact.
    const out = decideMatch(extraction(), [candidate({ effectiveDate: '2026-07-12' })]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.candidate.reasonCodes).toContain('MERCHANT_FUZZY');
      expect(out.candidate.score).toBeGreaterThanOrEqual(75);
    }
  });

  it('settlement lag (T+2) still suggests', () => {
    const out = decideMatch(extraction(), [candidate({ effectiveDate: '2026-07-14' })]);
    expect(out.kind).toBe('suggest');
  });
});

describe('decideMatch — tip range', () => {
  it('a card txn within the tip band + exact merchant is suggested with AMOUNT_TIP_RANGE', () => {
    // receipt 42.17 pre-tip, card 50.00 post-tip (18.6% over, within 25%).
    // Tip amount (30) + same day (25) + exact merchant (25) = 80 ≥ 75.
    const out = decideMatch(extraction({ merchant: 'Blue Bottle' }), [
      candidate({ amountMinor: '-5000', effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.candidate.reasonCodes).toContain('AMOUNT_TIP_RANGE');
    }
  });

  it('a txn UNDER the receipt total is never in the tip band', () => {
    const out = decideMatch(extraction(), [
      candidate({ amountMinor: '-4000', effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('none');
  });

  it('a survivor that clears blocking but scores below the multi floor → none (not multi)', () => {
    // The candidate PASSES every blocking guard (currency ok, T+5 within the
    // 5-day window, amount within the 25% tip band) yet its total score is only
    // tip(30) + far-date(5) = 35, with no merchant signal (unrelated descriptor).
    // 35 < minMultiScore(50), so the matcher offers nothing at all — exercising
    // the score-too-low `none` branch (distinct from the zero-survivor `none`).
    const out = decideMatch(extraction({ merchant: 'Totally Unrelated Vendor' }), [
      candidate({
        amountMinor: '-4900', // ~16% over 4217 → tip band
        effectiveDate: '2026-07-17', // T+5
        description: 'ZZ *NONMATCHING CO 0000',
      }),
    ]);
    expect(out.kind).toBe('none');
    // Proof the candidate really did survive blocking and score in-range.
    const scored = scoreCandidates(extraction({ merchant: 'Totally Unrelated Vendor' }), [
      candidate({
        amountMinor: '-4900',
        effectiveDate: '2026-07-17',
        description: 'ZZ *NONMATCHING CO 0000',
      }),
    ]);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.score).toBe(35);
    expect(scored[0]!.score).toBeLessThan(DEFAULT_MATCHER_CONFIG.minMultiScore);
  });
});

describe('decideMatch — nothing', () => {
  it('amount out of band → no candidate', () => {
    const out = decideMatch(extraction(), [candidate({ amountMinor: '-9999' })]);
    expect(out.kind).toBe('none');
  });

  it('date outside window → no candidate', () => {
    const out = decideMatch(extraction(), [candidate({ effectiveDate: '2026-07-20' })]);
    expect(out.kind).toBe('none');
  });

  it('a receipt date AFTER the txn beyond the before-window drops it', () => {
    // txn is 2 days BEFORE the receipt; window only allows 1 day before.
    const out = decideMatch(extraction({ txnDate: '2026-07-14' }), [
      candidate({ effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('none');
  });

  it('currency mismatch drops the candidate', () => {
    const out = decideMatch(extraction({ currency: 'EUR' }), [candidate()]);
    expect(out.kind).toBe('none');
  });

  it('null extraction total → nothing (no arithmetic on missing money)', () => {
    expect(scoreCandidates(extraction({ totalMinor: null }), [candidate()])).toEqual([]);
    expect(decideMatch(extraction({ totalMinor: null }), [candidate()]).kind).toBe('none');
  });

  it('null extraction date → nothing', () => {
    expect(decideMatch(extraction({ txnDate: null }), [candidate()]).kind).toBe('none');
  });

  it('null extraction currency → nothing', () => {
    expect(decideMatch(extraction({ currency: null }), [candidate()]).kind).toBe('none');
  });
});

describe('decideMatch — multi-candidate', () => {
  it('two close scores → multi list, nothing pre-selected', () => {
    // Same amount + same day, two different merchants → merchant is the only
    // differentiator; if neither matches the merchant, scores tie → multi.
    const out = decideMatch(extraction({ merchant: 'Unknown Vendor' }), [
      candidate({
        transactionId: '00000000-0000-4000-8000-00000000000a',
        description: 'STORE A',
        effectiveDate: '2026-07-12',
      }),
      candidate({
        transactionId: '00000000-0000-4000-8000-00000000000b',
        description: 'STORE B',
        effectiveDate: '2026-07-12',
      }),
    ]);
    expect(out.kind).toBe('multi');
    if (out.kind === 'multi') expect(out.candidates.length).toBe(2);
  });

  it('a clear winner beats a distractor by more than the gap → single suggestion', () => {
    const out = decideMatch(extraction(), [
      candidate({
        transactionId: '00000000-0000-4000-8000-00000000000a',
        description: 'SQ *BLUE BOTTLE 4421',
        effectiveDate: '2026-07-12',
      }),
      candidate({
        transactionId: '00000000-0000-4000-8000-00000000000b',
        description: 'SHELL GAS 88',
        effectiveDate: '2026-07-14',
      }),
    ]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.candidate.transactionId).toBe('00000000-0000-4000-8000-00000000000a');
    }
  });
});

describe('decideMatch — guards', () => {
  it('never suggests a txn with an existing confirmed match', () => {
    const out = decideMatch(extraction(), [
      candidate({ effectiveDate: '2026-07-12', hasConfirmedMatch: true }),
    ]);
    expect(out.kind).toBe('none');
  });

  it('never re-suggests a previously rejected pair', () => {
    const out = decideMatch(extraction(), [
      candidate({ effectiveDate: '2026-07-12', previouslyRejected: true }),
    ]);
    expect(out.kind).toBe('none');
  });
});

describe('decideMatch — sign + null-merchant survivors', () => {
  it('matches a POSITIVE account-side amount (refund/inflow) on absolute value', () => {
    // Candidate amount is positive (e.g. a refund posting); abs-compare still
    // matches the receipt total. Exercises the positive branch of txn abs().
    const out = decideMatch(extraction({ merchant: 'Blue Bottle' }), [
      candidate({ amountMinor: '4217', effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('suggest');
  });

  it('matches when the extracted total itself is negative (abs-compared)', () => {
    // A negative receipt total is still compared on absolute value.
    const out = decideMatch(extraction({ merchant: 'Blue Bottle', totalMinor: '-4217' }), [
      candidate({ amountMinor: '-4217', effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('suggest');
  });

  it('scores a survivor even when the extraction merchant is null (no merchant signal)', () => {
    // Exact amount(50) + same day(25) = 75, merchant null → no merchant points,
    // still a valid single suggestion. Exercises the null-merchant branch.
    const out = decideMatch(extraction({ merchant: null }), [
      candidate({ effectiveDate: '2026-07-12' }),
    ]);
    expect(out.kind).toBe('suggest');
    if (out.kind === 'suggest') {
      expect(out.candidate.score).toBe(75);
      expect(out.candidate.reasonCodes).not.toContain('MERCHANT_EXACT');
      expect(out.candidate.reasonCodes).not.toContain('MERCHANT_FUZZY');
    }
  });

  it('tie-break on equal id compares equal (stable sort, zero comparator)', () => {
    // Two entries with the SAME transactionId, score, and dayGap force the
    // id-equality comparator branch (returns 0). Ranking stays length-2.
    const dupe = candidate({ effectiveDate: '2026-07-12', description: 'SHELL GAS 88' });
    const scored = scoreCandidates(extraction({ merchant: 'Unknown Vendor' }), [dupe, dupe]);
    expect(scored).toHaveLength(2);
    expect(scored[0]!.transactionId).toBe(scored[1]!.transactionId);
    expect(scored[0]!.score).toBe(scored[1]!.score);
  });
});

describe('replay determinism (property)', () => {
  it('identical inputs produce an identical ranking regardless of candidate order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            transactionId: fc.uuid(),
            amountMinor: fc.integer({ min: -6000, max: -3000 }).map((n) => String(n)),
            effectiveDate: fc
              .integer({ min: 11, max: 17 })
              .map((d) => `2026-07-${String(d).padStart(2, '0')}`),
            description: fc.constantFrom('SQ *BLUE BOTTLE', 'SHELL GAS', 'BLUE BOTTLE CO'),
          }),
          { maxLength: 8 },
        ),
        (rows) => {
          const cands: CandidateTransaction[] = rows.map((r) => ({
            ...r,
            currency: 'USD',
            hasConfirmedMatch: false,
            previouslyRejected: false,
          }));
          const a = scoreCandidates(extraction(), cands);
          const shuffled = [...cands].reverse();
          const b = scoreCandidates(extraction(), shuffled);
          expect(a.map((c) => c.transactionId)).toEqual(b.map((c) => c.transactionId));
        },
      ),
    );
  });
});

describe('config', () => {
  it('exposes documented default thresholds', () => {
    expect(DEFAULT_MATCHER_CONFIG.suggestScore).toBe(75);
    expect(DEFAULT_MATCHER_CONFIG.suggestGap).toBe(15);
    expect(DEFAULT_MATCHER_CONFIG.tipToleranceBps).toBe(2500);
  });
});
