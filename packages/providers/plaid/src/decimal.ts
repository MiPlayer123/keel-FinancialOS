import { KeelError, parseMinorUnits } from '@keel/contracts';

const MAX_INT64_ABSOLUTE = 9_223_372_036_854_775_807n;
const USD_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

const invalidMoney = (lexeme: string): KeelError =>
  new KeelError('invalid_money', 'Plaid amount is not an exact USD decimal', { lexeme });

/** Convert an exact USD decimal source lexeme to signed minor units without floats. */
export function decimalToMinor(lexeme: string, currency: 'USD'): bigint;
export function decimalToMinor(lexeme: string, currency: string): bigint {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const match = USD_DECIMAL_PATTERN.exec(unsigned);

  if (currency !== 'USD' || match === null || match[1] === undefined) {
    throw invalidMoney(lexeme);
  }

  const whole = match[1];
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const absoluteMinor = BigInt(`${whole}${fraction}`);

  if ((negative && absoluteMinor === 0n) || absoluteMinor > MAX_INT64_ABSOLUTE) {
    throw invalidMoney(lexeme);
  }

  const signedMinor = negative ? -absoluteMinor : absoluteMinor;
  return parseMinorUnits(signedMinor.toString());
}
