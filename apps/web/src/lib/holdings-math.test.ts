import { describe, expect, it } from 'vitest';

import { computeHoldingValueMinor } from './holdings-math';

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
