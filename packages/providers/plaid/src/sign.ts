import { KeelError } from '@keel/contracts';
import { decimalToMinor } from './decimal.js';

/**
 * Plaid amounts are positive when money leaves an account and negative when
 * money enters it. KEEL stores holder-perspective signed minor units, where an
 * asset outflow is negative, so this boundary negates Plaid's exact amount.
 */
export const plaidAmountToKeelMinor = (
  plaidAmountLexeme: string,
  currency: string,
): bigint => {
  if (currency !== 'USD') {
    throw new KeelError('currency_mismatch', 'Plaid transaction currency must be USD', {
      actualCurrency: currency,
      expectedCurrency: 'USD',
    });
  }

  return -decimalToMinor(plaidAmountLexeme, 'USD');
};
