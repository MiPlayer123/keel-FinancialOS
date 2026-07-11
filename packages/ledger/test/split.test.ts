import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { CurrencyCode, KeelErrorCode } from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import { allocateMoney, money } from '../src/money.js';
import { splitByAmounts, splitByBasisPoints } from '../src/split.js';

const USD: CurrencyCode = 'USD';

const expectCode = (operation: () => unknown, code: KeelErrorCode): void => {
  try {
    operation();
    throw new Error('expected operation to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(KeelError);
    expect((error as KeelError).code).toBe(code);
  }
};

describe('splitByAmounts', () => {
  it('creates same-currency parts whose amounts exactly match', () => {
    expect(splitByAmounts(money(10n, USD), [3n, 0n, 7n])).toEqual([
      money(3n, USD),
      money(0n, USD),
      money(7n, USD),
    ]);
  });

  it('allows an empty split for a zero parent', () => {
    expect(splitByAmounts(money(0n, USD), [])).toEqual([]);
  });

  it('rejects amounts that do not equal the parent', () => {
    expectCode(() => splitByAmounts(money(10n, USD), [3n, 6n]), 'unbalanced_batch');
  });

  it('conserves arbitrary parent amounts', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt(), { maxLength: 20 }), (amounts) => {
        const total = amounts.reduce((sum, amount) => sum + amount, 0n);
        const parts = splitByAmounts(money(total, USD), amounts);
        expect(parts.reduce((sum, part) => sum + part.amountMinor, 0n)).toBe(total);
        expect(parts.map((part) => part.currency)).toEqual(amounts.map(() => USD));
      }),
    );
  });
});

describe('splitByBasisPoints', () => {
  it('allocates all minor units without losing a remainder', () => {
    expect(splitByBasisPoints(money(2n, USD), [3_333n, 3_333n, 3_334n])).toEqual([
      money(1n, USD),
      money(0n, USD),
      money(1n, USD),
    ]);
  });

  it('conserves a negative parent', () => {
    expect(splitByBasisPoints(money(-5n, USD), [5_000n, 5_000n])).toEqual([
      money(-3n, USD),
      money(-2n, USD),
    ]);
  });

  it.each([
    ['empty', []],
    ['short', [9_999n]],
    ['long', [10_001n]],
  ] as const)('rejects a %s basis-point total', (_label, bps) => {
    expectCode(() => splitByBasisPoints(money(10n, USD), bps), 'invalid_money');
  });

  it('rejects negative basis points even when they sum to 10000', () => {
    expectCode(
      () => splitByBasisPoints(money(10n, USD), [-1n, 10_001n]),
      'invalid_money',
    );
  });

  it('conserves arbitrary parents for arbitrary valid basis-point vectors', () => {
    const positiveWeights = fc.array(fc.bigInt({ min: 1n, max: 10_000n }), {
      minLength: 1,
      maxLength: 20,
    });

    fc.assert(
      fc.property(fc.bigInt(), positiveWeights, (parent, weights) => {
        const bps = allocateMoney(money(10_000n, USD), weights).map(
          (part) => part.amountMinor,
        );
        const parts = splitByBasisPoints(money(parent, USD), bps);
        expect(parts.reduce((sum, part) => sum + part.amountMinor, 0n)).toBe(parent);
      }),
    );
  });
});
