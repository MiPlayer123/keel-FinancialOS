import { describe, expect, it } from 'vitest';
import {
  LEDGER_VERSION,
  addMoney,
  allocateMoney,
  assertPostable,
  buildBatch,
  isZero,
  money,
  moneyEquals,
  negateMoney,
  reverseBatch,
  reviseBatch,
  splitByAmounts,
  splitByBasisPoints,
  subtractMoney,
  sumMoney,
} from '@keel/ledger';

describe('@keel/ledger public entrypoint', () => {
  it('exports its version and complete runtime API', () => {
    expect(LEDGER_VERSION).toBe('0.1.0');
    const runtimeFunctions = [
      money,
      addMoney,
      subtractMoney,
      negateMoney,
      moneyEquals,
      isZero,
      sumMoney,
      allocateMoney,
      buildBatch,
      splitByAmounts,
      splitByBasisPoints,
      reverseBatch,
      reviseBatch,
      assertPostable,
    ];
    for (const runtimeFunction of runtimeFunctions) {
      expect(runtimeFunction).toBeTypeOf('function');
    }
  });
});
