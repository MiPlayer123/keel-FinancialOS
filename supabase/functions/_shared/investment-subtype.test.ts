import { looksLikeInvestmentAccount } from './investment-subtype.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('looksLikeInvestmentAccount matches the same policy as the web copy', async (test) => {
  await test.step('matches common Plaid investment subtypes', () => {
    for (const subtype of ['brokerage', 'ira', '401k', 'roth', 'hsa', 'non-taxable brokerage account']) {
      assert(looksLikeInvestmentAccount(subtype), subtype);
    }
  });

  await test.step('matches the manual account subtype and is case-insensitive', () => {
    assert(looksLikeInvestmentAccount('investment'));
    assert(looksLikeInvestmentAccount('IRA'));
    assert(looksLikeInvestmentAccount('Brokerage'));
  });

  await test.step('does not match everyday account types', () => {
    for (const subtype of ['checking', 'savings', 'credit card', 'cash']) {
      assert(!looksLikeInvestmentAccount(subtype), subtype);
    }
  });
});
