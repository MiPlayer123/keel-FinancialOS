import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  addGregorianMonths,
  backtest,
  cadenceDatesBetween,
  detectRecurringSeries,
  epochDayToCivilDate,
  daysInMonth,
  projectOccurrences,
  statusOnDate,
  type DetectedSeries,
  type RecurringSeries,
  type RecurringStatusEvent,
  type RecurringTransaction,
} from '../src/index.js';

const txn = (
  id: string,
  date: string,
  amount = '-1000',
  description = 'Coverage Merchant',
  overrides: Partial<RecurringTransaction> = {},
): RecurringTransaction => ({
  txnId: id,
  batchId: `batch-${id}`,
  postingId: `posting-${id}`,
  accountId: 'account-coverage',
  ledgerAccountId: 'ledger-coverage',
  effectiveDate: date,
  amountMinor: amount,
  currency: 'USD',
  description,
  ...overrides,
});

const event = (
  transition: RecurringStatusEvent['transition'],
  effectiveDate: string,
  createdAt = `${effectiveDate}T12:00:00Z`,
  commandId = `${transition}-${effectiveDate}`,
): RecurringStatusEvent => ({ transition, effectiveDate, createdAt, commandId, actorId: 'user' });

const candidate = (): DetectedSeries => detectRecurringSeries([
  txn('m1', '2024-01-31'), txn('m2', '2024-02-29'), txn('m3', '2024-03-31'),
], { asOf: '2024-03-31' })[0]!;

const confirmed = (base = candidate()): RecurringSeries => ({
  ...base,
  status: 'confirmed',
  candidateVersionHash: base.inputFingerprint,
  statusEvents: [event('confirmed', '2024-01-01')],
});

describe('defensive civil-date branches', () => {
  it.each([
    () => epochDayToCivilDate(1.5),
    () => epochDayToCivilDate(Number.MAX_SAFE_INTEGER),
    () => addCivilDays('2024-01-01', Number.MAX_SAFE_INTEGER),
    () => addGregorianMonths('2024-01-01', 1.5),
    () => addGregorianMonths('0001-01-01', -1),
    () => addGregorianMonths('9999-12-31', 1),
  ])('rejects unsafe civil arithmetic', (operation) => {
    expect(operation).toThrow(RangeError);
  });

  it.each([[0, 1], [10000, 1], [2024, 0], [2024, 13], [2024.5, 1], [2024, 1.5]])(
    'rejects unsupported year/month pair %s/%s',
    (year, month) => {
      expect(() => daysInMonth(year, month)).toThrow(RangeError);
    },
  );
});

describe('cadence grids beyond the core matrix', () => {
  it('generates inclusive weekly, quarterly, annual, semimonthly, and empty ranges', () => {
    expect(cadenceDatesBetween(
      { kind: 'epoch_grid', intervalDays: 7, anchorEpochDay: 19723 },
      '2024-01-01', '2024-01-15',
    )).toEqual(['2024-01-01', '2024-01-08', '2024-01-15']);
    expect(cadenceDatesBetween(
      { kind: 'day_of_month', day: 31, intervalMonths: 3, phase: 0 },
      '2024-01-01', '2024-12-31',
    )).toEqual(['2024-01-31', '2024-04-30', '2024-07-31', '2024-10-31']);
    expect(cadenceDatesBetween(
      { kind: 'day_of_month', day: 29, intervalMonths: 12, phase: 1 },
      '2023-01-01', '2025-12-31',
    )).toEqual(['2023-02-28', '2024-02-29', '2025-02-28']);
    expect(cadenceDatesBetween(
      { kind: 'day_pair', days: [29, 31] },
      '2024-02-01', '2024-02-29',
    )).toEqual(['2024-02-29']);
    expect(cadenceDatesBetween(
      { kind: 'day_pair', days: [1, 15] }, '2024-02-02', '2024-02-01',
    )).toEqual([]);
  });

  it.each([
    ['weekly', ['2024-01-01', '2024-01-08', '2024-01-15']],
    ['quarterly', ['2024-01-31', '2024-04-30', '2024-07-31']],
    ['annual', ['2022-02-28', '2023-02-28', '2024-02-29']],
  ] as const)('detects %s calendar grids', (cadence, dates) => {
    const result = detectRecurringSeries(
      dates.map((date, index) => txn(`${cadence}-${index.toString()}`, date)),
      { asOf: dates.at(-1)! },
    );
    expect(result[0]?.cadence).toBe(cadence);
  });
});

