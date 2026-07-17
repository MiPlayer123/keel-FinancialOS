import { describe, expect, it } from 'vitest';
import { mapHoldingsGetToKeel } from '../src/index.js';

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
