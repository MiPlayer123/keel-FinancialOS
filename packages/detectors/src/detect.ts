import { civilDateToEpochDay, daysInMonth, parseCivilDate } from './civil-date.js';
import { fingerprint } from './fingerprint.js';
import { NORMALIZER_VERSION, normalizeCounterparty, recurringSuppressionReason } from './normalize.js';
import { bigintSummary, compareBigints } from './statistics.js';
import type {
  Cadence,
  CadenceAnchor,
  DetectedSeries,
  RecurringTransaction,
  TransactionSign,
} from './types.js';

export const DETECTOR_VERSION = 'recurring-grid-v2' as const;
export const CONFIDENCE_VERSION = 'recurring-score-bps-v1' as const;
export const MAX_DETECTION_INPUT_ROWS = 10_000 as const;
export const MAX_DETECTION_LOOKBACK_DAYS = 3_660 as const;

// ---------------------------------------------------------------------------
// Quality gate (recurring-grid-v2). A fit is only a genuine recurring series if
// its occurrences fill enough of the cadence grid AND the actual inter-occurrence
// spacing is regular. These two together kill the false positives reported in
// docs/RECURRING-RESEARCH.md — irregular cashback, random Venmo, and 3 points
// draped over a mostly-empty grid — without touching the deterministic spine.
//
// Everything here is integer arithmetic over slot indexes and counts (not money),
// so it stays deterministic/replayable (Law 1/9) and never touches BigInt money.
//
// MIN_COVERAGE_NUM/DEN — matchedSlots/totalSlots >= 3/5 (0.60). A 3-occurrence
//   series draped over 11 empty monthly slots (coverage ≈ 0.27, e.g. Jan/Jun/Nov)
//   is rejected; a clean 3-consecutive-month subscription (coverage 1.0) survives;
//   month-end rent with one skipped month (4/5 = 0.80) survives.
// MAX_PERIOD_GAP — the largest gap between two consecutive matched slots, measured
//   in whole cadence periods, may be at most 2 (one skipped period). A single 3+
//   period jump (two consecutive skips, or an irregular point snapped to a distant
//   slot) rejects the fit. Cadence-relative because the grid already encodes the
//   cadence, so "gap of 2" means one skipped month for monthly, one skipped quarter
//   for quarterly, etc.
export const MIN_COVERAGE_NUM = 3 as const;
export const MIN_COVERAGE_DEN = 5 as const;
export const MAX_PERIOD_GAP = 2 as const;

const passesQualityGate = (
  matchedSlots: number,
  totalSlots: number,
  maxPeriodGap: number,
): boolean =>
  // matchedSlots / totalSlots >= MIN_COVERAGE_NUM / MIN_COVERAGE_DEN, cross-multiplied
  // to stay in integers (no float on a ratio the gate turns on).
  matchedSlots * MIN_COVERAGE_DEN >= totalSlots * MIN_COVERAGE_NUM &&
  maxPeriodGap <= MAX_PERIOD_GAP;

