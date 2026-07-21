import { describe, expect, it } from 'vitest';
import { mapHoldingsGetToKeel, mapInvestmentsTransactionsToKeel } from '../src/index.js';

const security = (
  securityId: string,
  overrides: Record<string, unknown> = {},
) => ({
  security_id: securityId,
  name: `Security ${securityId}`,
  ticker_symbol: 'VTI',
  type: 'etf',
  close_price: 250.5,
  close_price_as_of: '2026-07-17',
  iso_currency_code: 'USD',
  ...overrides,
});

const holding = (
  accountId: string,
  securityId: string,
  overrides: Record<string, unknown> = {},
) => ({
  account_id: accountId,
  security_id: securityId,
  institution_price: 251,
  institution_price_as_of: '2026-07-18',
  institution_value: 2510,
  quantity: 10,
  cost_basis: 2000,
  iso_currency_code: 'USD',
  ...overrides,
});

describe('mapHoldingsGetToKeel', () => {
  it('maps a basic USD equity holding, preferring institution_price over close_price', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1')],
      securities: [security('sec-1')],
    });

    expect(result).toEqual({
      holdings: [
        {
          accountExternalRef: 'acct-1',
          symbol: 'VTI',
          name: 'Security sec-1',
          qty: '10',
          priceMinor: '25100',
          costBasisMinor: '200000',
          currency: 'USD',
          securityType: 'etf',
        },
      ],
      skipped: [],
    });
  });

  it('maps the security type through for allocation bucketing', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1')],
      securities: [security('sec-1', { type: 'fixed income' })],
    });
    expect(result.holdings[0]?.securityType).toBe('fixed income');
  });

  it('maps a missing security type to null', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1')],
      securities: [security('sec-1', { type: null })],
    });
    expect(result.holdings[0]?.securityType).toBeNull();
  });

  it('falls back to the security close_price when institution_price is missing', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { institution_price: null })],
      securities: [security('sec-1', { close_price: 99.99 })],
    });
    expect(result.holdings[0]?.priceMinor).toBe('9999');
  });

  it('preserves fractional share quantities without float drift', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { quantity: 0.001 })],
      securities: [security('sec-1')],
    });
    expect(result.holdings[0]?.qty).toBe('0.001');
  });

  it('trims trailing zeros from whole-share quantities', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { quantity: 5 })],
      securities: [security('sec-1')],
    });
    expect(result.holdings[0]?.qty).toBe('5');
  });

  it('falls back to security name when ticker_symbol is missing', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1')],
      securities: [security('sec-1', { ticker_symbol: null, name: 'Private Fund XYZ' })],
    });
    expect(result.holdings[0]?.symbol).toBe('PRIVATE FUND XYZ');
  });

  it('falls back to security_id when both ticker_symbol and name are missing', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1')],
      securities: [security('sec-1', { ticker_symbol: null, name: null })],
    });
    expect(result.holdings[0]?.symbol).toBe('SEC-1');
  });

  it('keeps equities and funds while skipping only the cash sweep in a mixed brokerage (2026-07-19 Fidelity regression)', () => {
    // Regression for the "brokerage shows 0 holdings" incident: a real
    // brokerage response mixes an equity + an index fund + a money-market
    // sweep (type 'cash'). Only the sweep may be skipped (its value is the
    // account cash balance); the equity and fund MUST survive the mapper.
    const result = mapHoldingsGetToKeel({
      holdings: [
        holding('acct-1', 'sec-eq', { institution_value: 15000, quantity: 50, cost_basis: 9000, institution_price: 300 }),
        holding('acct-1', 'sec-fund', { institution_value: 5020, quantity: 20, cost_basis: 4000 }),
        holding('acct-1', 'sec-mmkt', { institution_price: 1, institution_value: 42000, quantity: 42000, cost_basis: 42000 }),
      ],
      securities: [
        security('sec-eq', { ticker_symbol: 'EQTY', type: 'equity' }),
        security('sec-fund', { ticker_symbol: 'IDXF', type: 'mutual fund' }),
        security('sec-mmkt', { ticker_symbol: 'MMKT', type: 'cash' }),
      ],
    });

    expect(result.holdings.map((h) => h.symbol)).toEqual(['EQTY', 'IDXF']);
    expect(result.skipped).toEqual([
      { accountExternalRef: 'acct-1', securityId: 'sec-mmkt', reason: 'cash_equivalent' },
    ]);
  });

  it('skips cash-equivalent securities (the account balance already covers cash)', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-cash')],
      securities: [security('sec-cash', { type: 'cash' })],
    });
    expect(result).toEqual({
      holdings: [],
      skipped: [{ accountExternalRef: 'acct-1', securityId: 'sec-cash', reason: 'cash_equivalent' }],
    });
  });

  it('skips a holding whose security cannot be resolved', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'missing-sec')],
      securities: [],
    });
    expect(result.skipped).toEqual([
      { accountExternalRef: 'acct-1', securityId: 'missing-sec', reason: 'unresolved_security' },
    ]);
  });

  it('skips non-USD holdings', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { iso_currency_code: 'CAD' })],
      securities: [security('sec-1', { iso_currency_code: 'CAD' })],
    });
    expect(result.skipped).toEqual([
      { accountExternalRef: 'acct-1', securityId: 'sec-1', reason: 'non_usd' },
    ]);
  });

  it('skips a zero or negative quantity', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { quantity: 0 })],
      securities: [security('sec-1')],
    });
    expect(result.skipped).toEqual([
      { accountExternalRef: 'acct-1', securityId: 'sec-1', reason: 'invalid_quantity' },
    ]);
  });

  it('skips when neither institution_price nor close_price is usable', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { institution_price: null })],
      securities: [security('sec-1', { close_price: null })],
    });
    expect(result.skipped).toEqual([
      { accountExternalRef: 'acct-1', securityId: 'sec-1', reason: 'invalid_price' },
    ]);
  });

  it('maps a null cost_basis to null rather than 0', () => {
    const result = mapHoldingsGetToKeel({
      holdings: [holding('acct-1', 'sec-1', { cost_basis: null })],
      securities: [security('sec-1')],
    });
    expect(result.holdings[0]?.costBasisMinor).toBeNull();
  });

  it('maps an empty holdings list', () => {
    expect(mapHoldingsGetToKeel({ holdings: [], securities: [] })).toEqual({
      holdings: [],
      skipped: [],
    });
  });

  it('rejects a response missing the holdings or securities array', () => {
    expect(() => mapHoldingsGetToKeel({ holdings: [] })).toThrow();
    expect(() => mapHoldingsGetToKeel({})).toThrow();
  });
});

