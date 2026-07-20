import { describe, expect, it } from 'vitest';

import {
  CADENCE_SUFFIX,
  RECURRING_ACTIONS,
  annualizedEstimate,
  annualizedMinor,
  inferCadence,
  stepScheduleDue,
} from './recurring';

describe('stepScheduleDue', () => {
  it('steps weekly / biweekly by fixed day counts', () => {
    expect(stepScheduleDue('2026-01-01', 'weekly', 1)).toBe('2026-01-08');
    expect(stepScheduleDue('2026-01-01', 'biweekly', 1)).toBe('2026-01-15');
  });

  it('steps monthly anchored to the declared day, recovering after a short month', () => {
    // Jan 31 -> Feb 28 (clamped) -> Mar 31 (recovered): the anchor-day fix.
    expect(stepScheduleDue('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(stepScheduleDue('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
  });

  it("'once' never advances", () => {
    expect(stepScheduleDue('2026-01-15', 'once', 15)).toBe('2026-01-15');
  });

  describe('semimonthly (two anchor days per month)', () => {
    it('walks a [15, 30] schedule Jan 15 -> Jan 30 -> Feb 15 -> Feb 28 -> Mar 15 -> Mar 30', () => {
      // The exact sequence the migration header promises. Feb 30 clamps to the
      // last day of February (28 in 2026) via the same least/min clamp.
      expect(stepScheduleDue('2026-01-15', 'semimonthly', 15, 30)).toBe('2026-01-30');
      expect(stepScheduleDue('2026-01-30', 'semimonthly', 15, 30)).toBe('2026-02-15');
      expect(stepScheduleDue('2026-02-15', 'semimonthly', 15, 30)).toBe('2026-02-28');
      // From the clamped Feb 28 (its "30th"), roll forward to Mar 15 — NOT
      // back to Feb 28: the larger anchor is treated as reached.
      expect(stepScheduleDue('2026-02-28', 'semimonthly', 15, 30)).toBe('2026-03-15');
      expect(stepScheduleDue('2026-03-15', 'semimonthly', 15, 30)).toBe('2026-03-30');
    });

    it('clamps the 30th to Feb 29 in a leap year (2028)', () => {
      expect(stepScheduleDue('2028-02-15', 'semimonthly', 15, 30)).toBe('2028-02-29');
      expect(stepScheduleDue('2028-02-29', 'semimonthly', 15, 30)).toBe('2028-03-15');
    });

    it('is order-independent in its two anchor args (normalizes internally)', () => {
      // Passing (30, 15) must behave identically to (15, 30).
      expect(stepScheduleDue('2026-01-15', 'semimonthly', 30, 15)).toBe('2026-01-30');
      expect(stepScheduleDue('2026-01-30', 'semimonthly', 30, 15)).toBe('2026-02-15');
    });

    it('rolls across a year boundary (Dec 30 -> Jan 15)', () => {
      expect(stepScheduleDue('2026-12-15', 'semimonthly', 15, 30)).toBe('2026-12-30');
      expect(stepScheduleDue('2026-12-30', 'semimonthly', 15, 30)).toBe('2027-01-15');
    });

    it('handles a first/last day pair [1, 31] with month-end clamping', () => {
      expect(stepScheduleDue('2026-01-01', 'semimonthly', 1, 31)).toBe('2026-01-31');
      expect(stepScheduleDue('2026-01-31', 'semimonthly', 1, 31)).toBe('2026-02-01');
      expect(stepScheduleDue('2026-02-01', 'semimonthly', 1, 31)).toBe('2026-02-28');
      expect(stepScheduleDue('2026-02-28', 'semimonthly', 1, 31)).toBe('2026-03-01');
    });
  });
});

describe('inferCadence', () => {
  it('returns null for fewer than two dated occurrences', () => {
    expect(inferCadence([])).toBeNull();
    expect(inferCadence(['2026-01-01'])).toBeNull();
  });

  it('infers weekly (6-8 day gaps)', () => {
    expect(inferCadence(['2026-01-01', '2026-01-08', '2026-01-15'])).toBe('weekly');
    expect(inferCadence(['2026-01-01', '2026-01-07'])).toBe('weekly'); // gap 6
    expect(inferCadence(['2026-01-01', '2026-01-09'])).toBe('weekly'); // gap 8
  });

  it('infers biweekly (13-15 day gaps)', () => {
    expect(inferCadence(['2026-01-01', '2026-01-15', '2026-01-29'])).toBe('biweekly');
    expect(inferCadence(['2026-01-01', '2026-01-14'])).toBe('biweekly'); // gap 13
    expect(inferCadence(['2026-01-01', '2026-01-16'])).toBe('biweekly'); // gap 15
  });

  it('infers monthly, tolerating month-length drift (27-31 day gaps)', () => {
    // Jan 31 -> Feb 28 (28d) -> Mar 31 (31d): the anchor-day-safe stepping
    // pattern already used by stepScheduleDue.
    expect(inferCadence(['2026-01-31', '2026-02-28', '2026-03-31'])).toBe('monthly');
    expect(inferCadence(['2026-01-01', '2026-01-28'])).toBe('monthly'); // gap 27
    expect(inferCadence(['2026-01-01', '2026-01-31'])).toBe('monthly'); // gap 30
  });

  it('infers annual, spanning a leap year (360-372 day gaps)', () => {
    // 2028 is a leap year: Jan 1 2028 -> Jan 1 2029 is 366 days.
    expect(inferCadence(['2028-01-01', '2029-01-01'])).toBe('annual');
    // 2026 is not a leap year: Jan 1 2026 -> Jan 1 2027 is 365 days.
    expect(inferCadence(['2026-01-01', '2027-01-01'])).toBe('annual');
    expect(inferCadence(['2026-01-01', '2026-12-27'])).toBe('annual'); // gap 360
  });

  it('degrades to null for irregular gaps rather than guessing (Law 9)', () => {
    // One outlier is enough to withhold the whole series — every gap must
    // independently land in the same band, unlike the fuzzy display-only
    // cadenceLabel (which tolerates one outlier via the median).
    expect(inferCadence(['2026-01-01', '2026-01-08', '2026-03-01'])).toBeNull();
    // Gaps that don't land in ANY supported band (e.g. quarterly-ish 90 days).
    expect(inferCadence(['2026-01-01', '2026-04-01'])).toBeNull();
    // Duplicate dates: zero gaps only, nothing to infer from.
    expect(inferCadence(['2026-01-01', '2026-01-01'])).toBeNull();
  });

  it('drops invalid date strings rather than letting them poison the gap set', () => {
    expect(inferCadence(['2026-01-01', 'not-a-date', '2026-01-31'])).toBe('monthly');
  });
});

describe('annualizedMinor', () => {
  it('multiplies the per-occurrence amount by the cadence count, in pure BigInt', () => {
    expect(annualizedMinor('4500', 'monthly')).toBe(54000n);
    expect(annualizedMinor('1000', 'weekly')).toBe(52000n);
    expect(annualizedMinor('2000', 'biweekly')).toBe(52000n);
    expect(annualizedMinor('120000', 'annual')).toBe(120000n);
    expect(annualizedMinor('0', 'monthly')).toBe(0n);
  });

  it('accepts SIGNED amounts and preserves the sign (review r3604386188 — real outflow series like rent/bills store negative expectedAmountMinor; an unsigned-only guard silently dropped them all)', () => {
    expect(annualizedMinor('-4500', 'monthly')).toBe(-54000n);
    expect(annualizedMinor('-1000', 'weekly')).toBe(-52000n);
  });

  it('handles magnitudes past 2^53 without float precision loss', () => {
    // 2^53 = 9007199254740992; use a per-occurrence amount comfortably past
    // it so a float-based implementation would visibly round.
    expect(annualizedMinor('9007199254740993', 'monthly')).toBe(108086391056891916n);
    expect(annualizedMinor('-9007199254740993', 'monthly')).toBe(-108086391056891916n);
  });

  it('throws rather than silently coercing a malformed amount to 0', () => {
    expect(() => annualizedMinor('', 'monthly')).toThrow();
    expect(() => annualizedMinor('12.50', 'monthly')).toThrow();
    expect(() => annualizedMinor('1e2', 'monthly')).toThrow();
    expect(() => annualizedMinor('--100', 'monthly')).toThrow();
  });
});

describe('annualizedEstimate', () => {
  const occ = (expectedDate: string, expectedAmountMinor: string, currency = 'USD') => ({
    expectedDate,
    expectedAmountMinor,
    currency,
  });

  it('returns null for a single occurrence with no inferable cadence', () => {
    expect(annualizedEstimate([occ('2026-01-01', '4500')])).toBeNull();
    expect(annualizedEstimate([])).toBeNull();
  });

  it('returns null for irregular gaps instead of a fabricated number', () => {
    expect(
      annualizedEstimate([occ('2026-01-01', '4500'), occ('2026-03-01', '4500')]),
    ).toBeNull();
  });

  it('builds the full estimate from the LATEST occurrence (price-change aware)', () => {
    const estimate = annualizedEstimate([
      occ('2026-01-01', '4500'),
      occ('2026-02-01', '4500'),
      // Price change on the most recent occurrence — the estimate should
      // reflect the new price, not an average across history.
      occ('2026-03-01', '5000'),
    ]);
    expect(estimate).toEqual({
      cadence: 'monthly',
      amountMinor: '5000',
      currency: 'USD',
      annualMinor: 60000n,
    });
  });

  it('handles an annual cadence spanning a leap year', () => {
    const estimate = annualizedEstimate([
      occ('2028-01-01', '120000'),
      occ('2029-01-01', '120000'),
    ]);
    expect(estimate).toEqual({
      cadence: 'annual',
      amountMinor: '120000',
      currency: 'USD',
      annualMinor: 120000n,
    });
  });

  it('is unordered-input safe — sorts occurrences before picking the latest', () => {
    const estimate = annualizedEstimate([
      occ('2026-03-01', '5000'),
      occ('2026-01-01', '4500'),
      occ('2026-02-01', '4500'),
    ]);
    expect(estimate?.amountMinor).toBe('5000');
  });

  it('degrades to null on a malformed latest amount rather than throwing', () => {
    expect(
      annualizedEstimate([occ('2026-01-01', '4500'), occ('2026-02-01', '12.50')]),
    ).toBeNull();
  });

  it('builds a real (non-null) estimate for a SIGNED outflow series, preserving the sign (review r3604386188)', () => {
    // Real bills/subscriptions/rent store expectedAmountMinor negative — the
    // exact shape this row is added to summarize; it must not silently
    // disappear.
    const estimate = annualizedEstimate([
      occ('2026-01-01', '-4500'),
      occ('2026-02-01', '-4500'),
      occ('2026-03-01', '-4500'),
    ]);
    expect(estimate).toEqual({
      cadence: 'monthly',
      amountMinor: '-4500',
      currency: 'USD',
      annualMinor: -54000n,
    });
  });
});

describe('CADENCE_SUFFIX', () => {
  it('has a short unit suffix for every supported cadence', () => {
    expect(CADENCE_SUFFIX.weekly).toBe('/wk');
    expect(CADENCE_SUFFIX.biweekly).toBe('/2wk');
    expect(CADENCE_SUFFIX.monthly).toBe('/mo');
    expect(CADENCE_SUFFIX.annual).toBe('/yr');
  });
});

describe('RECURRING_ACTIONS copy (teardown: "cancel" collides with concierge semantics)', () => {
  it('never surfaces the word "Cancel" — KEEL only stops tracking, never acts on the merchant', () => {
    for (const actions of Object.values(RECURRING_ACTIONS)) {
      for (const { label } of actions) {
        expect(label.toLowerCase()).not.toContain('cancel');
      }
    }
  });

  it('labels the recurring.cancel command "Stop tracking" in both eligible statuses', () => {
    expect(RECURRING_ACTIONS.confirmed).toContainEqual({
      command: 'recurring.cancel',
      label: 'Stop tracking',
    });
    expect(RECURRING_ACTIONS.paused).toContainEqual({
      command: 'recurring.cancel',
      label: 'Stop tracking',
    });
  });
});
