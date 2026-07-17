import { describe, expect, it } from 'vitest';

import {
  availableHistoryDays,
  computeWindowDelta,
  percentDeltaLabel,
  sliceWindow,
  TREND_FETCH_DAYS,
  TREND_RANGES,
} from './net-worth-window';

function pt(date: string, balanceMinor: string) {
  return { date, balanceMinor };
}

describe('percentDeltaLabel', () => {
  it('formats one decimal from scaled integer math (no floats)', () => {
    // 1234 / 10000 = 12.34% → truncates to 12.3
    expect(percentDeltaLabel(1234n, 10000n)).toBe('+12.3%');
  });

  it('truncates toward zero, never rounds up', () => {
    // 199 / 1000 = 19.9%; 1999/10000 = 19.99% → 19.9, not 20.0
    expect(percentDeltaLabel(1999n, 10000n)).toBe('+19.9%');
    expect(percentDeltaLabel(-1999n, 10000n)).toBe('−19.9%');
  });

  it('uses U+2212 minus and keeps the sign on sub-tenth negatives', () => {
    // −4 / 10000 = −0.04% → "−0.0%", not "+0.0%"
    expect(percentDeltaLabel(-4n, 10000n)).toBe('−0.0%');
  });

  it('returns 0.0% unsigned for a zero delta', () => {
    expect(percentDeltaLabel(0n, 12345n)).toBe('0.0%');
  });

  it('returns null when the baseline is zero', () => {
    expect(percentDeltaLabel(500n, 0n)).toBeNull();
  });

  it('measures against |base| when the baseline is negative', () => {
    // From −10000 up by +2500 → +25.0% of the magnitude owed.
    expect(percentDeltaLabel(2500n, -10000n)).toBe('+25.0%');
  });

  it('is exact far beyond Number.MAX_SAFE_INTEGER', () => {
    const base = 10n ** 18n; // $10 quadrillion in cents
    const delta = base / 8n; // exactly 12.5%
    expect(percentDeltaLabel(delta, base)).toBe('+12.5%');
    expect(percentDeltaLabel(-delta, base)).toBe('−12.5%');
  });

  it('handles >100% moves', () => {
    expect(percentDeltaLabel(30000n, 10000n)).toBe('+300.0%');
  });
});

describe('computeWindowDelta', () => {
  it('computes Δ and % between window endpoints', () => {
    const d = computeWindowDelta([
      pt('2026-04-18', '1000000'),
      pt('2026-05-01', '900000'),
      pt('2026-07-17', '1042000'),
    ]);
    expect(d).not.toBeNull();
    expect(d?.firstMinor).toBe('1000000');
    expect(d?.lastMinor).toBe('1042000');
    expect(d?.deltaMinor).toBe('42000');
    expect(d?.pctLabel).toBe('+4.2%');
  });

  it('produces a signed negative delta string', () => {
    const d = computeWindowDelta([pt('2026-06-17', '500000'), pt('2026-07-17', '450000')]);
    expect(d?.deltaMinor).toBe('-50000');
    expect(d?.pctLabel).toBe('−10.0%');
  });

  it('yields null pctLabel when the window starts at exactly zero', () => {
    const d = computeWindowDelta([pt('2026-06-17', '0'), pt('2026-07-17', '250000')]);
    expect(d?.deltaMinor).toBe('250000');
    expect(d?.pctLabel).toBeNull();
  });

  it('returns null for fewer than two points', () => {
    expect(computeWindowDelta([])).toBeNull();
    expect(computeWindowDelta([pt('2026-07-17', '100')])).toBeNull();
  });
});

describe('sliceWindow', () => {
  const series = [
    pt('2026-04-01', '1'),
    pt('2026-06-16', '2'),
    pt('2026-06-17', '3'),
    pt('2026-07-17', '4'),
  ];

  it('anchors on the last point and keeps the boundary day', () => {
    // 30 days back from 2026-07-17 is 2026-06-17 — inclusive.
    expect(sliceWindow(series, 30).map((p) => p.date)).toEqual([
      '2026-06-17',
      '2026-07-17',
    ]);
  });

  it('returns everything when the window covers the whole series', () => {
    expect(sliceWindow(series, 365)).toHaveLength(4);
  });

  it('returns [] for an empty series', () => {
    expect(sliceWindow([], 30)).toEqual([]);
  });
});

describe('availableHistoryDays', () => {
  it('ignores the zero-padded lead-in before the first posting', () => {
    expect(
      availableHistoryDays([pt('d1', '0'), pt('d2', '0'), pt('d3', '100'), pt('d4', '90')]),
    ).toBe(2);
  });

  it('counts the full series when it starts nonzero', () => {
    expect(availableHistoryDays([pt('d1', '-5'), pt('d2', '0'), pt('d3', '100')])).toBe(3);
  });

  it('is zero for an all-zero or empty series', () => {
    expect(availableHistoryDays([])).toBe(0);
    expect(availableHistoryDays([pt('d1', '0'), pt('d2', '0')])).toBe(0);
  });
});

describe('range configuration', () => {
  it('never offers a range longer than the fetch window (no invented data)', () => {
    for (const r of TREND_RANGES) expect(r.days).toBeLessThanOrEqual(TREND_FETCH_DAYS);
  });

  it('stays within the server 366-day span cap', () => {
    expect(TREND_FETCH_DAYS).toBeLessThanOrEqual(366);
  });
});
