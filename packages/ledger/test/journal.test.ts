import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  CurrencyCode,
  JournalBatchId,
  KeelErrorCode,
  LedgerAccountId,
} from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import { buildBatch, type PostingDraft } from '../src/journal.js';
import { money } from '../src/money.js';

const USD: CurrencyCode = 'USD';
const EUR = 'EUR' as CurrencyCode;
const batchId = 'batch-1' as JournalBatchId;
const accountId = (value: string): LedgerAccountId => value as LedgerAccountId;

const draft = (
  ledgerAccountId: string,
  amountMinor: bigint,
  currency: CurrencyCode = USD,
): PostingDraft => ({ ledgerAccountId: accountId(ledgerAccountId), money: money(amountMinor, currency) });

const build = (postings: readonly PostingDraft[]) =>
  buildBatch({
    batchId,
    description: 'Test batch',
    effectiveDate: '2026-07-11',
    postings,
  });

const expectCode = (operation: () => unknown, code: KeelErrorCode): KeelError => {
  try {
    operation();
    throw new Error('expected operation to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(KeelError);
    expect((error as KeelError).code).toBe(code);
    return error as KeelError;
  }
};

describe('buildBatch', () => {
  it('builds and deeply freezes a balanced batch without freezing caller input', () => {
    const inputMoney = money(100n, USD);
    const postings: PostingDraft[] = [
      { ledgerAccountId: accountId('cash'), money: inputMoney },
      draft('income', -100n),
    ];

    const batch = build(postings);

    expect(batch).toEqual({
      batchId,
      description: 'Test batch',
      effectiveDate: '2026-07-11',
      postings,
    });
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.postings)).toBe(true);
    expect(Object.isFrozen(batch.postings[0])).toBe(true);
    expect(Object.isFrozen(batch.postings[0]?.money)).toBe(true);
    expect(Object.isFrozen(inputMoney)).toBe(false);
  });

  it('rejects fewer than two postings', () => {
    expectCode(() => build([draft('cash', 1n)]), 'invalid_money');
  });

  it('rejects a zero posting', () => {
    expectCode(() => build([draft('cash', 0n), draft('income', 1n)]), 'invalid_money');
  });

  it('reports the currency and delta for an unbalanced currency', () => {
    const error = expectCode(
      () => build([draft('cash', 10n), draft('income', -9n)]),
      'unbalanced_batch',
    );
    expect(error.details).toEqual({ currency: USD, delta: 1n });
  });

  it('requires each currency to balance independently', () => {
    const error = expectCode(
      () => build([draft('usd', 1n), draft('eur', -1n, EUR)]),
      'unbalanced_batch',
    );
    expect(error.details).toEqual({ currency: USD, delta: 1n });
  });

  it('accepts arbitrary nonzero postings balanced per currency', () => {
    const nonzero = fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((value) => value !== 0n);
    const balancedPair = fc.tuple(nonzero, fc.constantFrom(USD, EUR));

    fc.assert(
      fc.property(fc.array(balancedPair, { minLength: 1, maxLength: 20 }), (pairs) => {
        const postings = pairs.flatMap(([amount, currency], index) => [
          draft(`left-${index.toString()}`, amount, currency),
          draft(`right-${index.toString()}`, -amount, currency),
        ]);
        const batch = build(postings);
        const sums = new Map<CurrencyCode, bigint>();

        for (const posting of batch.postings) {
          sums.set(
            posting.money.currency,
            (sums.get(posting.money.currency) ?? 0n) + posting.money.amountMinor,
          );
        }
        expect([...sums.values()].every((sum) => sum === 0n)).toBe(true);
      }),
    );
  });

  it('rejects arbitrary arrays whose sum is nonzero', () => {
    const nonzeroSum = fc
      .array(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((value) => value !== 0n), {
        minLength: 2,
        maxLength: 20,
      })
      .filter((values) => values.reduce((sum, value) => sum + value, 0n) !== 0n);

    fc.assert(
      fc.property(nonzeroSum, (values) => {
        expectCode(
          () =>
            build(
              values.map((value, index) => draft(`account-${index.toString()}`, value)),
            ),
          'unbalanced_batch',
        );
      }),
    );
  });
});
