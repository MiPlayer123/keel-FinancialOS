import { describe, expect, it } from 'vitest';

import { looksLikeInvestmentAccount } from './investment-subtype';

describe('looksLikeInvestmentAccount', () => {
  it('matches common Plaid investment subtypes', () => {
    expect(looksLikeInvestmentAccount('brokerage')).toBe(true);
    expect(looksLikeInvestmentAccount('ira')).toBe(true);
    expect(looksLikeInvestmentAccount('401k')).toBe(true);
    expect(looksLikeInvestmentAccount('roth')).toBe(true);
    expect(looksLikeInvestmentAccount('hsa')).toBe(true);
    expect(looksLikeInvestmentAccount('non-taxable brokerage account')).toBe(true);
  });

  it('matches the manual account subtype', () => {
    expect(looksLikeInvestmentAccount('investment')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(looksLikeInvestmentAccount('IRA')).toBe(true);
    expect(looksLikeInvestmentAccount('Brokerage')).toBe(true);
  });

  it('does not match everyday account types', () => {
    expect(looksLikeInvestmentAccount('checking')).toBe(false);
    expect(looksLikeInvestmentAccount('savings')).toBe(false);
    expect(looksLikeInvestmentAccount('credit card')).toBe(false);
    expect(looksLikeInvestmentAccount('cash')).toBe(false);
  });
});
