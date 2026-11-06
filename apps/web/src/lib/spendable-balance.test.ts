import { describe, expect, it } from 'vitest';

import { isCashAccountSubtype, minorDiffers, spendableLeadMinor } from './spendable-balance';

describe('isCashAccountSubtype', () => {
  it('matches checking and savings', () => {
    expect(isCashAccountSubtype('checking')).toBe(true);
    expect(isCashAccountSubtype('savings')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isCashAccountSubtype(' Checking ')).toBe(true);
    expect(isCashAccountSubtype('SAVINGS')).toBe(true);
  });

  it('does not match investment subtypes that contain "savings"', () => {
    expect(isCashAccountSubtype('education savings account')).toBe(false);
    expect(isCashAccountSubtype('thrift savings plan')).toBe(false);
    expect(isCashAccountSubtype('health_savings_account')).toBe(false);
  });

  it('does not match cards, loans or brokerage', () => {
    expect(isCashAccountSubtype('credit card')).toBe(false);
    expect(isCashAccountSubtype('credit_card')).toBe(false);
    expect(isCashAccountSubtype('mortgage')).toBe(false);
    expect(isCashAccountSubtype('brokerage')).toBe(false);
  });
});

describe('spendableLeadMinor', () => {
  const lead = (
    subtype: string,
    kind: string,
    availableMinor: string | null | undefined,
    ledgerMinor = '500000',
  ) => spendableLeadMinor({ subtype, kind, availableMinor, ledgerMinor });

  it('leads with available when a pending debit makes it lower than the ledger', () => {
    expect(lead('checking', 'asset', '123456')).toBe('123456');
  });

  it('leads with available for savings', () => {
    expect(lead('savings', 'asset', '400000')).toBe('400000');
  });

  it('still leads with available when it equals the ledger', () => {
    expect(lead('savings', 'asset', '500000')).toBe('500000');
  });

  it('keeps the ledger when available is HIGHER than the ledger (overdraft line, pending deposit)', () => {
    expect(lead('checking', 'asset', '500001')).toBe(null);
    expect(lead('checking', 'asset', '900000')).toBe(null);
  });

  it('passes a zero available figure through (it is still the bank figure)', () => {
    expect(lead('checking', 'asset', '0')).toBe('0');
  });

  it('passes a negative available figure through unchanged', () => {
    expect(lead('checking', 'asset', '-2500')).toBe('-2500');
  });

  it('returns null when the bank reports no available figure', () => {
    expect(lead('checking', 'asset', null)).toBe(null);
    expect(lead('checking', 'asset', undefined)).toBe(null);
    expect(lead('checking', 'asset', '')).toBe(null);
  });

  it('returns null when either figure is not an integer string', () => {
    expect(lead('checking', 'asset', '12.50')).toBe(null);
    expect(lead('checking', 'asset', '100', 'abc')).toBe(null);
  });

  it('never applies to a credit card, whose available is remaining credit', () => {
    expect(lead('credit card', 'liability', '100')).toBe(null);
  });

  it('never applies to a non-asset ledger kind, even with a cash subtype', () => {
    expect(lead('checking', 'liability', '100')).toBe(null);
  });

  it('never applies to investment accounts', () => {
    expect(lead('brokerage', 'asset', '100')).toBe(null);
  });
});

describe('minorDiffers', () => {
  it('is false for the same amount, including leading zeros', () => {
    expect(minorDiffers('500', '500')).toBe(false);
    expect(minorDiffers('500', '0500')).toBe(false);
  });

  it('is true for different amounts', () => {
    expect(minorDiffers('123456', '500000')).toBe(true);
    expect(minorDiffers('-1', '1')).toBe(true);
  });
});
