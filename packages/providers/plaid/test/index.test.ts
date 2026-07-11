import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PLAID_ADAPTER_VERSION,
  PlaidBankProvider,
  decimalToMinor,
  extractAmountLexemes,
  plaidAmountToKeelMinor,
} from '../src/index.js';

describe('@keel/plaid public surface', () => {
  it('exports the adapter version and core pure APIs', () => {
    expect(PLAID_ADAPTER_VERSION).toBe('0.1.0');
    expect(PlaidBankProvider).toBeTypeOf('function');
    expect(decimalToMinor).toBeTypeOf('function');
    expect(extractAmountLexemes).toBeTypeOf('function');
    expect(plaidAmountToKeelMinor).toBeTypeOf('function');
    expectTypeOf(decimalToMinor).toEqualTypeOf<
      (lexeme: string, currency: 'USD') => bigint
    >();
  });
});
