import { describe, expect, it } from 'vitest';
import {
  backtest,
  detectRecurringSeries,
  projectOccurrences,
  type DetectedSeries,
  type RecurringSeries,
  type RecurringStatusEvent,
  type RecurringTransaction,
} from '../src/index.js';

const txn = (
  txnId: string,
  effectiveDate: string,
  amountMinor: string,
  description = 'Monthly Rent',
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
});

const detected = (
  rows: readonly RecurringTransaction[] = [
    txn('evidence-1', '2024-01-31', '-250000'),
    txn('evidence-2', '2024-02-29', '-250000'),
    txn('evidence-3', '2024-03-31', '-250000'),
  ],
): DetectedSeries => detectRecurringSeries(rows, { asOf: rows.at(-1)?.effectiveDate ?? '2024-03-31' })[0]!;

const event = (
  transition: RecurringStatusEvent['transition'],
  effectiveDate: string,
  ordinal: number,
): RecurringStatusEvent => ({
  transition,
  effectiveDate,
  commandId: `command-${ordinal.toString()}`,
  actorId: 'user-1',
  createdAt: `2024-01-${ordinal.toString().padStart(2, '0')}T12:00:00Z`,
});

const series = (
  candidate: DetectedSeries,
  statusEvents: readonly RecurringStatusEvent[],
  status: RecurringSeries['status'] = 'confirmed',
): RecurringSeries => ({ ...candidate, status, statusEvents, candidateVersionHash: candidate.inputFingerprint });

describe('projectOccurrences', () => {
  it('runs only for confirmed user-owned series and carries immutable derivation evidence', () => {
    const candidate = detected();
    expect(projectOccurrences(series(candidate, [], 'suggested'), {
      asOf: '2024-03-31', horizonDays: 70,
    })).toEqual([]);

    const projected = projectOccurrences(series(candidate, [event('confirmed', '2024-03-31', 1)]), {
      asOf: '2024-03-31',
      horizonDays: 92,
    });
    expect(projected.map((occurrence) => occurrence.expectedDate)).toEqual([
      '2024-04-30',
      '2024-05-31',
      '2024-06-30',
    ]);
    expect(projected[0]).toMatchObject({
      expectedAmountMinor: '-250000',
      amountKind: 'fixed',
      variable: false,
      status: 'expected',
      detectorVersion: candidate.detectorVersion,
      confidenceVersion: candidate.confidenceVersion,
      asOf: '2024-03-31',
      evidence: candidate.evidence,
      candidateVersionHash: candidate.inputFingerprint,
    });
  });

  it('uses the observed lower median for confirmed variable series only', () => {
    const candidate = detected([
      txn('u1', '2024-01-15', '-9000', 'City Utilities'),
      txn('u2', '2024-02-15', '-11000', 'City Utilities'),
      txn('u3', '2024-03-15', '-10000', 'City Utilities'),
      txn('u4', '2024-04-15', '-12000', 'City Utilities'),
    ]);
    const [occurrence] = projectOccurrences(
      series(candidate, [event('confirmed', '2024-04-15', 1)]),
      { asOf: '2024-04-15', horizonDays: 31 },
    );
    expect(occurrence).toMatchObject({ expectedAmountMinor: '-11000', variable: true });
  });

  it('suppresses [paused,resumed) and terminates at cancelled effective date', () => {
    const candidate = detected();
    const projected = projectOccurrences(series(candidate, [
      event('confirmed', '2024-03-31', 1),
      event('paused', '2024-04-01', 2),
      event('resumed', '2024-06-01', 3),
      event('cancelled', '2024-07-01', 4),
    ], 'cancelled'), { asOf: '2024-03-31', horizonDays: 130 });
    expect(projected.map((occurrence) => occurrence.expectedDate)).toEqual(['2024-06-30']);
  });
});

