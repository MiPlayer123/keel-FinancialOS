import { describe, expect, it } from 'vitest';

import { isCashAccountSubtype, spendableLeadMinor } from './spendable-balance';

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
  it('leads with available for a checking asset that reports it', () => {
    expect(
      spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: '123456' }),
    ).toBe('123456');
  });

  it('leads with available for savings', () => {
    expect(
      spendableLeadMinor({ subtype: 'savings', kind: 'asset', availableMinor: '500000' }),
    ).toBe('500000');
  });

  it('passes a zero available figure through (it is still the bank figure)', () => {
    expect(spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: '0' })).toBe(
      '0',
    );
  });

  it('passes a negative available figure through unchanged', () => {
    expect(
      spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: '-2500' }),
    ).toBe('-2500');
  });

  it('returns null when the bank reports no available figure', () => {
    expect(spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: null })).toBe(
      null,
    );
    expect(
      spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: undefined }),
    ).toBe(null);
    expect(spendableLeadMinor({ subtype: 'checking', kind: 'asset', availableMinor: '' })).toBe(
      null,
    );
  });

  it('never applies to a credit card, whose available is remaining credit', () => {
    expect(
      spendableLeadMinor({ subtype: 'credit card', kind: 'liability', availableMinor: '900000' }),
    ).toBe(null);
  });

  it('never applies to a non-asset ledger kind, even with a cash subtype', () => {
    expect(
      spendableLeadMinor({ subtype: 'checking', kind: 'liability', availableMinor: '100' }),
    ).toBe(null);
  });

  it('never applies to investment accounts', () => {
    expect(spendableLeadMinor({ subtype: 'brokerage', kind: 'asset', availableMinor: '100' })).toBe(
      null,
    );
  });
});
