import { cadenceDatesBetween } from './cadence.js';
import { civilDateToEpochDay, parseCivilDate } from './civil-date.js';
import { fingerprint } from './fingerprint.js';
import { normalizeCounterparty } from './normalize.js';
import { compareBigints } from './statistics.js';
import { isSeriesActiveOn } from './timeline.js';
import type {
  BacktestResult,
  ExpectedOccurrence,
  RecurringSeries,
  RecurringTransaction,
} from './types.js';

interface ParsedActual extends RecurringTransaction {
  readonly amount: bigint;
  readonly epochDay: number;
}

const absoluteBigint = (value: bigint): bigint => value < 0n ? -value : value;

const expectedOccurrence = (
  series: RecurringSeries,
  expectedDate: string,
  asOf: string,
): ExpectedOccurrence => {
  const amount = series.amountKind === 'fixed'
    ? series.representativeAmountMinor
    : series.amountSummary.lowerMedianMinor;
  if (amount === null) throw new RangeError('fixed series requires an amount');
  return {
    occurrenceKey: fingerprint(`${series.seriesKey}|${expectedDate}|${series.candidateVersionHash}`),
    seriesKey: series.seriesKey,
    expectedDate,
    expectedAmountMinor: amount,
    currency: series.currency,
    sign: series.sign,
    amountKind: series.amountKind,
    variable: series.amountKind === 'variable',
    status: 'expected',
    scoreBps: series.scoreBps,
    evidence: series.evidence,
    inputFingerprint: fingerprint(`${series.inputFingerprint}|backtest|${expectedDate}`),
    detectorVersion: series.detectorVersion,
    confidenceVersion: series.confidenceVersion,
    candidateVersionHash: series.candidateVersionHash,
    asOf,
  };
};

const matchesKey = (series: RecurringSeries, transaction: ParsedActual): boolean => {
  const counterparty = transaction.counterpartyKey?.trim().toLowerCase() || normalizeCounterparty(transaction.description);
  const sign = transaction.amount < 0n ? 'outflow' : 'inflow';
  return counterparty === series.counterpartyKey &&
    transaction.accountId === series.accountId &&
    transaction.ledgerAccountId === series.ledgerAccountId &&
    transaction.currency === series.currency && sign === series.sign;
};

const amountAllowed = (series: RecurringSeries, amount: bigint): boolean => {
  if (series.amountKind === 'fixed') return amount === BigInt(series.representativeAmountMinor as string);
  return amount >= BigInt(series.amountSummary.minMinor) && amount <= BigInt(series.amountSummary.maxMinor);
};

export const backtest = (
  series: RecurringSeries,
  transactions: readonly RecurringTransaction[],
  options?: { readonly fromDate?: string; readonly toDate?: string },
): BacktestResult => {
  const ordered = transactions.map((transaction): ParsedActual => ({
    ...transaction,
    amount: BigInt(transaction.amountMinor),
    epochDay: civilDateToEpochDay(transaction.effectiveDate),
  })).sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate) || left.txnId.localeCompare(right.txnId),
  );
  const fromDate = options?.fromDate ?? ordered[0]?.effectiveDate ?? series.asOf;
  const toDate = options?.toDate ?? ordered.at(-1)?.effectiveDate ?? series.asOf;
  parseCivilDate(fromDate);
  parseCivilDate(toDate);
  const expectations = cadenceDatesBetween(series.cadenceAnchor, fromDate, toDate)
    .filter((date) => isSeriesActiveOn(series.statusEvents, date))
    .map((date) => expectedOccurrence(series, date, toDate));
  const toleranceDays = series.cadence === 'monthly' ? 3
    : series.cadence === 'quarterly' ? 5
    : series.cadence === 'annual' ? 7 : 2;

  const pairs = expectations.flatMap((expectation, expectationIndex) =>
    ordered.flatMap((actual, actualIndex) => {
      const dateResidual = Math.abs(civilDateToEpochDay(expectation.expectedDate) - actual.epochDay);
      if (dateResidual > toleranceDays || !matchesKey(series, actual) || !amountAllowed(series, actual.amount)) return [];
      return [{
        expectation,
        expectationIndex,
        actual,
        actualIndex,
        dateResidual,
        amountResidual: absoluteBigint(BigInt(expectation.expectedAmountMinor) - actual.amount),
      }];
    }),
  ).sort((left, right) =>
    left.dateResidual - right.dateResidual ||
    compareBigints(left.amountResidual, right.amountResidual) ||
    left.actual.effectiveDate.localeCompare(right.actual.effectiveDate) ||
    left.actual.txnId.localeCompare(right.actual.txnId) ||
    left.expectation.expectedDate.localeCompare(right.expectation.expectedDate),
  );

  const matchedExpectationIndexes = new Set<number>();
  const matchedActualIndexes = new Set<number>();
  const matched: BacktestResult['matched'][number][] = [];
  for (const pair of pairs) {
    if (matchedExpectationIndexes.has(pair.expectationIndex) || matchedActualIndexes.has(pair.actualIndex)) continue;
    matchedExpectationIndexes.add(pair.expectationIndex);
    matchedActualIndexes.add(pair.actualIndex);
    matched.push({
      ...pair.expectation,
      status: 'matched',
      txnId: pair.actual.txnId,
      actualDate: pair.actual.effectiveDate,
      actualAmountMinor: pair.actual.amountMinor,
    });
  }
  matched.sort((left, right) => left.expectedDate.localeCompare(right.expectedDate));
  const skipped = expectations
    .filter((_expectation, index) => !matchedExpectationIndexes.has(index))
    .map((expectation): BacktestResult['skipped'][number] => ({ ...expectation, status: 'skipped' }));
  const unexpected = ordered
    .filter((_actual, index) => !matchedActualIndexes.has(index))
    .map((actual): BacktestResult['unexpected'][number] => ({
      status: 'unexpected',
      txnId: actual.txnId,
      effectiveDate: actual.effectiveDate,
      amountMinor: actual.amountMinor,
      currency: actual.currency,
    }));
  return { matched, skipped, unexpected };
};
