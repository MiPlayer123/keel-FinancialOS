import { describe, expect, it } from 'vitest';

import { presentAccountHoldings } from './holdings-presentation';

const base = {
  isManual: false,
  subtype: 'brokerage',
  currency: 'USD',
  currentMinor: '5735967',
  holdingsProviderCount: null,
  holdingsCashEquivalentCount: null,
  positionsValueMinor: null,
};

describe('presentAccountHoldings', () => {
  it('connected brokerage with no positions and no cash evidence is awaiting the provider', () => {
    // The founder's LLC brokerage right after linking: Fidelity publishes
    // Investments asynchronously, so zero rows must read as "not reported
    // yet", never as an empty portfolio.
    expect(presentAccountHoldings(base)).toEqual({ kind: 'awaiting_provider' });
  });

  it('stats of zero reported holdings still means awaiting the provider', () => {
    expect(
      presentAccountHoldings({
        ...base,
        holdingsProviderCount: 0,
        holdingsCashEquivalentCount: 0,
      }),
    ).toEqual({ kind: 'awaiting_provider' });
  });

  it('cash-management subtype with no positions presents the balance as cash', () => {
    expect(
      presentAccountHoldings({
        ...base,
        subtype: 'cash management',
        currentMinor: '4824',
      }),
    ).toEqual({ kind: 'cash_only', cashMinor: '4824' });
  });

  it('a brokerage whose only reported holdings were cash-equivalent (all SPAXX) is cash-only', () => {
    expect(
      presentAccountHoldings({
        ...base,
        holdingsProviderCount: 1,
        holdingsCashEquivalentCount: 1,
      }),
    ).toEqual({ kind: 'cash_only', cashMinor: '5735967' });
  });

  it('listed positions without cash evidence carry no derived cash line', () => {
    expect(
      presentAccountHoldings({ ...base, positionsValueMinor: '5000000' }),
    ).toEqual({ kind: 'positions', derivedCashMinor: null });
  });

  it('listed positions plus cash-equivalent skips derive cash = balance − positions', () => {
    expect(
      presentAccountHoldings({
        ...base,
        holdingsProviderCount: 3,
        holdingsCashEquivalentCount: 1,
        positionsValueMinor: '5000000',
      }),
    ).toEqual({ kind: 'positions', derivedCashMinor: '735967' });
  });

  it('never shows a negative derived cash remainder (stale balance lag)', () => {
    expect(
      presentAccountHoldings({
        ...base,
        holdingsProviderCount: 2,
        holdingsCashEquivalentCount: 1,
        currentMinor: '4000000',
        positionsValueMinor: '5000000',
      }),
    ).toEqual({ kind: 'positions', derivedCashMinor: null });
  });

  it('manual account with nothing tracked yet is manual_empty, not awaiting a provider', () => {
    expect(
      presentAccountHoldings({ ...base, isManual: true, subtype: 'retirement' }),
    ).toEqual({ kind: 'manual_empty' });
  });

  it('zero-balance cash-only account still reports $0 cash honestly', () => {
    expect(
      presentAccountHoldings({ ...base, subtype: 'cash management', currentMinor: '0' }),
    ).toEqual({ kind: 'cash_only', cashMinor: '0' });
  });
});