interface ParsedTransaction extends RecurringTransaction {
  readonly amount: bigint;
  readonly epochDay: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface GridSlot {
  readonly key: string;
  readonly date: string;
  readonly epochDay: number;
}

interface Fit {
  readonly cadence: Cadence;
  readonly anchor: CadenceAnchor;
  readonly matched: readonly ParsedTransaction[];
  readonly totalSlots: number;
  readonly residualDays: number;
  readonly amountFixed: boolean;
  readonly scoreBps: number;
  readonly fitKey: string;
}

const absNumber = (value: number): number => value < 0 ? -value : value;
const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
const dateString = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

const parseAmount = (wire: string): bigint => {
  if (!/^-?(0|[1-9][0-9]*)$/u.test(wire) || wire === '-0') {
    throw new RangeError('amountMinor must be a canonical decimal integer string');
  }
  const amount = BigInt(wire);
  if (amount === 0n) throw new RangeError('recurring transaction amount must be non-zero');
  return amount;
};

const parseTransaction = (transaction: RecurringTransaction): ParsedTransaction => {
  const civil = parseCivilDate(transaction.effectiveDate);
  if (
    transaction.txnId.length === 0 || transaction.batchId.length === 0 ||
    transaction.postingId.length === 0 || transaction.accountId.length === 0 ||
    transaction.ledgerAccountId.length === 0 || transaction.currency.length === 0
  ) {
    throw new RangeError('recurring transaction identity fields must be non-empty');
  }
  return {
    ...transaction,
    amount: parseAmount(transaction.amountMinor),
    epochDay: civilDateToEpochDay(transaction.effectiveDate),
    ...civil,
  };
};

const compareTransactions = (left: ParsedTransaction, right: ParsedTransaction): number =>
  left.effectiveDate.localeCompare(right.effectiveDate) || left.txnId.localeCompare(right.txnId);

const fitSlots = (
  input: readonly ParsedTransaction[],
  slots: readonly GridSlot[],
  toleranceDays: number,
): {
  matched: ParsedTransaction[];
  totalSlots: number;
  residualDays: number;
  maxPeriodGap: number;
} | null => {
  const ranked = input.flatMap((transaction) =>
    slots.flatMap((slot, slotIndex) => {
      const residual = absNumber(transaction.epochDay - slot.epochDay);
      return residual <= toleranceDays ? [{ transaction, slot, slotIndex, residual }] : [];
    }),
  ).sort((left, right) =>
    left.residual - right.residual ||
    left.transaction.effectiveDate.localeCompare(right.transaction.effectiveDate) ||
    left.transaction.txnId.localeCompare(right.transaction.txnId),
  );

  const usedTransactions = new Set<string>();
  const usedSlots = new Set<string>();
  const chosen: typeof ranked = [];
  for (const candidate of ranked) {
    if (usedTransactions.has(candidate.transaction.txnId) || usedSlots.has(candidate.slot.key)) continue;
    usedTransactions.add(candidate.transaction.txnId);
    usedSlots.add(candidate.slot.key);
    chosen.push(candidate);
  }
  if (chosen.length < 3) return null;
  const chosenSlotIndexes = chosen.map((item) => item.slotIndex);
  const firstSlot = Math.min(...chosenSlotIndexes);
  const lastSlot = Math.max(...chosenSlotIndexes);
  // Interval regularity: the largest jump between two consecutive matched slots,
  // in whole cadence periods (each grid slot is exactly one period apart). A clean
  // series is all 1s; one skipped period is a 2; anything larger is irregular.
  const sortedSlotIndexes = [...chosenSlotIndexes].sort((left, right) => left - right);
  let maxPeriodGap = 1;
  for (let i = 1; i < sortedSlotIndexes.length; i += 1) {
    const gap = (sortedSlotIndexes[i] as number) - (sortedSlotIndexes[i - 1] as number);
    if (gap > maxPeriodGap) maxPeriodGap = gap;
  }
  return {
    matched: chosen.map((item) => item.transaction).sort(compareTransactions),
    totalSlots: lastSlot - firstSlot + 1,
    residualDays: chosen.reduce((sum, item) => sum + item.residual, 0),
    maxPeriodGap,
  };
};

const scoreFit = (
  matched: number,
  totalSlots: number,
  residualDays: number,
  fixed: boolean,
): number => {
  const coverage = Math.floor((matched * 7_000) / totalSlots);
  const count = Math.min(1_500, 750 + (matched - 3) * 250);
  const fixedBonus = fixed ? 2_000 : 0;
  return Math.max(1, Math.min(10_000, coverage + count + fixedBonus - residualDays * 250));
};

const makeFit = (
  cadence: Cadence,
  anchor: CadenceAnchor,
  subset: readonly ParsedTransaction[],
  slots: readonly GridSlot[],
  toleranceDays: number,
): Fit | null => {
  const result = fitSlots(subset, slots, toleranceDays);
  if (!result) return null;
  // Quality gate (recurring-grid-v2): reject sparse or irregular fits before they
  // ever become a candidate. See passesQualityGate / MIN_COVERAGE_* / MAX_PERIOD_GAP.
  if (!passesQualityGate(result.matched.length, result.totalSlots, result.maxPeriodGap)) {
    return null;
  }
  const amounts = result.matched.map((transaction) => transaction.amount);
  const fixed = amounts.every((amount) => amount === amounts[0]);
  const fitKey = `${cadence}|${JSON.stringify(anchor)}|${result.matched.map((item) => item.txnId).join(',')}`;
  return {
    cadence,
    anchor,
    matched: result.matched,
    totalSlots: result.totalSlots,
    residualDays: result.residualDays,
    amountFixed: fixed,
    scoreBps: scoreFit(result.matched.length, result.totalSlots, result.residualDays, fixed),
    fitKey,
  };
};

const epochFits = (subset: readonly ParsedTransaction[], intervalDays: 7 | 14): Fit[] => {
  const minDay = Math.min(...subset.map((transaction) => transaction.epochDay));
  const maxDay = Math.max(...subset.map((transaction) => transaction.epochDay));
  const anchors = [...new Set(subset.map((transaction) => mod(transaction.epochDay, intervalDays)))];
  return anchors.flatMap((remainder) => {
    const first = minDay - mod(minDay - remainder, intervalDays) - intervalDays;
    const slots: GridSlot[] = [];
    for (let day = first; day <= maxDay + intervalDays; day += intervalDays) {
      slots.push({ key: day.toString(), date: day.toString(), epochDay: day });
    }
    const anchor: CadenceAnchor = {
      kind: 'epoch_grid',
      intervalDays,
      anchorEpochDay: first + intervalDays,
    };
    const fit = makeFit(intervalDays === 7 ? 'weekly' : 'biweekly', anchor, subset, slots, intervalDays === 7 ? 1 : 2);
    return fit ? [fit] : [];
  });
};

const calendarFits = (
  subset: readonly ParsedTransaction[],
  intervalMonths: 1 | 3 | 12,
): Fit[] => {
  const minMonth = Math.min(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const maxMonth = Math.max(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const anchors = [...new Set(subset.map((transaction) => transaction.day))];
  const phases = [...new Set(subset.map((transaction) => mod(transaction.year * 12 + transaction.month - 1, intervalMonths)))];
  const cadence: Cadence = intervalMonths === 1 ? 'monthly' : intervalMonths === 3 ? 'quarterly' : 'annual';
  const tolerance = intervalMonths === 1 ? 3 : intervalMonths === 3 ? 5 : 7;
  return anchors.flatMap((anchorDay) => phases.flatMap((phase) => {
    const slots: GridSlot[] = [];
    for (let monthIndex = minMonth - intervalMonths; monthIndex <= maxMonth + intervalMonths; monthIndex += 1) {
      if (mod(monthIndex, intervalMonths) !== phase) continue;
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex - year * 12 + 1;
      const date = dateString(year, month, Math.min(anchorDay, daysInMonth(year, month)));
      slots.push({ key: monthIndex.toString(), date, epochDay: civilDateToEpochDay(date) });
    }
    const anchor: CadenceAnchor = {
      kind: 'day_of_month',
      day: anchorDay,
      intervalMonths,
      phase,
    };
    const fit = makeFit(cadence, anchor, subset, slots, tolerance);
    return fit ? [fit] : [];
  }));
};

const semimonthlyFits = (subset: readonly ParsedTransaction[]): Fit[] => {
  const days = [...new Set(subset.map((transaction) => transaction.day))].sort((a, b) => a - b);
  const minMonth = Math.min(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const maxMonth = Math.max(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const pairs: Array<readonly [number, number]> = [];
  days.forEach((first, firstIndex) => {
    days.slice(firstIndex + 1).forEach((second) => {
      if (second - first >= 10 && second - first <= 20) pairs.push([first, second]);
    });
  });
  return pairs.flatMap((pair) => {
    const slots: GridSlot[] = [];
    for (let monthIndex = minMonth - 1; monthIndex <= maxMonth + 1; monthIndex += 1) {
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex - year * 12 + 1;
      for (const anchorDay of pair) {
        const date = dateString(year, month, Math.min(anchorDay, daysInMonth(year, month)));
        slots.push({ key: date, date, epochDay: civilDateToEpochDay(date) });
      }
    }
    slots.sort((left, right) => left.date.localeCompare(right.date));
    const anchor: CadenceAnchor = { kind: 'day_pair', days: pair };
    const fit = makeFit('semimonthly', anchor, subset, slots, 2);
    return fit ? [fit] : [];
  });
};

const subsetsFor = (group: readonly ParsedTransaction[]): ParsedTransaction[][] => {
  const byAmount = new Map<bigint, ParsedTransaction[]>();
  for (const transaction of group) {
    const bucket = byAmount.get(transaction.amount) ?? [];
    bucket.push(transaction);
    byAmount.set(transaction.amount, bucket);
  }
  const subsets = [...byAmount.values()].filter((bucket) => bucket.length >= 3);
  subsets.push([...group]);
  const seen = new Set<string>();
  return subsets.filter((subset) => {
    const key = subset.map((transaction) => transaction.txnId).sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const cadencePriority: Readonly<Record<Cadence, number>> = {
  weekly: 0,
  biweekly: 1,
  semimonthly: 2,
  monthly: 3,
  quarterly: 4,
  annual: 5,
};

const compareFits = (left: Fit, right: Fit): number =>
  right.scoreBps - left.scoreBps ||
  right.matched.length - left.matched.length ||
  left.residualDays - right.residualDays ||
  cadencePriority[left.cadence] - cadencePriority[right.cadence] ||
  left.fitKey.localeCompare(right.fitKey);

const chooseDisjointFits = (group: readonly ParsedTransaction[]): Fit[] => {
  const unique = new Map<string, Fit>();
  for (const subset of subsetsFor(group)) {
    const fits = [
      ...epochFits(subset, 7),
      ...epochFits(subset, 14),
      ...semimonthlyFits(subset),
      ...calendarFits(subset, 1),
      ...calendarFits(subset, 3),
      ...calendarFits(subset, 12),
    ];
    for (const fit of fits) {
      const current = unique.get(fit.fitKey);
      if (!current || compareFits(fit, current) < 0) unique.set(fit.fitKey, fit);
    }
  }
  const used = new Set<string>();
  const chosen: Fit[] = [];
  for (const fit of [...unique.values()].sort(compareFits)) {
    if (fit.matched.some((transaction) => used.has(transaction.txnId))) continue;
    fit.matched.forEach((transaction) => used.add(transaction.txnId));
    chosen.push(fit);
  }
  return chosen;
};

const stableAnchor = (anchor: CadenceAnchor): string => JSON.stringify(anchor);

export const detectRecurringSeries = (
  transactions: readonly RecurringTransaction[],
  options: { readonly asOf: string },
): DetectedSeries[] => {
  parseCivilDate(options.asOf);
  if (transactions.length > MAX_DETECTION_INPUT_ROWS) {
    throw new RangeError(`recurring detection input exceeds ${MAX_DETECTION_INPUT_ROWS.toString()} rows`);
  }
  const asOfEpochDay = civilDateToEpochDay(options.asOf);
  const parsed = transactions.map(parseTransaction)
    .filter((transaction) => transaction.effectiveDate <= options.asOf &&
      transaction.epochDay >= asOfEpochDay - MAX_DETECTION_LOOKBACK_DAYS &&
      // C (docs/RECURRING-RESEARCH.md): personal P2P rails and reward/refund lines
      // are never recurring subscriptions/bills. Suppress them from detection so
      // they are not OFFERED as candidates — the rows stay in the ledger and export
      // (Law 6); they simply do not become a recurring suggestion.
      recurringSuppressionReason(transaction.description) === null)
    .sort(compareTransactions);
  const groups = new Map<string, { counterpartyKey: string; sign: TransactionSign; rows: ParsedTransaction[] }>();
  for (const transaction of parsed) {
    const counterpartyKey = transaction.counterpartyKey?.trim().toLowerCase() || normalizeCounterparty(transaction.description);
    const sign: TransactionSign = transaction.amount < 0n ? 'outflow' : 'inflow';
    // NORMALIZER_VERSION is deliberately NOT part of the group/series key — same as
    // DETECTOR_VERSION and CONFIDENCE_VERSION, which live only in inputFingerprint.
    // The series_key is the STABLE identity of a recurring series across the household;
    // a normalizer bump (v1→v2) must re-detect the SAME series (a new candidate version
    // under the existing series, the intended supersession path via
    // ON CONFLICT (household_id, series_key) DO NOTHING), never mint a duplicate
    // "twin" series that reappears as Suggested next to an already-CONFIRMED one and
    // double-counts in projections. The normalizer version still fingerprints the
    // detection INPUT below (line ~416) so re-detection is recorded, and rides the
    // per-series normalizerVersion field — it just no longer forks the key.
    const key = [counterpartyKey, transaction.accountId, transaction.ledgerAccountId, sign, transaction.currency].join('|');
    const group = groups.get(key) ?? { counterpartyKey, sign, rows: [] };
    group.rows.push(transaction);
    groups.set(key, group);
  }

  const output: DetectedSeries[] = [];
  for (const [groupKey, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.rows.length < 3) continue;
    for (const fit of chooseDisjointFits(group.rows)) {
      const amounts = fit.matched.map((transaction) => transaction.amount);
      const summary = bigintSummary(amounts);
      const first = fit.matched[0] as ParsedTransaction;
      const last = fit.matched.at(-1) as ParsedTransaction;
      const identityAmount = fit.amountFixed ? summary.median.toString() : '';
      const seriesKey = fingerprint(`${groupKey}|${fit.cadence}|${stableAnchor(fit.anchor)}|${identityAmount}`);
      const evidenceInput = fit.matched.map((transaction) => [
        transaction.txnId,
        transaction.batchId,
        transaction.postingId,
        transaction.effectiveDate,
        transaction.amountMinor,
        transaction.currency,
      ].join('|')).join('\n');
      output.push({
        seriesKey,
        counterpartyKey: group.counterpartyKey,
        accountId: first.accountId,
        ledgerAccountId: first.ledgerAccountId,
        currency: first.currency,
        sign: group.sign,
        cadence: fit.cadence,
        cadenceAnchor: fit.anchor,
        amountKind: fit.amountFixed ? 'fixed' : 'variable',
        representativeAmountMinor: fit.amountFixed ? summary.median.toString() : null,
        amountSummary: {
          minMinor: summary.min.toString(),
          maxMinor: summary.max.toString(),
          lowerMedianMinor: summary.median.toString(),
          squaredResidualSum: summary.squaredResidualSum.toString(),
          count: summary.count,
        },
        lastSeen: last.effectiveDate,
        occurrenceCount: fit.matched.length,
        coverage: { matchedSlots: fit.matched.length, totalSlots: fit.totalSlots },
        residualDays: fit.residualDays,
        scoreBps: fit.scoreBps,
        evidence: fit.matched.map((transaction) => ({
          txnId: transaction.txnId,
          batchId: transaction.batchId,
          postingId: transaction.postingId,
        })),
        inputFingerprint: fingerprint(`${DETECTOR_VERSION}|${CONFIDENCE_VERSION}|${NORMALIZER_VERSION}|${options.asOf}|${evidenceInput}`),
        detectorVersion: DETECTOR_VERSION,
        confidenceVersion: CONFIDENCE_VERSION,
        normalizerVersion: NORMALIZER_VERSION,
        asOf: options.asOf,
        requiresApproval: true,
      });
    }
  }
  return output.sort((left, right) =>
    left.counterpartyKey.localeCompare(right.counterpartyKey) ||
    left.accountId.localeCompare(right.accountId) ||
    left.cadence.localeCompare(right.cadence) ||
    stableAnchor(left.cadenceAnchor).localeCompare(stableAnchor(right.cadenceAnchor)) ||
    compareBigints(BigInt(left.amountSummary.lowerMedianMinor), BigInt(right.amountSummary.lowerMedianMinor)),
  );
};
