import { describe, expect, it } from 'vitest';

import {
  buildSplitsPayload,
  hasDuplicateCategories,
  magnitudeMinor,
  parseSplitAmount,
  seedRowsForNewSplit,
  seedRowsFromSplits,
  splitRemainderMinor,
  splitRowsComplete,
  splitsReady,
} from './split-editor';

const CAT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAT_B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('parseSplitAmount', () => {
  it('parses plain dollars and cents into minor units', () => {
    expect(parseSplitAmount('12.34')).toBe('1234');
    expect(parseSplitAmount('12')).toBe('1200');
    expect(parseSplitAmount('0.5')).toBe('50');
    expect(parseSplitAmount('.5')).toBe('50');
    expect(parseSplitAmount('0.05')).toBe('5');
  });

  it('accepts a NEGATIVE amount (a refund / reimbursement credit leg)', () => {
    expect(parseSplitAmount('-5')).toBe('-500');
    expect(parseSplitAmount('-55.83')).toBe('-5583');
  });

  it('tolerates currency formatting the house parser accepts', () => {
    expect(parseSplitAmount('$1,234.56')).toBe('123456');
    expect(parseSplitAmount(' 43.00 ')).toBe('4300');
  });

  it('rejects blanks, zero, and junk', () => {
    expect(parseSplitAmount('')).toBeNull();
    expect(parseSplitAmount('   ')).toBeNull();
    expect(parseSplitAmount('0')).toBeNull();
    expect(parseSplitAmount('0.00')).toBeNull();
    expect(parseSplitAmount('abc')).toBeNull();
    expect(parseSplitAmount('1.234')).toBeNull(); // three decimals
    expect(parseSplitAmount('1.2.3')).toBeNull();
  });

  it('handles amounts past Number safe-integer range exactly (BigInt)', () => {
    // 2^53 = 9007199254740992 cents; one more cent must survive round-trip.
    expect(parseSplitAmount('90071992547409.93')).toBe('9007199254740993');
  });
});

describe('magnitudeMinor', () => {
  it('strips the sign only', () => {
    expect(magnitudeMinor('-4300')).toBe('4300');
    expect(magnitudeMinor('4300')).toBe('4300');
  });
});

describe('splitRemainderMinor', () => {
  it('is the full offset (−cash) when nothing is entered', () => {
    expect(splitRemainderMinor('-4300', [{ categoryId: null, amount: '' }])).toBe('4300');
  });

  it('reaches exactly 0 when rows cover the total', () => {
    expect(
      splitRemainderMinor('-4300', [
        { categoryId: CAT_A, amount: '30' },
        { categoryId: CAT_B, amount: '13' },
      ]),
    ).toBe('0');
  });

  it('is positive while under-allocated and negative when over-allocated', () => {
    expect(splitRemainderMinor('-4300', [{ categoryId: CAT_A, amount: '30' }])).toBe('1300');
    expect(splitRemainderMinor('-4300', [{ categoryId: CAT_A, amount: '50' }])).toBe('-700');
  });

  it('ignores rows that do not parse (they block save elsewhere)', () => {
    expect(
      splitRemainderMinor('-4300', [
        { categoryId: CAT_A, amount: '43' },
        { categoryId: CAT_B, amount: 'oops' },
      ]),
    ).toBe('0');
  });

  it('balances an income split with a signed (credit) entry', () => {
    // +cash inflow: the category leg is a credit, entered negative.
    expect(splitRemainderMinor('4300', [{ categoryId: CAT_A, amount: '-43' }])).toBe('0');
  });

  it('balances a CONTRA / mixed split that nets to −cash', () => {
    // A +$23 reimbursement: +$85 owed (debit) plus credits netting to −$23.
    expect(
      splitRemainderMinor('2300', [
        { categoryId: CAT_A, amount: '85' },
        { categoryId: CAT_B, amount: '-108' },
      ]),
    ).toBe('0');
  });

  it('stays exact beyond Number precision', () => {
    expect(
      splitRemainderMinor('-9007199254740993', [
        { categoryId: CAT_A, amount: '90071992547409.93' },
      ]),
    ).toBe('0');
    expect(
      splitRemainderMinor('-9007199254740993', [{ categoryId: CAT_A, amount: '0.01' }]),
    ).toBe('9007199254740992');
  });
});