const invTxn = (
  id: string,
  overrides: Record<string, unknown> = {},
) => ({
  investment_transaction_id: id,
  account_id: 'acct-1',
  security_id: 'sec-1',
  type: 'cash',
  subtype: 'dividend',
  amount: -12.5,
  date: '2026-07-15',
  name: 'DIVIDEND RECEIVED',
  iso_currency_code: 'USD',
  ...overrides,
});

describe('mapInvestmentsTransactionsToKeel', () => {
  it('maps a dividend (cash in) to a positive account-effect amount', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [invTxn('itx-1')],
      securities: [],
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toEqual({
      accountExternalRef: 'acct-1',
      providerTransactionId: 'itx-1',
      // Plaid amount -12.50 (cash IN) -> account effect +1250 minor.
      amountMinor: '1250',
      currency: 'USD',
      date: '2026-07-15',
      description: 'DIVIDEND RECEIVED',
      flow: 'dividend_interest',
      plaidType: 'cash',
      plaidSubtype: 'dividend',
      // No joined security (securities: []) -> not a cash-equivalent.
      isCashEquivalent: false,
    });
  });

  it('flags a buy of a cash-equivalent core sweep (SPAXX) as isCashEquivalent', () => {
    // A "PURCHASE INTO CORE ACCOUNT (SPAXX)" sweep: type=buy on a security
    // whose Plaid type is 'cash'. The RPC suppresses these.
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('sweep-buy', {
          type: 'buy',
          subtype: 'buy',
          security_id: 'sec-core',
          amount: 250,
          name: 'PURCHASE INTO CORE ACCOUNT (SPAXX)',
        }),
      ],
      securities: [security('sec-core', { ticker_symbol: 'SPAXX', type: 'cash' })],
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.flow).toBe('buy');
    expect(result.transactions[0]?.isCashEquivalent).toBe(true);
  });

  it('does NOT flag a buy of a real equity as cash-equivalent', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('eq-buy', {
          type: 'buy',
          subtype: 'buy',
          security_id: 'sec-eq',
          amount: 500,
          name: 'BUY FSKAX',
        }),
      ],
      securities: [security('sec-eq', { ticker_symbol: 'FSKAX', type: 'mutual fund' })],
    });
    expect(result.transactions[0]?.isCashEquivalent).toBe(false);
  });

  it('leaves isCashEquivalent false for a cash deposit with no joined security', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('dep', { type: 'cash', subtype: 'deposit', amount: -25000, security_id: null }),
      ],
      securities: [],
    });
    expect(result.transactions[0]?.flow).toBe('deposit');
    expect(result.transactions[0]?.isCashEquivalent).toBe(false);
  });

  it('maps a buy (cash out) to a negative account-effect amount', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('itx-2', { type: 'buy', subtype: 'buy', amount: 500, name: 'BUY VTI' }),
      ],
      securities: [],
    });
    // Plaid amount +500 (cash OUT) -> account effect -50000 minor.
    expect(result.transactions[0]?.amountMinor).toBe('-50000');
    expect(result.transactions[0]?.flow).toBe('buy');
  });

  it('classifies deposits, withdrawals, transfers, and fees', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('d', { type: 'cash', subtype: 'deposit', amount: -100 }),
        invTxn('w', { type: 'cash', subtype: 'withdrawal', amount: 100 }),
        invTxn('f', { type: 'fee', subtype: 'management fee', amount: 5 }),
        invTxn('ti', { type: 'transfer', subtype: 'transfer', amount: -200 }),
      ],
      securities: [],
    });
    const byId = new Map(result.transactions.map((t) => [t.providerTransactionId, t]));
    expect(byId.get('d')?.flow).toBe('deposit');
    expect(byId.get('w')?.flow).toBe('withdrawal');
    expect(byId.get('f')?.flow).toBe('fee');
    expect(byId.get('ti')?.flow).toBe('other');
  });

  it('skips cancelled, non-USD, and zero-amount transactions', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('c', { type: 'cancel' }),
        invTxn('n', { iso_currency_code: 'EUR' }),
        invTxn('z', { amount: 0 }),
      ],
      securities: [],
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual([
      'cancelled',
      'non_usd',
      'zero_amount',
    ]);
  });

  it('falls back to the security name when the transaction has no name', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [invTxn('s', { name: null })],
      securities: [{ security_id: 'sec-1', name: 'Vanguard Total Stock' }],
    });
    expect(result.transactions[0]?.description).toBe('Vanguard Total Stock');
  });

  it('accepts a lossless string amount lexeme (Law 4: no float on the money path)', () => {
    // The worker feeds this mapper a response parsed with
    // parsePlaidJsonPreservingAmountLexemes, so `amount` is a decimal STRING.
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [invTxn('sx', { amount: '-12.50' })],
      securities: [],
    });
    expect(result.transactions[0]?.amountMinor).toBe('1250');
  });

  it('converts a lossless string buy amount to a negative account effect', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [
        invTxn('sy', { type: 'buy', subtype: 'buy', amount: '500.00', name: 'BUY VTI' }),
      ],
      securities: [],
    });
    expect(result.transactions[0]?.amountMinor).toBe('-50000');
  });

  it('skips a non-USD-decimal string amount as invalid rather than guessing', () => {
    const result = mapInvestmentsTransactionsToKeel({
      investment_transactions: [invTxn('sz', { amount: '12.345' })],
      securities: [],
    });
    expect(result.skipped).toEqual([{ providerTransactionId: 'sz', reason: 'invalid_amount' }]);
  });

  it('rejects a response missing the investment_transactions array', () => {
    expect(() => mapInvestmentsTransactionsToKeel({})).toThrow();
  });
});
