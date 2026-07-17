import { describe, expect, it } from 'vitest';

import {
  amountsConsistent,
  cadenceLabel,
  categorizationReasonLine,
  dayGapsBetween,
  median,
  pfcPrimaryLabel,
  recurringReasonLine,
  transferReasonLine,
} from './recurring-evidence';

describe('dayGapsBetween', () => {
  it('computes whole-day gaps regardless of input order', () => {
    expect(dayGapsBetween(['2026-07-15', '2026-07-01', '2026-07-08'])).toEqual([7, 7]);
  });
  it('drops invalid dates and handles short lists', () => {
    expect(dayGapsBetween([])).toEqual([]);
    expect(dayGapsBetween(['2026-07-01'])).toEqual([]);
    expect(dayGapsBetween(['garbage', '2026-07-01', '2026-07-31'])).toEqual([30]);
  });
});

describe('median', () => {
  it('handles odd, even (lower middle), and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 10])).toBe(2); // even count: lower middle, stays integer
    expect(median([])).toBeNull();
  });
});

describe('cadenceLabel', () => {
  it('labels weekly (7±2)', () => {
    expect(cadenceLabel(['2026-01-01', '2026-01-08', '2026-01-15'])).toBe('weekly');
    expect(cadenceLabel(['2026-01-01', '2026-01-06'])).toBe('weekly'); // gap 5
    expect(cadenceLabel(['2026-01-01', '2026-01-10'])).toBe('weekly'); // gap 9
  });
  it('labels every 2 weeks (14±3)', () => {
    expect(cadenceLabel(['2026-01-02', '2026-01-16', '2026-01-30'])).toBe('every 2 weeks');
    expect(cadenceLabel(['2026-01-01', '2026-01-12'])).toBe('every 2 weeks'); // gap 11
    expect(cadenceLabel(['2026-01-01', '2026-01-18'])).toBe('every 2 weeks'); // gap 17
  });
  it('labels monthly (28–31±5), tolerating month-length drift', () => {
    expect(cadenceLabel(['2026-01-31', '2026-02-28', '2026-03-31'])).toBe('monthly');
    expect(cadenceLabel(['2026-01-01', '2026-01-24'])).toBe('monthly'); // gap 23
    expect(cadenceLabel(['2026-01-01', '2026-02-06'])).toBe('monthly'); // gap 36
  });
  it('labels quarterly (84–98)', () => {
    expect(cadenceLabel(['2026-01-01', '2026-04-01', '2026-07-01'])).toBe('quarterly');
  });
  it('falls back to ~every N days outside the bands', () => {
    expect(cadenceLabel(['2026-01-01', '2026-01-21'])).toBe('~every 20 days'); // 18–22 gap band
    expect(cadenceLabel(['2026-01-01', '2026-01-03'])).toBe('~every 2 days');
    expect(cadenceLabel(['2026-01-01', '2026-03-02'])).toBe('~every 60 days');
  });
  it('uses the median gap, so one outlier does not flip the label', () => {
    // gaps 30, 30, 90 → median 30 → monthly
    expect(cadenceLabel(['2026-01-01', '2026-01-31', '2026-03-02', '2026-05-31'])).toBe('monthly');
  });
  it('returns null when there are fewer than two valid dates', () => {
    expect(cadenceLabel([])).toBeNull();
    expect(cadenceLabel(['2026-01-01'])).toBeNull();
    expect(cadenceLabel(['2026-01-01', 'not-a-date'])).toBeNull();
  });
  it('returns null for zero-day gaps (duplicate dates carry no cadence)', () => {
    expect(cadenceLabel(['2026-01-01', '2026-01-01'])).toBeNull();
  });
});

describe('amountsConsistent', () => {
  it('compares minor-unit strings as integers', () => {
    expect(amountsConsistent(['150000', '150000', '150000'])).toBe(true);
    expect(amountsConsistent(['-1500', '-1500'])).toBe(true);
    expect(amountsConsistent(['150000', '150001'])).toBe(false);
    expect(amountsConsistent([])).toBe(true);
  });
  it('never claims consistency for malformed amounts', () => {
    expect(amountsConsistent(['150000', 'oops'])).toBe(false);
  });
});

describe('reason lines', () => {
  it('builds the recurring reason line, honestly worded as projection (Law 9)', () => {
    expect(
      recurringReasonLine({
        sign: 'outflow',
        expectedDates: ['2026-01-01', '2026-01-31', '2026-03-02'],
        amountsMinor: ['-150000', '-150000', '-150000'],
      }),
    ).toBe('Repeating outflow · projected monthly · consistent projected amount');
    expect(
      recurringReasonLine({ sign: 'inflow', expectedDates: [], amountsMinor: [] }),
    ).toBe('Repeating inflow');
  });
  it('labels daily and survives duplicate-date zero gaps (review findings)', () => {
    expect(cadenceLabel(['2026-01-01', '2026-01-02', '2026-01-03'])).toBe('daily');
    // A same-day duplicate must not drag the median to 0 and erase the signal.
    expect(cadenceLabel(['2026-01-01', '2026-01-01', '2026-01-31'])).toBe('monthly');
    // All-duplicate dates: no gaps at all -> no cadence claim.
    expect(cadenceLabel(['2026-01-01', '2026-01-01'])).toBeNull();
  });
  it('rejects malformed amount strings instead of coercing them to 0n', () => {
    expect(amountsConsistent(['', '0'])).toBe(false);
    expect(amountsConsistent(['  ', '0'])).toBe(false);
    expect(amountsConsistent(['1e2', '100'])).toBe(false);
    expect(amountsConsistent(['-100', '-100'])).toBe(true);
  });
  it('builds the transfer reason line with day-gap phrasing', () => {
    expect(transferReasonLine(0)).toBe('Same amount · opposite directions · same day');
    expect(transferReasonLine(1)).toBe('Same amount · opposite directions · 1 day apart');
    expect(transferReasonLine(3)).toBe('Same amount · opposite directions · 3 days apart');
  });
  it('humanizes PFC primaries', () => {
    expect(pfcPrimaryLabel('FOOD_AND_DRINK')).toBe('Food and drink');
    expect(pfcPrimaryLabel('RENT_AND_UTILITIES')).toBe('Rent and utilities');
    expect(pfcPrimaryLabel('')).toBe('Unknown');
  });
  it('builds the categorization reason line for rule and PFC sources', () => {
    expect(
      categorizationReasonLine({ reasonCode: 'rule_match', rulePattern: 'blue bottle' }),
    ).toBe("Matches your rule 'blue bottle'");
    // A deleted rule loses its live pattern but the claim stays honest.
    expect(categorizationReasonLine({ reasonCode: 'rule_match', rulePattern: null })).toBe(
      'Matches one of your rules',
    );
    expect(
      categorizationReasonLine({ reasonCode: 'pfc_mapping', pfcPrimary: 'FOOD_AND_DRINK' }),
    ).toBe('Bank category: Food and drink');
    expect(categorizationReasonLine({ reasonCode: 'pfc_mapping' })).toBe(
      'Mapped from the bank category',
    );
    // Unknown future codes degrade to an honest generic line, never a throw.
    expect(categorizationReasonLine({ reasonCode: 'mystery' })).toBe(
      'Suggested by a deterministic detector',
    );
  });
});
