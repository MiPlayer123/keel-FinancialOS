import { describe, expect, it } from 'vitest';

import { maskAccountLabel } from './account-label';

describe('maskAccountLabel', () => {
  it('appends a masked suffix when a mask is present', () => {
    expect(maskAccountLabel('Chase Checking', '1234')).toBe('Chase Checking ••1234');
  });

  it('falls back to the plain name when mask is null', () => {
    expect(maskAccountLabel('Chase Checking', null)).toBe('Chase Checking');
  });

  it('falls back to the plain name when mask is undefined', () => {
    expect(maskAccountLabel('Chase Checking')).toBe('Chase Checking');
  });

  it('falls back to the plain name when mask is an empty string', () => {
    expect(maskAccountLabel('Chase Checking', '')).toBe('Chase Checking');
  });

  it('falls back to the plain name when mask is whitespace-only', () => {
    expect(maskAccountLabel('Chase Checking', '   ')).toBe('Chase Checking');
  });

  it('trims surrounding whitespace from a real mask', () => {
    expect(maskAccountLabel('Ally Savings', ' 5678 ')).toBe('Ally Savings ••5678');
  });

  it('preserves masks shorter than 4 chars (some institutions report 2-3)', () => {
    expect(maskAccountLabel('Amex Card', '01')).toBe('Amex Card ••01');
  });
});