describe('row completeness + duplicates', () => {
  it('flags duplicate categories', () => {
    expect(
      hasDuplicateCategories([
        { categoryId: CAT_A, amount: '1' },
        { categoryId: CAT_A, amount: '2' },
      ]),
    ).toBe(true);
    expect(
      hasDuplicateCategories([
        { categoryId: CAT_A, amount: '1' },
        { categoryId: CAT_B, amount: '2' },
        { categoryId: null, amount: '' },
      ]),
    ).toBe(false);
  });

  it('requires a category and a valid amount on every row', () => {
    expect(splitRowsComplete([])).toBe(false);
    expect(splitRowsComplete([{ categoryId: null, amount: '10' }])).toBe(false);
    expect(splitRowsComplete([{ categoryId: CAT_A, amount: '' }])).toBe(false);
    expect(splitRowsComplete([{ categoryId: CAT_A, amount: '10' }])).toBe(true);
    expect(splitRowsComplete([{ categoryId: CAT_A, amount: '-10' }])).toBe(true); // credit leg
    expect(
      splitRowsComplete([
        { categoryId: CAT_A, amount: '10' },
        { categoryId: CAT_A, amount: '5' },
      ]),
    ).toBe(false); // duplicate category
  });
});

describe('splitsReady + buildSplitsPayload', () => {
  it('is ready only at remainder exactly 0 (Σ=0 as UI)', () => {
    const rows = [
      { categoryId: CAT_A, amount: '30' },
      { categoryId: CAT_B, amount: '12.99' },
    ];
    expect(splitsReady('-4300', rows)).toBe(false); // 1 cent short
    expect(buildSplitsPayload('-4300', rows)).toBeNull();
    const exact = [
      { categoryId: CAT_A, amount: '30' },
      { categoryId: CAT_B, amount: '13' },
    ];
    expect(splitsReady('-4300', exact)).toBe(true);
  });

  it('emits debit-positive offsets for an expense (negative cash)', () => {
    expect(
      buildSplitsPayload('-4300', [
        { categoryId: CAT_A, amount: '30' },
        { categoryId: CAT_B, amount: '13' },
      ]),
    ).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '3000' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '1300' },
    ]);
  });

  it('emits the signed amount for an income credit leg', () => {
    expect(buildSplitsPayload('4300', [{ categoryId: CAT_A, amount: '-43' }])).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '-4300' },
    ]);
  });

  it('emits a mixed CONTRA split exactly as signed (refund + owed)', () => {
    expect(
      buildSplitsPayload('2300', [
        { categoryId: CAT_A, amount: '85' }, // debit: your share owed
        { categoryId: CAT_B, amount: '-108' }, // credit: net reimbursement
      ]),
    ).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '8500' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '-10800' },
    ]);
  });

  it('refuses over-allocation and duplicates', () => {
    expect(buildSplitsPayload('-4300', [{ categoryId: CAT_A, amount: '44' }])).toBeNull();
    expect(
      buildSplitsPayload('-4300', [
        { categoryId: CAT_A, amount: '21.50' },
        { categoryId: CAT_A, amount: '21.50' },
      ]),
    ).toBeNull();
  });
});

describe('seeding', () => {
  it('seeds editor rows from read-model splits, preserving sign', () => {
    expect(
      seedRowsFromSplits([
        { categoryLedgerAccountId: CAT_A, amountMinor: '3000' },
        { categoryLedgerAccountId: CAT_B, amountMinor: '1300' },
      ]),
    ).toEqual([
      { categoryId: CAT_A, amount: '30.00' },
      { categoryId: CAT_B, amount: '13.00' },
    ]);
  });

  it('seeds a credit leg (negative offset) as a NEGATIVE amount', () => {
    expect(
      seedRowsFromSplits([{ categoryLedgerAccountId: CAT_A, amountMinor: '-4300' }]),
    ).toEqual([{ categoryId: CAT_A, amount: '-43.00' }]);
  });

  it('seeds a new split with the full offset on row 1 (teardown C7)', () => {
    // Expense (cash −4300) → +43.00 debit; inflow (cash +4300) → −43.00 credit.
    expect(seedRowsForNewSplit('-4300', CAT_A)).toEqual([
      { categoryId: CAT_A, amount: '43.00' },
      { categoryId: null, amount: '' },
    ]);
    expect(seedRowsForNewSplit('4300', CAT_A)).toEqual([
      { categoryId: CAT_A, amount: '-43.00' },
      { categoryId: null, amount: '' },
    ]);
  });

  it('round-trips: seeded rows for a new split start one row short of ready', () => {
    const rows = seedRowsForNewSplit('-4300', CAT_A);
    expect(splitRemainderMinor('-4300', rows)).toBe('0'); // row 1 carries it all
    expect(splitRowsComplete(rows)).toBe(false); // row 2 still empty
  });
});
