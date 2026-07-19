import {
  PLAID_INVESTMENT_SUBTYPES,
  isHoldingsSyncEligibleSubtype,
  looksLikeInvestmentAccount,
} from './investment-subtype.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('investment subtype policy matches the web copy (canonical list)', async (test) => {
  await test.step('matches every published Plaid investment subtype exactly', () => {
    for (const subtype of PLAID_INVESTMENT_SUBTYPES) {
      assert(looksLikeInvestmentAccount(subtype), subtype);
      assert(isHoldingsSyncEligibleSubtype(subtype), subtype);
    }
  });

  await test.step('covers the subtypes the old keyword list missed', () => {
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
    ]) {
      assert(looksLikeInvestmentAccount(subtype), subtype);
    }
  });

  await test.step('matches the manual account subtype and is case-insensitive', () => {
    assert(looksLikeInvestmentAccount('investment'));
    assert(looksLikeInvestmentAccount('IRA'));
    assert(looksLikeInvestmentAccount('Brokerage'));
    assert(looksLikeInvestmentAccount('Crypto Exchange'));
  });

  await test.step('cash management is display-tier only, never provider-call eligible', () => {
    assert(looksLikeInvestmentAccount('cash management'));
    assert(!isHoldingsSyncEligibleSubtype('cash management'));
  });

  await test.step('does not match everyday account types', () => {
    for (const subtype of [
      'checking',
      'savings',
      'credit card',
      'cash',
      'cd',
      'money market',
      'paypal',
      // subtype-only 'other' is ambiguous across Plaid types — the worker
      // catches live type=investment accounts via Plaid's `type` field.
      'other',
    ]) {
      assert(!looksLikeInvestmentAccount(subtype), subtype);
      assert(!isHoldingsSyncEligibleSubtype(subtype), subtype);
    }
  });
});
