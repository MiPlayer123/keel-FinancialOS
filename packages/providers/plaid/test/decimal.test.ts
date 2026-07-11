import { KeelError } from '@keel/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decimalToMinor } from '../src/decimal.js';

const expectInvalidMoney = (lexeme: string): void => {
  try {
    decimalToMinor(lexeme, 'USD');
    throw new Error(`expected ${JSON.stringify(lexeme)} to fail`);
  } catch (error) {
    expect(error).toBeInstanceOf(KeelError);
    expect((error as KeelError).code).toBe('invalid_money');
  }
};

const normalizedDecimal = (lexeme: string): string => {
  const negative = lexeme.startsWith('-');
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ''] = unsigned.split('.');
  const normalized = `${whole}.${fraction.padEnd(2, '0')}`;
  return negative ? `-${normalized}` : normalized;
};

const formatMinor = (minor: bigint): string => {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const digits = absolute.toString().padStart(3, '0');
  const formatted = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return negative ? `-${formatted}` : formatted;
};

describe('decimalToMinor', () => {
  it.each([
    ['12.3', 1230n],
    ['12.34', 1234n],
    ['12', 1200n],
    ['-7.5', -750n],
    ['0.09', 9n],
  ])('converts %s exactly to minor units', (lexeme, expected) => {
    expect(decimalToMinor(lexeme, 'USD')).toBe(expected);
  });

  it.each([
    '',
    '+',
    '+1',
    '01',
    '01.23',
    '-0',
    '-0.0',
    '-0.00',
    '.12',
    '1.',
    '1.234',
    'abc',
    ' 1.00',
    '1e2',
    '92233720368547758.08',
    '-92233720368547758.08',
  ])('rejects invalid or overflowing lexeme %j', expectInvalidMoney);

  it('accepts the symmetric int64 absolute bound', () => {
    expect(decimalToMinor('92233720368547758.07', 'USD')).toBe(9223372036854775807n);
    expect(decimalToMinor('-92233720368547758.07', 'USD')).toBe(-9223372036854775807n);
  });

  it('round-trips random valid decimals after scale normalization', () => {
    const decimalArbitrary = fc
      .record({
        negative: fc.boolean(),
        whole: fc.bigInt({ min: 0n, max: 90_000_000_000_000n }),
        fractionLength: fc.integer({ min: 0, max: 2 }),
        fraction: fc.integer({ min: 0, max: 99 }),
      })
      .map(({ negative, whole, fractionLength, fraction }) => {
        const fractionText = fraction.toString().padStart(2, '0').slice(0, fractionLength);
        const sign = negative && (whole !== 0n || /[1-9]/.test(fractionText)) ? '-' : '';
        if (fractionLength === 0) return `${sign}${whole.toString()}`;
        return `${sign}${whole.toString()}.${fractionText}`;
      });

    fc.assert(
      fc.property(decimalArbitrary, (lexeme) => {
        expect(formatMinor(decimalToMinor(lexeme, 'USD'))).toBe(normalizedDecimal(lexeme));
      }),
    );
  });

  it('rejects every generated decimal with more than two fractional digits', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.integer({ min: 0, max: 999_999 }),
        (whole, fraction) => {
          const fractionText = fraction.toString().padStart(3, '0');
          expectInvalidMoney(`${whole.toString()}.${fractionText}`);
        },
      ),
    );
  });
});
