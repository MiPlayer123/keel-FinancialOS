import { describe, expect, it } from 'vitest';
import { mapAccountsGetToKeel } from '../src/index.js';

const account = (
  accountId: string,
  type: string,
  currency: string | null = 'USD',
) => ({
  account_id: accountId,
  name: `Account ${accountId}`,
  official_name: null,
  type,
  subtype: type === 'credit' ? 'credit card' : 'checking',
  balances: { iso_currency_code: currency },
});

describe('mapAccountsGetToKeel', () => {
  it('maps all USD accounts without extracting balances', () => {
    const result = mapAccountsGetToKeel({
      accounts: [account('checking-1', 'depository'), account('investment-1', 'investment')],
    });

    expect(result).toEqual({
      accounts: [
        {
          externalRef: 'checking-1',
          name: 'Account checking-1',
          subtype: 'checking',
          currency: 'USD',
          kind: 'asset',
        },
        {
          externalRef: 'investment-1',
          name: 'Account investment-1',
          subtype: 'checking',
          currency: 'USD',
          kind: 'asset',
        },
      ],
      skipped: [],
    });
  });

  it('skips mixed non-USD accounts', () => {
    expect(
      mapAccountsGetToKeel({
        accounts: [account('usd-1', 'depository'), account('cad-1', 'depository', 'CAD')],
      }),
    ).toEqual({
      accounts: [
        {
          externalRef: 'usd-1',
          name: 'Account usd-1',
          subtype: 'checking',
          currency: 'USD',
          kind: 'asset',
        },
      ],
      skipped: [{ externalRef: 'cad-1', currency: 'CAD' }],
    });
  });

  it('maps an empty account list', () => {
    expect(mapAccountsGetToKeel({ accounts: [] })).toEqual({ accounts: [], skipped: [] });
  });

  it('skips an account with missing currency', () => {
    expect(
      mapAccountsGetToKeel({
        accounts: [{ ...account('missing-1', 'depository'), balances: {} }],
      }),
    )
      .toEqual({ accounts: [], skipped: [{ externalRef: 'missing-1', currency: null }] });
  });

  it.each([
    ['credit', 'liability'],
    ['loan', 'liability'],
    ['depository', 'asset'],
  ] as const)('maps %s to %s', (type, kind) => {
    expect(mapAccountsGetToKeel({ accounts: [account(`${type}-1`, type)] }).accounts[0]?.kind)
      .toBe(kind);
  });
});
