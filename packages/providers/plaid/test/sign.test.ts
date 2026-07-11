import { KeelError } from '@keel/contracts';
import { describe, expect, it } from 'vitest';
import { plaidAmountToKeelMinor } from '../src/sign.js';

describe('plaidAmountToKeelMinor', () => {
  it('maps a Plaid $12.34 outflow to negative holder-perspective minor units', () => {
    expect(plaidAmountToKeelMinor('12.34', 'USD')).toBe(-1234n);
  });

  it('maps a Plaid $500 inflow to positive holder-perspective minor units', () => {
    expect(plaidAmountToKeelMinor('-500.00', 'USD')).toBe(50000n);
  });

  it('rejects non-USD currency with a typed currency_mismatch error', () => {
    try {
      plaidAmountToKeelMinor('1.00', 'EUR');
      throw new Error('expected currency mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(KeelError);
      expect((error as KeelError).code).toBe('currency_mismatch');
    }
  });
});
