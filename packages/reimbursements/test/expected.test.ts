import { describe, expect, it } from 'vitest';
import { reconcileExpected, EXPECTED_REIMBURSEMENT_FORMULA_VERSION } from '../src/index.js';

describe('reconcileExpected — expected/future-dated reimbursement AR math', () => {
  it('a freshly created expectation with no receipts is fully open', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'open',
      receipts: [],
    });
    expect(out).toMatchObject({
      remainingMinor: '15000',
      allocatedMinor: '0',
      fullyCovered: false,
      incomeImpactMinor: '0',
      effectiveStatus: 'open',
      violations: [],
    });
  });

  it('a partial receipt leaves a remainder still open (the "not fully arrived" path)', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'open',
      receipts: [{ receiptId: 'r1', allocatedMinor: '5000', status: 'active' }],
    });
    expect(out.remainingMinor).toBe('10000');
    expect(out.fullyCovered).toBe(false);
    expect(out.effectiveStatus).toBe('open');
    expect(out.incomeImpactMinor).toBe('0');
  });

  it('receipts summing to the full expected amount settle it to received', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'received',
      receipts: [
        { receiptId: 'r1', allocatedMinor: '5000', status: 'active' },
        { receiptId: 'r2', allocatedMinor: '10000', status: 'active' },
      ],
    });
    expect(out.remainingMinor).toBe('0');
    expect(out.fullyCovered).toBe(true);
    expect(out.effectiveStatus).toBe('received');
    expect(out.incomeImpactMinor).toBe('0');
  });

  it('a reversed receipt no longer counts — the remainder reopens', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'open',
      receipts: [
        { receiptId: 'r1', allocatedMinor: '15000', status: 'reversed' },
        { receiptId: 'r2', allocatedMinor: '5000', status: 'active' },
      ],
    });
    expect(out.remainingMinor).toBe('10000');
    expect(out.effectiveStatus).toBe('open');
  });

  it('never-arrives → written off: stays written off, income impact 0, no remainder claimed as received', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'written_off',
      receipts: [],
    });
    expect(out.remainingMinor).toBe('15000');
    expect(out.effectiveStatus).toBe('written_off');
    expect(out.fullyCovered).toBe(false);
    expect(out.violations).toEqual([]);
  });

  it('flags over-allocation (receipts exceed the expected amount)', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'open',
      receipts: [{ receiptId: 'r1', allocatedMinor: '20000', status: 'active' }],
    });
    expect(out.violations).toContainEqual({
      code: 'expected_overallocated',
      expectedId: 'e1',
      expectedMinor: '15000',
      allocatedMinor: '20000',
    });
    // remaining still clamps at zero (never negative)
    expect(out.remainingMinor).toBe('0');
  });

  it('flags an active receipt sitting on a written-off expectation', () => {
    const out = reconcileExpected({
      expectedId: 'e1',
      expectedMinor: '15000',
      status: 'written_off',
      receipts: [{ receiptId: 'r1', allocatedMinor: '5000', status: 'active' }],
    });
    expect(out.violations).toContainEqual({
      code: 'receipt_on_written_off',
      expectedId: 'e1',
      allocatedMinor: '5000',
    });
  });

  it('rejects malformed money and duplicate/empty receipt ids', () => {
    expect(() =>
      reconcileExpected({ expectedId: 'e1', expectedMinor: '-1', status: 'open', receipts: [] }),
    ).toThrow(RangeError);
    expect(() =>
      reconcileExpected({ expectedId: 'e1', expectedMinor: '0', status: 'open', receipts: [] }),
    ).toThrow(RangeError);
    expect(() =>
      reconcileExpected({
        expectedId: 'e1',
        expectedMinor: '100',
        status: 'open',
        receipts: [
          { receiptId: 'dup', allocatedMinor: '10', status: 'active' },
          { receiptId: 'dup', allocatedMinor: '10', status: 'active' },
        ],
      }),
    ).toThrow(RangeError);
  });

  it('exposes the formula version the DB list proc stamps', () => {
    expect(EXPECTED_REIMBURSEMENT_FORMULA_VERSION).toBe('expected-reimbursement-v1');
  });
});
