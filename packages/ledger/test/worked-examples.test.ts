import { describe, expect, it } from 'vitest';
import type { JournalBatchId, LedgerAccountId } from '@keel/contracts';
import { buildBatch, money } from '@keel/ledger';

const accountId = (value: string): LedgerAccountId => value as LedgerAccountId;
const batchId = (value: string): JournalBatchId => value as JournalBatchId;

const expectBalanced = (amounts: readonly bigint[]): void => {
  expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(0n);
};

describe('doc 10 §2.4 worked examples', () => {
  it('$87.42 groceries on Chase splits $60.00 food and $27.42 household', () => {
    const batch = buildBatch({
      batchId: batchId('groceries-example'),
      description: 'Groceries split',
      effectiveDate: '2026-07-11',
      postings: [
        { ledgerAccountId: accountId('Groceries'), money: money(6_000n, 'USD') },
        { ledgerAccountId: accountId('Household'), money: money(2_742n, 'USD') },
        { ledgerAccountId: accountId('ChaseCard'), money: money(-8_742n, 'USD') },
      ],
    });

    expect(batch.postings).toHaveLength(3);
    expectBalanced(batch.postings.map((posting) => posting.money.amountMinor));
  });

  it('$500 card payment moves value from checking to the Chase card', () => {
    const batch = buildBatch({
      batchId: batchId('card-payment-example'),
      description: 'Card payment',
      effectiveDate: '2026-07-11',
      postings: [
        { ledgerAccountId: accountId('Checking'), money: money(-50_000n, 'USD') },
        { ledgerAccountId: accountId('ChaseCard'), money: money(50_000n, 'USD') },
      ],
    });

    expect(batch.postings).toHaveLength(2);
    expectBalanced(batch.postings.map((posting) => posting.money.amountMinor));
  });
});
