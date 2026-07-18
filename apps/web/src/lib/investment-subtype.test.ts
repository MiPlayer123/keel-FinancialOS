import { describe, expect, it } from 'vitest';

import { looksLikeInvestmentAccount, looksLikeRetirementAccount } from './investment-subtype';

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

describe('looksLikeRetirementAccount', () => {
  it('matches retirement-class subtypes', () => {
    expect(looksLikeRetirementAccount('ira')).toBe(true);
    expect(looksLikeRetirementAccount('401k')).toBe(true);
    expect(looksLikeRetirementAccount('403B')).toBe(true);
    expect(looksLikeRetirementAccount('roth 401k')).toBe(true);
    expect(looksLikeRetirementAccount('pension')).toBe(true);
    expect(looksLikeRetirementAccount('retirement')).toBe(true);
  });

  it('is a strict subset of investment: taxable investing is NOT retirement', () => {
    expect(looksLikeRetirementAccount('brokerage')).toBe(false);
    expect(looksLikeRetirementAccount('hsa')).toBe(false);
    expect(looksLikeRetirementAccount('529')).toBe(false);
    expect(looksLikeRetirementAccount('mutual fund')).toBe(false);
    expect(looksLikeRetirementAccount('stock plan')).toBe(false);
  });

  it('does not match everyday account types', () => {
    expect(looksLikeRetirementAccount('checking')).toBe(false);
    expect(looksLikeRetirementAccount('credit card')).toBe(false);
    expect(looksLikeRetirementAccount('cash management')).toBe(false);
  });
});
