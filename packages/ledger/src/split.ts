import type { Money } from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import { allocateMoney, money } from './money.js';

export const splitByAmounts = (parentMoney: Money, amounts: readonly bigint[]): Money[] => {
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (total !== parentMoney.amountMinor) {
    throw new KeelError('unbalanced_batch', 'split amounts must equal the parent amount', {
      currency: parentMoney.currency,
      delta: total - parentMoney.amountMinor,
    });
  }

  return amounts.map((amount) => money(amount, parentMoney.currency));
};

export const splitByBasisPoints = (parentMoney: Money, bps: readonly bigint[]): Money[] => {
  const totalBasisPoints = bps.reduce((sum, basisPoints) => sum + basisPoints, 0n);
  if (totalBasisPoints !== 10_000n) {
    throw new KeelError('invalid_money', 'basis points must sum to 10000');
  }

  return allocateMoney(parentMoney, bps);
};