describe('detector validation and filtering', () => {
  it('bounds the historical detection span relative to the run as-of date', () => {
    expect(detectRecurringSeries([
      txn('old-1', '2024-01-31'),
      txn('old-2', '2024-02-29'),
      txn('old-3', '2024-03-31'),
    ], { asOf: '2035-01-01' })).toEqual([]);
    expect(() => detectRecurringSeries(
      Array.from({ length: 10_001 }, (_unused, index) =>
        txn(`bounded-${index.toString()}`, '2024-01-01')),
      { asOf: '2024-01-01' },
    )).toThrow(RangeError);
  });

  it.each(['', '0', '00', '01', '-0', '1.0', '1e2'])('rejects amount wire %j', (amountMinor) => {
    expect(() => detectRecurringSeries([txn('bad', '2024-01-01', amountMinor)], {
      asOf: '2024-01-01',
    })).toThrow(RangeError);
  });

  it.each(['txnId', 'batchId', 'postingId', 'accountId', 'ledgerAccountId', 'currency'] as const)(
    'rejects empty %s',
    (field) => {
      expect(() => detectRecurringSeries([
        txn('bad', '2024-01-01', '-1', 'Merchant', { [field]: '' }),
      ], { asOf: '2024-01-01' })).toThrow(RangeError);
    },
  );

  it('validates asOf, excludes future rows, accepts explicit counterparty keys, and tolerates noise', () => {
    expect(() => detectRecurringSeries([], { asOf: 'bad' })).toThrow(RangeError);
    expect(detectRecurringSeries([
      txn('f1', '2024-01-01', '-1', 'one', { counterpartyKey: ' Explicit ' }),
      txn('f2', '2024-01-08', '-1', 'two', { counterpartyKey: ' Explicit ' }),
      txn('f3', '2024-01-15', '-1', 'three', { counterpartyKey: ' Explicit ' }),
      txn('future', '2025-01-01', '-1', 'four', { counterpartyKey: ' Explicit ' }),
      txn('noise', '2024-01-02', '-2', 'unrelated'),
    ], { asOf: '2024-01-31' })[0]?.counterpartyKey).toBe('explicit');
  });

  it('pins detector transaction-id and amount ordering ties', () => {
    expect(detectRecurringSeries([
      txn('same-z', '2024-01-01'), txn('same-a', '2024-01-01'),
      txn('same-2', '2024-01-08'), txn('same-3', '2024-01-15'),
    ], { asOf: '2024-01-15' })[0]?.evidence[0]?.txnId).toBe('same-a');

    const twoAmounts = detectRecurringSeries([
      txn('low-1', '2024-01-10', '-1599'), txn('high-1', '2024-01-10', '-999'),
      txn('low-2', '2024-02-10', '-1599'), txn('high-2', '2024-02-10', '-999'),
      txn('low-3', '2024-03-10', '-1599'), txn('high-3', '2024-03-10', '-999'),
    ], { asOf: '2024-03-10' });
    expect(twoAmounts.map((row) => row.representativeAmountMinor)).toEqual(['-1599', '-999']);
  });
});

describe('timeline and projection defensive branches', () => {
  it('replays every transition and deterministic same-day ordering', () => {
    const events = [
      event('suggested', '2024-01-01'),
      event('confirmed', '2024-01-02'),
      event('paused', '2024-01-03'),
      event('resumed', '2024-01-04'),
      event('cancelled', '2024-01-05', '2024-01-05T10:00:00Z', 'b'),
      event('rejected', '2024-01-05', '2024-01-05T10:00:00Z', 'c'),
    ];
    expect(statusOnDate(events, '2023-12-31')).toBe('suggested');
    expect(statusOnDate(events, '2024-01-02')).toBe('confirmed');
    expect(statusOnDate(events, '2024-01-03')).toBe('paused');
    expect(statusOnDate(events, '2024-01-04')).toBe('confirmed');
    expect(statusOnDate(events, '2024-01-05')).toBe('cancelled');
    expect(statusOnDate([
      event('confirmed', '2024-01-01'),
      event('cancelled', '2024-01-02'),
      event('resumed', '2024-01-03'),
    ], '2024-01-03')).toBe('cancelled');
    expect(statusOnDate([
      event('confirmed', '2024-01-01'),
      event('cancelled', '2024-01-02'),
      event('confirmed', '2024-01-03'),
    ], '2024-01-03')).toBe('confirmed');
  });

  it('rejects invalid horizons and missing fixed amount, and suppresses rejected state', () => {
    const base = confirmed();
    expect(() => projectOccurrences(base, { asOf: '2024-03-31', horizonDays: -1 })).toThrow(RangeError);
    expect(() => projectOccurrences(base, { asOf: '2024-03-31', horizonDays: 1.5 })).toThrow(RangeError);
    expect(projectOccurrences({ ...base, status: 'rejected' }, {
      asOf: '2024-03-31', horizonDays: 31,
    })).toEqual([]);
    expect(() => projectOccurrences({ ...base, representativeAmountMinor: null }, {
      asOf: '2024-03-31', horizonDays: 31,
    })).toThrow(RangeError);
  });
});

