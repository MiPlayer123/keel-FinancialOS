import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { CurrencyCode, Money } from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import {
  addMoney,
  allocateMoney,
  isZero,
  money,
  moneyEquals,
  negateMoney,
  subtractMoney,
  sumMoney,
} from '../src/money.js';

const USD: CurrencyCode = 'USD';
const EUR = 'EUR' as CurrencyCode;

const expectKeelError = (operation: () => unknown, code: KeelError['code']): void => {
  try {
    operation();
    throw new Error('expected operation to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(KeelError);
    expect((error as KeelError).code).toBe(code);
  }
};

describe('money', () => {
  it('constructs bigint money', () => {
    expect(money(42n, USD)).toEqual({ amountMinor: 42n, currency: USD });
  });

  it.each([42, '42', null, undefined, {}, true])(
    'rejects a non-bigint amount: %j',
    (amount) => {
      expectKeelError(() => money(amount as bigint, USD), 'invalid_money');
    },
  );

  it('adds, subtracts, and negates money', () => {
    expect(addMoney(money(7n, USD), money(5n, USD))).toEqual(money(12n, USD));
    expect(subtractMoney(money(7n, USD), money(5n, USD))).toEqual(money(2n, USD));
    expect(negateMoney(money(7n, USD))).toEqual(money(-7n, USD));
  });

  it('compares equal money and detects zero', () => {
    expect(moneyEquals(money(7n, USD), money(7n, USD))).toBe(true);
    expect(moneyEquals(money(7n, USD), money(8n, USD))).toBe(false);
    expect(isZero(money(0n, USD))).toBe(true);
    expect(isZero(money(1n, USD))).toBe(false);
  });

  it.each([
    ['addMoney', (a: Money, b: Money) => addMoney(a, b)],
    ['subtractMoney', (a: Money, b: Money) => subtractMoney(a, b)],
    ['moneyEquals', (a: Money, b: Money) => moneyEquals(a, b)],
  ] as const)('%s rejects mixed currencies', (_name, operation) => {
    expectKeelError(() => operation(money(1n, USD), money(1n, EUR)), 'currency_mismatch');
  });

  it('sums an empty list in the requested currency', () => {
    expect(sumMoney([], USD)).toEqual(money(0n, USD));
  });

  it('rejects a mismatched currency while summing', () => {
    expectKeelError(
      () => sumMoney([money(1n, USD), money(2n, EUR)], USD),
      'currency_mismatch',
    );
  });

  it('sums arbitrary bigint lists exactly', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt(), { maxLength: 100 }), (values) => {
        const result = sumMoney(
          values.map((value) => money(value, USD)),
          USD,
        );
        expect(result.amountMinor).toBe(values.reduce((sum, value) => sum + value, 0n));
      }),
    );
  });
});

describe('allocateMoney', () => {
  it('uses stable largest-remainder ordering for ties', () => {
    expect(allocateMoney(money(2n, USD), [1n, 1n, 1n])).toEqual([
      money(1n, USD),
      money(1n, USD),
      money(0n, USD),
    ]);
  });

  it('allocates negative totals by magnitude and negates the parts', () => {
    expect(allocateMoney(money(-5n, USD), [1n, 1n])).toEqual([
      money(-3n, USD),
      money(-2n, USD),
    ]);
  });

  it('allows zero weights when at least one weight is positive', () => {
    expect(allocateMoney(money(5n, USD), [0n, 2n, 0n])).toEqual([
      money(0n, USD),
      money(5n, USD),
      money(0n, USD),
    ]);
  });

  it.each([
    ['empty', []],
    ['all zero', [0n, 0n]],
    ['negative', [1n, -1n]],
  ] as const)('rejects %s weights', (_label, weights) => {
    expectKeelError(() => allocateMoney(money(10n, USD), weights), 'invalid_money');
  });

  it('conserves arbitrary totals with proportional error below one minor unit', () => {
    const weightsArbitrary = fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), {
      minLength: 1,
      maxLength: 20,
    });

    fc.assert(
      fc.property(fc.bigInt(), weightsArbitrary, (total, weights) => {
        const parts = allocateMoney(money(total, USD), weights);
        const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
        const magnitude = total < 0n ? -total : total;

        expect(parts).toHaveLength(weights.length);
        expect(parts.reduce((sum, part) => sum + part.amountMinor, 0n)).toBe(total);

        parts.forEach((part, index) => {
          const partMagnitude =
            part.amountMinor < 0n ? -(part.amountMinor as bigint) : part.amountMinor;
          const weight = weights[index];
          expect(weight).toBeDefined();
          const scaledError =
            partMagnitude * denominator - magnitude * (weight as bigint);
          const absoluteScaledError = scaledError < 0n ? -scaledError : scaledError;
          expect(absoluteScaledError).toBeLessThan(denominator);
        });
      }),
    );
  });
});
