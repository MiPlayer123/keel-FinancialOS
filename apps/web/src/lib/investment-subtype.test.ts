import { describe, expect, it } from 'vitest';

import {
  PLAID_INVESTMENT_SUBTYPES,
  isCashManagementSubtype,
  isHoldingsSyncEligibleSubtype,
  isPlaidInvestmentSubtype,
  looksLikeInvestmentAccount,
  looksLikeRetirementAccount,
} from './investment-subtype';

describe('looksLikeInvestmentAccount (display tier)', () => {
  it('matches EVERY published Plaid investment subtype exactly', () => {
    for (const subtype of PLAID_INVESTMENT_SUBTYPES) {
      expect(looksLikeInvestmentAccount(subtype), subtype).toBe(true);
      expect(isPlaidInvestmentSubtype(subtype), subtype).toBe(true);
    }
  });

  it('covers the subtypes the old keyword list missed', () => {
    for (const subtype of [
      'crypto exchange',
      'trust',
      '401a',
      '457b',
      'sep ira',
      'simple ira',
      'tfsa',
      'rrsp',
      'education savings account',
      'thrift savings plan',
      'ugma',
      'utma',
      'keogh',
      'sarsep',
      'profit sharing plan',
      'non-custodial wallet',
    ]) {
      expect(looksLikeInvestmentAccount(subtype), subtype).toBe(true);
    }
  });

  it('matches common Plaid investment subtypes', () => {
    expect(looksLikeInvestmentAccount('brokerage')).toBe(true);
    expect(looksLikeInvestmentAccount('ira')).toBe(true);
    expect(looksLikeInvestmentAccount('401k')).toBe(true);
    expect(looksLikeInvestmentAccount('roth')).toBe(true);
    expect(looksLikeInvestmentAccount('hsa')).toBe(true);
    expect(looksLikeInvestmentAccount('non-taxable brokerage account')).toBe(true);
  });

  it('includes cash management at the DISPLAY tier only (20260718122000 ruling)', () => {
    expect(looksLikeInvestmentAccount('cash management')).toBe(true);
    expect(isCashManagementSubtype('cash management')).toBe(true);
    expect(isCashManagementSubtype('brokerage')).toBe(false);
    // …but a depository cash-management account must never by itself make a
    // connection eligible for a Plaid Investments call.
    expect(isHoldingsSyncEligibleSubtype('cash management')).toBe(false);
  });

  it('matches the manual account subtype', () => {
    expect(looksLikeInvestmentAccount('investment')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(looksLikeInvestmentAccount('IRA')).toBe(true);
    expect(looksLikeInvestmentAccount('Brokerage')).toBe(true);
    expect(looksLikeInvestmentAccount('Crypto Exchange')).toBe(true);
  });

  it('does not match everyday account types', () => {
    for (const subtype of [
      'checking',
      'savings',
      'credit card',
      'cash',
      'cd',
      'money market',
      'paypal',
      'prepaid',
      'mortgage',
      'student',
      'auto',
      // 'other' is ambiguous across Plaid types when only the subtype is
      // stored — deliberately unclassified (the worker catches live
      // type=investment accounts via Plaid's `type` field instead).
      'other',
    ]) {
      expect(looksLikeInvestmentAccount(subtype), subtype).toBe(false);
    }
  });
});

describe('isHoldingsSyncEligibleSubtype (provider-call tier)', () => {
  it('matches every published Plaid investment subtype', () => {
    for (const subtype of PLAID_INVESTMENT_SUBTYPES) {
      expect(isHoldingsSyncEligibleSubtype(subtype), subtype).toBe(true);
    }
  });

  it('is exactly the display tier minus cash management', () => {
    for (const subtype of ['brokerage', 'investment', 'sep ira', 'crypto exchange', 'checking']) {
      expect(isHoldingsSyncEligibleSubtype(subtype), subtype).toBe(
        looksLikeInvestmentAccount(subtype),
      );
    }
    expect(looksLikeInvestmentAccount('cash management')).toBe(true);
    expect(isHoldingsSyncEligibleSubtype('cash management')).toBe(false);
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
