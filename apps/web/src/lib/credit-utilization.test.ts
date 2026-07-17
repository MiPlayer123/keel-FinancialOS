import { describe, expect, it } from 'vitest';

import { utilizationPercent } from './credit-utilization';

describe('utilizationPercent', () => {
  it('computes an integer percent with BigInt floor division', () => {
    expect(utilizationPercent('32000', '100000')).toBe(32);
    expect(utilizationPercent('33333', '100000')).toBe(33); // floor, not round
    expect(utilizationPercent('99999', '100000')).toBe(99); // never claims 100% early
    expect(utilizationPercent('100000', '100000')).toBe(100);
    expect(utilizationPercent('0', '100000')).toBe(0);
  });

  it('handles amounts beyond Number-safe precision exactly', () => {
    // 9 007 199 254 740 993 cents owed of 2x that limit — off-by-one if floats sneak in.
    expect(utilizationPercent('9007199254740993', '18014398509481986')).toBe(50);
  });

  it('reads over-limit honestly as >100%', () => {
    expect(utilizationPercent('120000', '100000')).toBe(120);
  });

  it('clamps a credit balance (negative owed) to 0%', () => {
    expect(utilizationPercent('-5000', '100000')).toBe(0);
  });

  it('returns null when no limit exists — the UI degrades to today', () => {
    expect(utilizationPercent('32000', null)).toBeNull();
    expect(utilizationPercent('32000', undefined)).toBeNull();
    expect(utilizationPercent('32000', '')).toBeNull();
    expect(utilizationPercent('32000', '0')).toBeNull();
    expect(utilizationPercent('32000', '-100')).toBeNull();
  });

  it('returns null for unparseable input rather than guessing', () => {
    expect(utilizationPercent('abc', '100000')).toBeNull();
    expect(utilizationPercent('32000', '1e5')).toBeNull();
  });
});
