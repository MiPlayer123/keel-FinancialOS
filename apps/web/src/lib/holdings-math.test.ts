import { describe, expect, it } from 'vitest';

import { computeHoldingValueMinor, formatGainBpsLabel } from './holdings-math';

describe('computeHoldingValueMinor', () => {
  it('computes whole shares exactly', () => {
    // 10 shares @ $150.42 (15042 minor) = $1504.20
    expect(computeHoldingValueMinor('10', '15042')).toBe('150420');
  });

  it('computes fractional shares exactly', () => {
    // 1.5 shares @ $100.00 (10000 minor) = $150.00
    expect(computeHoldingValueMinor('1.5', '10000')).toBe('15000');
  });

  it('handles very small fractional (crypto-style) quantities', () => {
    // 0.001 shares @ $50,000.00 (5000000 minor) = $50.00
    expect(computeHoldingValueMinor('0.001', '5000000')).toBe('5000');
  });

  it('rounds half up on a fractional-cent result', () => {
    // 3 shares @ $0.005 minor-equivalent — contrived to land exactly on .5
    expect(computeHoldingValueMinor('0.5', '3')).toBe('2'); // 1.5 rounds to 2
  });

  it('rejects a zero or negative quantity', () => {
    expect(computeHoldingValueMinor('0', '10000')).toBeNull();
    expect(computeHoldingValueMinor('-1', '10000')).toBeNull();
  });

  it('rejects a non-numeric quantity or price', () => {
    expect(computeHoldingValueMinor('abc', '10000')).toBeNull();
    expect(computeHoldingValueMinor('1', 'abc')).toBeNull();
  });

  it('rejects more than 8 fractional digits', () => {
    expect(computeHoldingValueMinor('1.123456789', '10000')).toBeNull();
  });

  it('allows a zero price (e.g. a worthless or unpriced position)', () => {
    expect(computeHoldingValueMinor('5', '0')).toBe('0');
  });
});

describe('formatGainBpsLabel', () => {
  it('formats a positive gain with a leading plus and one decimal', () => {
    // 2500 bps = +25.0%
    expect(formatGainBpsLabel('2500')).toBe('+25.0%');
  });

  it('formats a loss with a U+2212 minus (never an ASCII hyphen)', () => {
    // −1234 bps = −12.3% (truncated toward zero, matching percentDeltaLabel)
    expect(formatGainBpsLabel('-1234')).toBe('−12.3%');
    expect(formatGainBpsLabel('-1234')).toContain('−');
    expect(formatGainBpsLabel('-1234')).not.toContain('-');
  });

  it('truncates toward zero at one decimal (no rounding surprises)', () => {
    // 1256 bps = 12.56% -> tenths=125 -> 12.5% (truncated, not rounded to 12.6)
    expect(formatGainBpsLabel('1256')).toBe('+12.5%');
  });

  it('renders exact zero as a plain 0.0% (no sign)', () => {
    expect(formatGainBpsLabel('0')).toBe('0.0%');
  });

  it('keeps a tiny negative sign (−0.0%), never flipping to +0.0%', () => {
    // −4 bps -> tenths=0 but sign comes from the value itself
    expect(formatGainBpsLabel('-4')).toBe('−0.0%');
  });

  it('passes null through as null (missing/zero basis has no defined return)', () => {
    expect(formatGainBpsLabel(null)).toBeNull();
  });

  it('rejects a non-integer string defensively', () => {
    expect(formatGainBpsLabel('12.5')).toBeNull();
    expect(formatGainBpsLabel('abc')).toBeNull();
  });
});
