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
  it('is the whole transaction amount when nothing is entered', () => {
    expect(splitRemainderMinor('-4300', [{ categoryId: null, amount: '' }])).toBe('-4300');
  });

  it('reaches exactly 0 when rows cover the total', () => {
    // An expense in register signs: both legs negative, summing to the −43 line.
    expect(
      splitRemainderMinor('-4300', [
        { categoryId: CAT_A, amount: '-30' },
        { categoryId: CAT_B, amount: '-13' },
      ]),
    ).toBe('0');
  });

  it('is non-zero while under- or over-allocated', () => {
    expect(splitRemainderMinor('-4300', [{ categoryId: CAT_A, amount: '-30' }])).toBe('-1300');
    expect(splitRemainderMinor('-4300', [{ categoryId: CAT_A, amount: '-50' }])).toBe('700');
  });

  it('ignores rows that do not parse (they block save elsewhere)', () => {
    expect(
      splitRemainderMinor('-4300', [
        { categoryId: CAT_A, amount: '-43' },
        { categoryId: CAT_B, amount: 'oops' },
      ]),
    ).toBe('0');
  });

  it('balances an inflow entered as a positive amount', () => {
    // +cash inflow: money toward you reads positive, like the register.
    expect(splitRemainderMinor('4300', [{ categoryId: CAT_A, amount: '43' }])).toBe('0');
  });

  it('balances a CONTRA / mixed split that nets to the transaction amount', () => {
    // A +$23 reimbursement: $108 coming back to you, less an $85 share you owe.
    expect(
      splitRemainderMinor('2300', [
        { categoryId: CAT_A, amount: '-85' },
        { categoryId: CAT_B, amount: '108' },
      ]),
    ).toBe('0');
  });

  it('stays exact beyond Number precision', () => {
    expect(
      splitRemainderMinor('-9007199254740993', [
        { categoryId: CAT_A, amount: '-90071992547409.93' },
      ]),
    ).toBe('0');
    expect(
      splitRemainderMinor('-9007199254740993', [{ categoryId: CAT_A, amount: '-0.01' }]),
    ).toBe('-9007199254740992');
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
      { categoryId: CAT_A, amount: '-30' },
      { categoryId: CAT_B, amount: '-12.99' },
    ];
    expect(splitsReady('-4300', rows)).toBe(false); // 1 cent short
    expect(buildSplitsPayload('-4300', rows)).toBeNull();
    const exact = [
      { categoryId: CAT_A, amount: '-30' },
      { categoryId: CAT_B, amount: '-13' },
    ];
    expect(splitsReady('-4300', exact)).toBe(true);
  });

  it('emits debit-positive postings from negative register amounts', () => {
    expect(
      buildSplitsPayload('-4300', [
        { categoryId: CAT_A, amount: '-30' },
        { categoryId: CAT_B, amount: '-13' },
      ]),
    ).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '3000' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '1300' },
    ]);
  });

  it('emits a negative credit posting for a positive (income) row', () => {
    expect(buildSplitsPayload('4300', [{ categoryId: CAT_A, amount: '43' }])).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '-4300' },
    ]);
  });

  it('emits a mixed CONTRA split (money back, less a share owed)', () => {
    expect(
      buildSplitsPayload('2300', [
        { categoryId: CAT_A, amount: '-85' }, // out: your share owed
        { categoryId: CAT_B, amount: '108' }, // in: reimbursement
      ]),
    ).toEqual([
      { categoryLedgerAccountId: CAT_A, amountMinor: '8500' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '-10800' },
    ]);
  });

  it('refuses over-allocation and duplicates', () => {
    expect(buildSplitsPayload('-4300', [{ categoryId: CAT_A, amount: '-44' }])).toBeNull();
    expect(
      buildSplitsPayload('-4300', [
        { categoryId: CAT_A, amount: '-21.50' },
        { categoryId: CAT_A, amount: '-21.50' },
      ]),
    ).toBeNull();
  });
});

describe('seeding', () => {
  it('seeds expense postings as NEGATIVE register amounts', () => {
    expect(
      seedRowsFromSplits([
        { categoryLedgerAccountId: CAT_A, amountMinor: '3000' },
        { categoryLedgerAccountId: CAT_B, amountMinor: '1300' },
      ]),
    ).toEqual([
      { categoryId: CAT_A, amount: '-30.00' },
      { categoryId: CAT_B, amount: '-13.00' },
    ]);
  });

  it('seeds an income credit posting as a POSITIVE amount', () => {
    // Nobody earns negative money: a stored −43.00 credit reads +43.00.
    expect(
      seedRowsFromSplits([{ categoryLedgerAccountId: CAT_A, amountMinor: '-4300' }]),
    ).toEqual([{ categoryId: CAT_A, amount: '43.00' }]);
  });

  it('seeds a new split mirroring the line item on row 1 (teardown C7)', () => {
    // Register signs: row 1 is simply the transaction amount as displayed.
    expect(seedRowsForNewSplit('-4300', CAT_A)).toEqual([
      { categoryId: CAT_A, amount: '-43.00' },
      { categoryId: null, amount: '' },
    ]);
    expect(seedRowsForNewSplit('4300', CAT_A)).toEqual([
      { categoryId: CAT_A, amount: '43.00' },
      { categoryId: null, amount: '' },
    ]);
  });

  it('round-trips: seeded rows for a new split start one row short of ready', () => {
    const rows = seedRowsForNewSplit('-4300', CAT_A);
    expect(splitRemainderMinor('-4300', rows)).toBe('0'); // row 1 carries it all
    expect(splitRowsComplete(rows)).toBe(false); // row 2 still empty
  });
});

// --- The paycheck that started this (2026-08-28 Mercorio) ----------------
describe('a paycheck reads like a payslip', () => {
  const GROSS = 'cccccccc-0000-4000-8000-000000000003';

  const rows = [
    { categoryId: GROSS, amount: '1992.18' }, // earned
    { categoryId: CAT_A, amount: '-268.47' }, // federal withheld
    { categoryId: CAT_B, amount: '-334.38' }, // everything else withheld
  ];

  it('sums the displayed lines to the net line item', () => {
    // 1992.18 − 602.85 = 1389.33, the transaction amount. Nothing is negative
    // income; the taxes are the outflows.
    expect(splitRemainderMinor('138933', rows)).toBe('0');
    expect(splitsReady('138933', rows)).toBe(true);
  });

  it('still stores debit-positive postings the server accepts', () => {
    expect(buildSplitsPayload('138933', rows)).toEqual([
      { categoryLedgerAccountId: GROSS, amountMinor: '-199218' },
      { categoryLedgerAccountId: CAT_A, amountMinor: '26847' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '33438' },
    ]);
  });

  it('round-trips stored postings back to the same postings', () => {
    const stored = [
      { categoryLedgerAccountId: GROSS, amountMinor: '-199218' },
      { categoryLedgerAccountId: CAT_A, amountMinor: '26847' },
      { categoryLedgerAccountId: CAT_B, amountMinor: '33438' },
    ];
    expect(seedRowsFromSplits(stored)[0]?.amount).toBe('1992.18'); // gross, positive
    expect(buildSplitsPayload('138933', seedRowsFromSplits(stored))).toEqual(stored);
  });
});