describe('backtest gate-5 matrix', () => {
  it('matches fixed monthly one-to-one and a skipped month does not end the series', () => {
    const candidate = detected();
    const actual = [
      txn('actual-jan', '2024-01-31', '-250000'),
      txn('actual-feb', '2024-02-29', '-250000'),
      txn('actual-apr', '2024-04-30', '-250000'),
    ];
    const result = backtest(
      series(candidate, [event('confirmed', '2024-01-01', 1)]),
      actual,
      { fromDate: '2024-01-01', toDate: '2024-04-30' },
    );
    expect(result.matched.map((match) => [match.expectedDate, match.txnId])).toEqual([
      ['2024-01-31', 'actual-jan'],
      ['2024-02-29', 'actual-feb'],
      ['2024-04-30', 'actual-apr'],
    ]);
    expect(result.skipped.map((item) => item.expectedDate)).toEqual(['2024-03-31']);
    expect(result.unexpected).toEqual([]);
  });

  it('replays a paused span without expectations and marks actuals there unexpected', () => {
    const candidate = detected();
    const result = backtest(series(candidate, [
      event('confirmed', '2024-01-01', 1),
      event('paused', '2024-03-01', 2),
      event('resumed', '2024-05-01', 3),
    ]), [
      txn('jan', '2024-01-31', '-250000'),
      txn('feb', '2024-02-29', '-250000'),
      txn('mar-during-pause', '2024-03-31', '-250000'),
      txn('may', '2024-05-31', '-250000'),
    ], { fromDate: '2024-01-01', toDate: '2024-05-31' });
    expect(result.matched.map((match) => match.txnId)).toEqual(['jan', 'feb', 'may']);
    expect(result.skipped).toEqual([]);
    expect(result.unexpected.map((item) => item.txnId)).toEqual(['mar-during-pause']);
  });

  it('terminates expectations at cancellation and treats later actuals as unexpected', () => {
    const candidate = detected();
    const result = backtest(series(candidate, [
      event('confirmed', '2024-01-01', 1),
      event('cancelled', '2024-03-01', 2),
    ], 'cancelled'), [
      txn('jan', '2024-01-31', '-250000'),
      txn('feb', '2024-02-29', '-250000'),
      txn('mar-after-cancel', '2024-03-31', '-250000'),
    ], { fromDate: '2024-01-01', toDate: '2024-04-30' });
    expect(result.matched.map((match) => match.txnId)).toEqual(['jan', 'feb']);
    expect(result.skipped).toEqual([]);
    expect(result.unexpected.map((item) => item.txnId)).toEqual(['mar-after-cancel']);
  });

  it('matches biweekly and variable-monthly fixtures under deterministic bigint policy', () => {
    const pay = detected([
      txn('p1', '2024-01-05', '200000', 'Payroll'),
      txn('p2', '2024-01-19', '200000', 'Payroll'),
      txn('p3', '2024-02-02', '200000', 'Payroll'),
    ]);
    const payResult = backtest(series(pay, [event('confirmed', '2024-01-01', 1)]), [
      txn('pay-a', '2024-01-05', '200000', 'Payroll'),
      txn('pay-b', '2024-01-19', '200000', 'Payroll'),
      txn('pay-c', '2024-02-02', '200000', 'Payroll'),
    ], { fromDate: '2024-01-01', toDate: '2024-02-02' });
    expect(payResult.matched).toHaveLength(3);

    const utility = detected([
      txn('u1', '2024-01-15', '-9000', 'City Utilities'),
      txn('u2', '2024-02-15', '-11000', 'City Utilities'),
      txn('u3', '2024-03-15', '-10000', 'City Utilities'),
    ]);
    const utilityResult = backtest(series(utility, [event('confirmed', '2024-01-01', 1)]), [
      txn('util-a', '2024-01-15', '-9000', 'City Utilities'),
      txn('util-b', '2024-02-16', '-10500', 'City Utilities'),
      txn('util-c', '2024-03-15', '-10000', 'City Utilities'),
    ], { fromDate: '2024-01-01', toDate: '2024-03-31' });
    expect(utilityResult.matched).toHaveLength(3);
  });

  it('pins one-to-one tie ordering by date residual, amount residual, effective date, txnId', () => {
    const candidate = detected();
    const result = backtest(series(candidate, [event('confirmed', '2024-01-01', 1)]), [
      txn('z-later-id', '2024-01-30', '-250000'),
      txn('a-first-id', '2024-02-01', '-250000'),
      txn('feb', '2024-02-29', '-250000'),
      txn('mar', '2024-03-31', '-250000'),
    ], { fromDate: '2024-01-01', toDate: '2024-03-31' });
    expect(result.matched[0]?.txnId).toBe('z-later-id');
    expect(result.unexpected.map((item) => item.txnId)).toEqual(['a-first-id']);
    expect(backtest(series(candidate, [event('confirmed', '2024-01-01', 1)]), [
      txn('mar', '2024-03-31', '-250000'),
      txn('feb', '2024-02-29', '-250000'),
      txn('a-first-id', '2024-02-01', '-250000'),
      txn('z-later-id', '2024-01-30', '-250000'),
    ], { fromDate: '2024-01-01', toDate: '2024-03-31' })).toEqual(result);
  });
});
