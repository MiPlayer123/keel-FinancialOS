import { describe, expect, it } from 'vitest';
import {
  DETECTOR_VERSION,
  NORMALIZER_VERSION,
  detectRecurringSeries,
  normalizeCounterparty,
  type RecurringTransaction,
} from '../src/index.js';

const txn = (
  txnId: string,
  effectiveDate: string,
  amountMinor: string,
  description = 'Acme Rent Store #123 2026-01-31',
  overrides: Partial<RecurringTransaction> = {},
): RecurringTransaction => ({
  txnId,
  batchId: `batch-${txnId}`,
  postingId: `posting-${txnId}`,
  accountId: 'account-1',
  ledgerAccountId: 'ledger-1',
  effectiveDate,
  amountMinor,
  currency: 'USD',
  description,
  ...overrides,
});

describe('counterparty normalization', () => {
  it('is deterministic and removes store/date/trailing-number noise', () => {
    expect(normalizeCounterparty('  ACME  RENT store #123 2026-01-31  ')).toBe('acme rent');
    expect(normalizeCounterparty('NETFLIX 0042')).toBe('netflix');
    expect(normalizeCounterparty('')).toBe('unknown');
    expect(NORMALIZER_VERSION).toBe('counterparty-v1');
  });
});

describe('detectRecurringSeries calendar-grid fitting', () => {
  it('detects fixed month-end rent and treats a skipped month as a missing slot', () => {
    const series = detectRecurringSeries(
      [
        txn('rent-1', '2024-01-31', '-250000'),
        txn('rent-2', '2024-02-29', '-250000'),
        txn('rent-3', '2024-03-31', '-250000'),
        txn('rent-4', '2024-05-31', '-250000'),
      ],
      { asOf: '2024-05-31' },
    );

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'monthly',
      cadenceAnchor: { kind: 'day_of_month', day: 31, intervalMonths: 1 },
      amountKind: 'fixed',
      representativeAmountMinor: '-250000',
      occurrenceCount: 4,
      coverage: { matchedSlots: 4, totalSlots: 5 },
      detectorVersion: DETECTOR_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      asOf: '2024-05-31',
      requiresApproval: true,
    });
    expect(series[0]?.evidence).toEqual([
      { txnId: 'rent-1', batchId: 'batch-rent-1', postingId: 'posting-rent-1' },
      { txnId: 'rent-2', batchId: 'batch-rent-2', postingId: 'posting-rent-2' },
      { txnId: 'rent-3', batchId: 'batch-rent-3', postingId: 'posting-rent-3' },
      { txnId: 'rent-4', batchId: 'batch-rent-4', postingId: 'posting-rent-4' },
    ]);
    expect(Number.isInteger(series[0]?.scoreBps)).toBe(true);
    expect(series[0]?.scoreBps).toBeGreaterThan(0);
  });

  it('detects strict biweekly paychecks on an epoch-day grid', () => {
    const series = detectRecurringSeries(
      [
        txn('pay-1', '2024-01-05', '200000', 'KEEL PAYROLL'),
        txn('pay-2', '2024-01-19', '200000', 'KEEL PAYROLL'),
        txn('pay-3', '2024-02-02', '200000', 'KEEL PAYROLL'),
        txn('pay-4', '2024-02-16', '200000', 'KEEL PAYROLL'),
      ],
      { asOf: '2024-02-16' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'biweekly',
      cadenceAnchor: { kind: 'epoch_grid', intervalDays: 14 },
      amountKind: 'fixed',
      occurrenceCount: 4,
    });
  });

  it('classifies monthly utility amounts as variable using exact lower-median evidence', () => {
    const series = detectRecurringSeries(
      [
        txn('util-1', '2024-01-15', '-9100', 'City Utilities'),
        txn('util-2', '2024-02-15', '-10500', 'City Utilities'),
        txn('util-3', '2024-03-15', '-9900', 'City Utilities'),
        txn('util-4', '2024-04-15', '-11200', 'City Utilities'),
      ],
      { asOf: '2024-04-15' },
    );
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      cadence: 'monthly',
      amountKind: 'variable',
      representativeAmountMinor: null,
      amountSummary: {
        minMinor: '-11200',
        maxMinor: '-9100',
        lowerMedianMinor: '-10500',
        squaredResidualSum: '2810000',
        count: 4,
      },
    });
  });

  it('emits multiple fixed monthly clusters for duplicate subscriptions in one group', () => {
    const input = [
      txn('sub-a1', '2024-01-05', '-999', 'Video Stream'),
      txn('sub-b1', '2024-01-20', '-1599', 'Video Stream'),
      txn('sub-a2', '2024-02-05', '-999', 'Video Stream'),
      txn('sub-b2', '2024-02-20', '-1599', 'Video Stream'),
      txn('sub-a3', '2024-03-05', '-999', 'Video Stream'),
      txn('sub-b3', '2024-03-20', '-1599', 'Video Stream'),
    ];
    const series = detectRecurringSeries(input, { asOf: '2024-03-20' });
    expect(series).toHaveLength(2);
    expect(series.map((candidate) => [candidate.cadence, candidate.representativeAmountMinor]))
      .toEqual([
        ['monthly', '-1599'],
        ['monthly', '-999'],
      ]);
  });

  it('distinguishes a semimonthly anchor pair from a strict biweekly grid', () => {
    const semimonthly = detectRecurringSeries(
      [
        txn('semi-1', '2024-01-01', '-5000', 'Club Dues'),
        txn('semi-2', '2024-01-15', '-5000', 'Club Dues'),
        txn('semi-3', '2024-02-01', '-5000', 'Club Dues'),
        txn('semi-4', '2024-02-15', '-5000', 'Club Dues'),
        txn('semi-5', '2024-03-01', '-5000', 'Club Dues'),
        txn('semi-6', '2024-03-15', '-5000', 'Club Dues'),
      ],
      { asOf: '2024-03-15' },
    );
    expect(semimonthly[0]).toMatchObject({
      cadence: 'semimonthly',
      cadenceAnchor: { kind: 'day_pair', days: [1, 15] },
    });

    const biweekly = detectRecurringSeries(
      [
        txn('bi-1', '2024-01-01', '-5000', 'Club Dues'),
        txn('bi-2', '2024-01-15', '-5000', 'Club Dues'),
        txn('bi-3', '2024-01-29', '-5000', 'Club Dues'),
        txn('bi-4', '2024-02-12', '-5000', 'Club Dues'),
        txn('bi-5', '2024-02-26', '-5000', 'Club Dues'),
      ],
      { asOf: '2024-02-26' },
    );
    expect(biweekly[0]?.cadence).toBe('biweekly');
  });

  it('groups by account, sign, currency, and normalizer version', () => {
    const base = [
      txn('a-1', '2024-01-10', '-1000', 'Membership'),
      txn('a-2', '2024-02-10', '-1000', 'Membership'),
      txn('a-3', '2024-03-10', '-1000', 'Membership'),
      txn('b-1', '2024-01-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
      txn('b-2', '2024-02-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
      txn('b-3', '2024-03-10', '-1000', 'Membership', { accountId: 'account-2', ledgerAccountId: 'ledger-2' }),
    ];
    expect(detectRecurringSeries(base, { asOf: '2024-03-10' })).toHaveLength(2);
  });

  it('returns no series for empty or insufficient inputs', () => {
    expect(detectRecurringSeries([], { asOf: '2024-01-01' })).toEqual([]);
    expect(detectRecurringSeries([
      txn('one', '2024-01-01', '-1'),
      txn('two', '2024-02-01', '-1'),
    ], { asOf: '2024-02-01' })).toEqual([]);
  });

  it('pins deterministic output, ordering, evidence ties, and fingerprints', () => {
    const input = [
      txn('z', '2024-03-10', '-1000', 'Membership'),
      txn('a', '2024-01-10', '-1000', 'Membership'),
      txn('m', '2024-02-10', '-1000', 'Membership'),
    ];
    const first = detectRecurringSeries(input, { asOf: '2024-03-10' });
    const second = detectRecurringSeries([...input].reverse(), { asOf: '2024-03-10' });
    expect(second).toEqual(first);
    expect(first[0]?.evidence.map((item) => item.txnId)).toEqual(['a', 'm', 'z']);
    expect(first[0]?.inputFingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(first[0]?.seriesKey).toMatch(/^[a-f0-9]{16}$/u);
  });

  it('binds candidate identity to the run-wide as-of date', () => {
    const input = [
      txn('rent-1', '2024-01-31', '-250000'),
      txn('rent-2', '2024-02-29', '-250000'),
      txn('rent-3', '2024-03-31', '-250000'),
    ];
    const first = detectRecurringSeries(input, { asOf: '2024-03-31' })[0];
    const replayAtLaterAsOf = detectRecurringSeries(input, { asOf: '2024-04-01' })[0];

    expect(first?.inputFingerprint).not.toBe(replayAtLaterAsOf?.inputFingerprint);
  });
});
