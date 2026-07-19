import { describe, expect, it } from 'vitest';
import { resolvePercentMinor, bpToPercentLabel, percentToBp } from './budget-percent';

describe('resolvePercentMinor (mirrors keel_budget_month floor)', () => {
  it('floors base × bp / 10000', () => {
    expect(resolvePercentMinor(300_000n, 2_500)).toBe(75_000n); // 25% of 3000.00
    expect(resolvePercentMinor(999n, 5_000)).toBe(499n); // 4.995 -> floor 4.99
    expect(resolvePercentMinor(499_999n, 2_500)).toBe(124_999n); // matches SQL test 3
    expect(resolvePercentMinor(12_345n, 10_000)).toBe(12_345n);
    expect(resolvePercentMinor(12_345n, 0)).toBe(0n);
  });
});

describe('bpToPercentLabel / percentToBp round-trip', () => {
  it('formats whole and fractional percents', () => {
    expect(bpToPercentLabel(5_000)).toBe('50');
    expect(bpToPercentLabel(1_250)).toBe('12.5');
    expect(bpToPercentLabel(1_275)).toBe('12.75');
    expect(bpToPercentLabel(10_000)).toBe('100');
    expect(bpToPercentLabel(0)).toBe('0');
  });

  it('parses valid percents to bp and rejects the rest', () => {
    expect(percentToBp('50')).toBe(5_000);
    expect(percentToBp('12.5')).toBe(1_250);
    expect(percentToBp('12.75')).toBe(1_275);
    expect(percentToBp('100')).toBe(10_000);
    expect(percentToBp('0')).toBe(0);
    expect(percentToBp('100.01')).toBeNull(); // > 100%
    expect(percentToBp('abc')).toBeNull();
    expect(percentToBp('-5')).toBeNull();
    expect(percentToBp('12.345')).toBeNull(); // too many decimals
  });

  it('label(parse(x)) is stable for canonical inputs', () => {
    for (const s of ['0', '50', '12.5', '12.75', '100', '33.33']) {
      const bp = percentToBp(s);
      expect(bp).not.toBeNull();
      expect(bpToPercentLabel(bp as number)).toBe(s);
    }
  });
});
