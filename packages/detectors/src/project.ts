import { addCivilDays, parseCivilDate } from './civil-date.js';
import { cadenceDatesBetween } from './cadence.js';
import { fingerprint } from './fingerprint.js';
import { isSeriesActiveOn } from './timeline.js';
import type { ExpectedOccurrence, RecurringSeries } from './types.js';

export const projectOccurrences = (
  series: RecurringSeries,
  options: { readonly asOf: string; readonly horizonDays: number },
): ExpectedOccurrence[] => {
  parseCivilDate(options.asOf);
  if (!Number.isSafeInteger(options.horizonDays) || options.horizonDays < 0) {
    throw new RangeError('horizonDays must be a non-negative integer');
  }
  if (series.status === 'suggested' || series.status === 'rejected') return [];
  const endDate = addCivilDays(options.asOf, options.horizonDays);
  const startDate = addCivilDays(series.lastSeen, 1);
  const expectedAmountMinor = series.amountKind === 'fixed'
    ? series.representativeAmountMinor
    : series.amountSummary.lowerMedianMinor;
  if (expectedAmountMinor === null) throw new RangeError('fixed series requires an amount');
  return cadenceDatesBetween(series.cadenceAnchor, startDate, endDate)
    .filter((date) => isSeriesActiveOn(series.statusEvents, date))
    .map((expectedDate): ExpectedOccurrence => ({
      occurrenceKey: fingerprint(`${series.seriesKey}|${expectedDate}|${series.candidateVersionHash}`),
      seriesKey: series.seriesKey,
      expectedDate,
      expectedAmountMinor,
      currency: series.currency,
      sign: series.sign,
      amountKind: series.amountKind,
      variable: series.amountKind === 'variable',
      status: 'expected',
      scoreBps: series.scoreBps,
      evidence: series.evidence,
      inputFingerprint: fingerprint(`${series.inputFingerprint}|${expectedDate}|${series.statusEvents.map((event) => `${event.transition}:${event.effectiveDate}:${event.commandId}`).join('|')}`),
      detectorVersion: series.detectorVersion,
      confidenceVersion: series.confidenceVersion,
      candidateVersionHash: series.candidateVersionHash,
      asOf: options.asOf,
    }));
};
