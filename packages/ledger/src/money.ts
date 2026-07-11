import type { CurrencyCode, Money } from '@keel/contracts';
import { KeelError, minorUnits } from '@keel/contracts';

const assertSameCurrency = (a: Money, b: Money): void => {
  if ((a.currency as string) !== (b.currency as string)) {
    throw new KeelError('currency_mismatch', 'money currencies must match', {
      leftCurrency: a.currency,
      rightCurrency: b.currency,
    });
  }
};

export const money = (amountMinor: bigint, currency: CurrencyCode): Money => {
  if (typeof amountMinor !== 'bigint') {
    throw new KeelError('invalid_money', 'amountMinor must be a bigint');
  }

  return { amountMinor: minorUnits(amountMinor), currency };
};

export const addMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
};

export const subtractMoney = (a: Money, b: Money): Money => {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
};

export const negateMoney = (value: Money): Money =>
  money(-(value.amountMinor as bigint), value.currency);

export const moneyEquals = (a: Money, b: Money): boolean => {
  assertSameCurrency(a, b);
  return a.amountMinor === b.amountMinor;
};

export const isZero = (value: Money): boolean => value.amountMinor === 0n;

export const sumMoney = (list: readonly Money[], currency: CurrencyCode): Money => {
  let total = 0n;

  for (const item of list) {
    if ((item.currency as string) !== (currency as string)) {
      throw new KeelError('currency_mismatch', 'money currency does not match requested sum', {
        expectedCurrency: currency,
        actualCurrency: item.currency,
      });
    }
    total += item.amountMinor;
  }

  return money(total, currency);
};

interface AllocationShare {
  readonly index: number;
  readonly base: bigint;
  readonly remainder: bigint;
}

export const allocateMoney = (total: Money, weights: readonly bigint[]): Money[] => {
  if (weights.length === 0 || weights.some((weight) => weight < 0n)) {
    throw new KeelError('invalid_money', 'weights must be non-negative with at least one positive');
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    throw new KeelError('invalid_money', 'weights must be non-negative with at least one positive');
  }

  const negative = total.amountMinor < 0n;
  const magnitude = negative ? -(total.amountMinor as bigint) : total.amountMinor;
  const shares: AllocationShare[] = weights.map((weight, index) => {
    const numerator = magnitude * weight;
    return {
      index,
      base: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });

  let unitsToDistribute = magnitude - shares.reduce((sum, share) => sum + share.base, 0n);
  const ranked = [...shares].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  const allocated = shares.map((share) => share.base);

  for (const share of ranked) {
    if (unitsToDistribute === 0n) break;
    const current = allocated[share.index] as bigint;
    allocated[share.index] = current + 1n;
    unitsToDistribute -= 1n;
  }

  return allocated.map((amount) => money(negative ? -amount : amount, total.currency));
};
