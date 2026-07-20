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

// Real payroll paid on fixed calendar days (e.g. the 15th and the last day of
// the month) shifts a few days EARLY when the anchor lands on a weekend/holiday
// (paid the prior business day) — the 15th on a Sunday is paid Friday the 13th
// (2-day shift), and a rare Sunday-plus-holiday can push 3. So semi-monthly
// tolerance is 3 (vs the biweekly grid's 2). This matters because those same
// drifted dates are OFTEN ~14 days apart for a stretch (Dec 31 -> Jan 15 -> Jan
// 30 -> Feb 13 -> Feb 27 -> Mar 13 are all 14-15 days apart), so a dense
// biweekly epoch grid can otherwise snap them and out-score / fragment the true
// single semi-monthly series.
const SEMIMONTHLY_TOLERANCE = 3 as const;

const semimonthlyFits = (subset: readonly ParsedTransaction[]): Fit[] => {
  const observed = [...new Set(subset.map((transaction) => transaction.day))].sort((a, b) => a - b);
  // Seed the candidate day set with the canonical month-end days (28-31) in
  // addition to observed days: a drifted last-day-of-month deposit (e.g. paid the
  // 27th or 30th) must still be able to pair against a 31 ("last day") anchor,
  // which clamps to Feb 28/29, Apr 30, etc. in the grid below. Without this seed,
  // a month-end series whose observed days are all < 31 could never propose the
  // 31 anchor and would lose the "last day of month" semantics.
  const days = [...new Set([...observed, 28, 29, 30, 31])].sort((a, b) => a - b);
  const minMonth = Math.min(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const maxMonth = Math.max(...subset.map((transaction) => transaction.year * 12 + transaction.month - 1));
  const pairs: Array<readonly [number, number]> = [];
  days.forEach((first, firstIndex) => {
    days.slice(firstIndex + 1).forEach((second) => {
      // A semi-monthly pair is two anchors ~half a month apart. Widened lower
      // bound to 9 so a 13/27-style pair (both anchors drifted early) still
      // qualifies; upper bound stays 20.
      if (second - first >= 9 && second - first <= 20) pairs.push([first, second]);
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
    const fit = makeFit('semimonthly', anchor, subset, slots, SEMIMONTHLY_TOLERANCE);
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
  // Semi-monthly vs biweekly disambiguation (structural, not score-based).
  // A true semi-monthly payroll (15th + last day of month) drifts a few days
  // early on weekend/holiday anchors, and those drifted dates are frequently
  // ~14 days apart for a run — so a dense epoch (weekly/biweekly) grid can snap
  // them and, being denser, out-score AND fragment the single correct
  // semi-monthly series into two biweekly pieces. The domain truth is that
  // "two hits per month, near the 15th and month-end" is the MORE SPECIFIC
  // explanation whenever it covers the same transactions. So: drop any epoch fit
  // whose matched transactions are ALL also covered by a single semimonthly fit
  // that matches at least as many transactions. Deterministic set containment;
  // no floats, no scores. A genuine biweekly series (day-of-month walks the whole
  // calendar, never clustering at two anchors) is never fully covered by one
  // day_pair fit, so it survives untouched (regression-guarded by tests).
  // A drifted semi-monthly series (e.g. a variable payroll paid on the 15th and
  // the last day of each month, shifted early on weekends) can be mis-explained
  // EITHER as two biweekly fragments OR as two monthly series (15th + 31st) —
  // both strictly less specific than "twice a month, 15th & month-end". So a
  // semimonthly fit dominates a weekly/biweekly/monthly fit whose matched
  // transactions it FULLY covers, subject to two guards that keep this from
  // eating legitimately-separate series:
  //
  //  (1) STRICTLY MORE coverage. The semimonthly fit must match strictly MORE
  //      transactions than the fit it dominates (a real 2/month stream covers
  //      ~2x a single monthly and more than either biweekly fragment). Equality
  //      is not enough — that would let a day_pair contortion tie and steal a
  //      genuine biweekly/monthly series it merely happens to overlap.
  //  (2) DON'T MERGE DISTINCT FIXED-AMOUNT CLUSTERS. Two different fixed-amount
  //      subscriptions in one counterparty group (e.g. $9.99 on the 5th and
  //      $15.99 on the 20th) look pair-like but are TWO real series; the
  //      spanning semimonthly fit is necessarily `variable`. So a `variable`
  //      semimonthly fit never dominates a `fixed`-amount fit. A truly one-stream
  //      semimonthly payroll is itself variable-vs-variable (or fixed-vs-fixed),
  //      so it still collapses.
  const allFits = [...unique.values()];
  const semimonthlyFitList = allFits.filter((fit) => fit.cadence === 'semimonthly');
  const dominated = new Set<string>();
  for (const other of allFits) {
    if (other.cadence !== 'weekly' && other.cadence !== 'biweekly' && other.cadence !== 'monthly') {
      continue;
    }
    const covered = semimonthlyFitList.some(
      (semi) =>
        semi.fitKey !== other.fitKey &&
        other.matched.length > 0 &&
        semi.matched.length > other.matched.length &&
        !(other.amountFixed && !semi.amountFixed) &&
        other.matched.every((t) => semi.matched.some((s) => s.txnId === t.txnId)),
    );
    if (covered) dominated.add(other.fitKey);
  }

  const used = new Set<string>();
  const chosen: Fit[] = [];
  for (const fit of allFits.sort(compareFits)) {
    if (dominated.has(fit.fitKey)) continue;
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
