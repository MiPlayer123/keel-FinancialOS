import { describe, expect, it } from 'vitest';

import { formatMoney, minorToDollarsInput, parseDollarsToMinorString } from '@/lib/money';

describe('formatMoney', () => {
  it('formats positive, negative, and signed amounts', () => {
    expect(formatMoney('699')).toBe('$6.99');
    expect(formatMoney('-699')).toBe('−$6.99');
    expect(formatMoney('699', { signed: true })).toBe('+$6.99');
    expect(formatMoney('0')).toBe('$0.00');
  });

  it('never leaks a stray double sign into the dollars/cents split', () => {
    // Regression: an upstream "-" prepended to an already-negative "-699"
    // produced "--699", which formatted as "−$-6.−99". Magnitude now strips
    // every dash, sign is decided once.
    expect(formatMoney('--699')).toBe('−$6.99');
    expect(formatMoney('--699', { signed: true })).toBe('−$6.99');
  });
});

/**
 * C18 residual (rules amount-range condition): these two round-trip helpers
 * back the rule builder's "at least / at most" dollar inputs. Money stays
 * BigInt end to end (Law 4) — parseDollarsToMinorString never touches a
 * float, and returns null (never throws, never silently coerces) for
 * anything that isn't a clean non-negative dollar amount.
 */
describe('parseDollarsToMinorString', () => {
  it('parses a whole-dollar amount', () => {
    expect(parseDollarsToMinorString('50')).toBe('5000');
  });

  it('parses cents', () => {
    expect(parseDollarsToMinorString('12.50')).toBe('1250');
  });

  it('pads a single fractional digit', () => {
    expect(parseDollarsToMinorString('1.5')).toBe('150');
  });

  it('strips a leading dollar sign and thousands separators', () => {
    expect(parseDollarsToMinorString('$1,234.56')).toBe('123456');
  });

  it('accepts zero', () => {
    expect(parseDollarsToMinorString('0')).toBe('0');
  });

  it('rejects blank input', () => {
    expect(parseDollarsToMinorString('')).toBeNull();
    expect(parseDollarsToMinorString('   ')).toBeNull();
  });

  it('rejects a negative amount (magnitude-only field)', () => {
    expect(parseDollarsToMinorString('-5')).toBeNull();
  });

  it('rejects more than two fractional digits', () => {
    expect(parseDollarsToMinorString('1.234')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(parseDollarsToMinorString('abc')).toBeNull();
  });
});

describe('minorToDollarsInput', () => {
  it('formats whole dollars', () => {
    expect(minorToDollarsInput('5000')).toBe('50.00');
  });

  it('formats cents with a leading zero', () => {
    expect(minorToDollarsInput('105')).toBe('1.05');
  });

  it('round-trips through parseDollarsToMinorString', () => {
    const minor = parseDollarsToMinorString('1234.56');
    expect(minor).not.toBeNull();
    expect(minorToDollarsInput(minor as string)).toBe('1234.56');
  });
});