describe('backtest rejection and default branches', () => {
  it('uses default ranges for empty actuals and rejects every mismatched key/amount branch', () => {
    const series = confirmed();
    expect(backtest(series, []).skipped).toHaveLength(1);
    const mismatches = [
      txn('counterparty', '2024-01-31', '-1000', 'Other'),
      txn('account', '2024-01-31', '-1000', 'Coverage Merchant', { accountId: 'other' }),
      txn('ledger', '2024-01-31', '-1000', 'Coverage Merchant', { ledgerAccountId: 'other' }),
      txn('currency', '2024-01-31', '-1000', 'Coverage Merchant', { currency: 'EUR' }),
      txn('sign', '2024-01-31', '1000'),
      txn('amount', '2024-01-31', '-999'),
      txn('date', '2024-01-20'),
    ];
    const result = backtest(series, mismatches, { fromDate: '2024-01-01', toDate: '2024-01-31' });
    expect(result.matched).toEqual([]);
    expect(result.unexpected).toHaveLength(mismatches.length);
  });

  it('rejects a fixed series with no amount and exhausts deterministic pair tie-breaks', () => {
    const series = confirmed();
    expect(() => backtest({ ...series, representativeAmountMinor: null }, [
      txn('actual', '2024-01-31'),
    ], { fromDate: '2024-01-01', toDate: '2024-01-31' })).toThrow(RangeError);

    const sameDay = backtest(series, [
      txn('z', '2024-01-31'), txn('a', '2024-01-31'),
    ], { fromDate: '2024-01-01', toDate: '2024-01-31' });
    expect(sameDay.matched[0]?.txnId).toBe('a');

    const closeAnchors: RecurringSeries = {
      ...series,
      cadence: 'semimonthly',
      cadenceAnchor: { kind: 'day_pair', days: [1, 3] },
    };
    expect(backtest(closeAnchors, [txn('middle', '2024-01-02')], {
      fromDate: '2024-01-01', toDate: '2024-01-03',
    }).matched[0]?.expectedDate).toBe('2024-01-01');
  });

  it('covers quarterly/annual tolerances, explicit counterparty, and variable bounds', () => {
    const quarterlyBase = detectRecurringSeries([
      txn('q1', '2024-01-31'), txn('q2', '2024-04-30'), txn('q3', '2024-07-31'),
    ], { asOf: '2024-07-31' })[0]!;
    const quarterly = confirmed(quarterlyBase);
    const quarterlyResult = backtest(quarterly, [
      txn('q-actual', '2024-02-05', '-1000', 'ignored', { counterpartyKey: 'coverage merchant' }),
    ], { fromDate: '2024-01-01', toDate: '2024-02-10' });
    expect(quarterlyResult.matched).toHaveLength(1);

    const annualBase = detectRecurringSeries([
      txn('a1', '2022-02-28'), txn('a2', '2023-02-28'), txn('a3', '2024-02-29'),
    ], { asOf: '2024-02-29' })[0]!;
    const annual: RecurringSeries = {
      ...annualBase,
      status: 'confirmed',
      candidateVersionHash: annualBase.inputFingerprint,
      statusEvents: [event('confirmed', '2022-01-01')],
    };
    expect(backtest(annual, [txn('annual-actual', '2022-03-07')], {
      fromDate: '2022-01-01', toDate: '2022-03-10',
    }).matched).toHaveLength(1);

    const variableBase = detectRecurringSeries([
      txn('v1', '2024-01-15', '-900'),
      txn('v2', '2024-02-15', '-1000'),
      txn('v3', '2024-03-15', '-1100'),
    ], { asOf: '2024-03-15' })[0]!;
    const variable = confirmed(variableBase);
    const variableResult = backtest(variable, [
      txn('below', '2024-01-15', '-1101'),
      txn('inside', '2024-02-15', '-950'),
      txn('above', '2024-03-15', '-899'),
    ], { fromDate: '2024-01-01', toDate: '2024-03-31' });
    expect(variableResult.matched.map((row) => row.txnId)).toEqual(['inside']);
  });
});
