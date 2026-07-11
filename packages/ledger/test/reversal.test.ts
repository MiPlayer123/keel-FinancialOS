import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  CurrencyCode,
  JournalBatchId,
  LedgerAccountId,
} from '@keel/contracts';
import { KeelError } from '@keel/contracts';
import { buildBatch, type JournalPosting, type PostingDraft } from '../src/journal.js';
import { money } from '../src/money.js';
import { reverseBatch, reviseBatch } from '../src/reversal.js';

const USD: CurrencyCode = 'USD';
const originalId = 'original-batch' as JournalBatchId;
const reversalId = 'reversal-batch' as JournalBatchId;
const replacementId = 'replacement-batch' as JournalBatchId;
const accountId = (value: string): LedgerAccountId => value as LedgerAccountId;

const original = buildBatch({
  batchId: originalId,
  description: 'Original purchase',
  effectiveDate: '2026-07-10',
  postings: [
    { ledgerAccountId: accountId('expense'), money: money(42n, USD) },
    { ledgerAccountId: accountId('card'), money: money(-42n, USD) },
  ],
});

describe('reverseBatch', () => {
  it('creates a frozen compensating batch that references the original', () => {
    const before = original.postings.map((posting) => ({
      ledgerAccountId: posting.ledgerAccountId,
      money: { ...posting.money },
    }));
    const reversal = reverseBatch(original, {
      reversalBatchId: reversalId,
      reason: 'Wrong category',
    });

    expect(reversal.batchId).toBe(reversalId);
    expect(reversal.effectiveDate).toBe(original.effectiveDate);
    expect(reversal.description).toContain(original.description);
    expect(reversal.description).toContain('Wrong category');
    expect(reversal.reverses).toBe(original.batchId);
    expect(reversal.postings).toEqual([
      { ledgerAccountId: accountId('expense'), money: money(-42n, USD) },
      { ledgerAccountId: accountId('card'), money: money(42n, USD) },
    ]);
    expect(Object.isFrozen(reversal)).toBe(true);
    expect(original.postings).toEqual(before);
  });

  it('cancels arbitrary original postings per account and currency', () => {
    const nonzero = fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((value) => value !== 0n);

    fc.assert(
      fc.property(fc.array(nonzero, { minLength: 1, maxLength: 20 }), (amounts) => {
        const postings: PostingDraft[] = amounts.flatMap((amount, index) => [
          {
            ledgerAccountId: accountId(`left-${index.toString()}`),
            money: money(amount, USD),
          },
          {
            ledgerAccountId: accountId(`right-${index.toString()}`),
            money: money(-amount, USD),
          },
        ]);
        const batch = buildBatch({
          batchId: originalId,
          description: 'Property batch',
          effectiveDate: '2026-07-10',
          postings,
        });
        const reversal = reverseBatch(batch, {
          reversalBatchId: reversalId,
          reason: 'Property reversal',
        });
        const sums = new Map<string, bigint>();

        const accumulate = (posting: JournalPosting): void => {
          const key = `${posting.ledgerAccountId}|${posting.money.currency}`;
          sums.set(key, (sums.get(key) ?? 0n) + posting.money.amountMinor);
        };
        batch.postings.forEach(accumulate);
        reversal.postings.forEach(accumulate);

        expect([...sums.values()].every((sum) => sum === 0n)).toBe(true);
      }),
    );
  });
});

describe('reviseBatch', () => {
  it('returns a reversal and a balanced replacement', () => {
    const result = reviseBatch(original, {
      reversalBatchId: reversalId,
      replacementBatchId: replacementId,
      reason: 'Correct amount',
      replacement: {
        description: 'Corrected purchase',
        effectiveDate: '2026-07-11',
        postings: [
          { ledgerAccountId: accountId('expense'), money: money(40n, USD) },
          { ledgerAccountId: accountId('card'), money: money(-40n, USD) },
        ],
      },
    });

    expect(result.reversal.reverses).toBe(originalId);
    expect(result.reversal.batchId).toBe(reversalId);
    expect(result.replacement).toEqual(
      buildBatch({
        batchId: replacementId,
        description: 'Corrected purchase',
        effectiveDate: '2026-07-11',
        postings: [
          { ledgerAccountId: accountId('expense'), money: money(40n, USD) },
          { ledgerAccountId: accountId('card'), money: money(-40n, USD) },
        ],
      }),
    );
  });

  it('rejects an unbalanced replacement', () => {
    expect(() =>
      reviseBatch(original, {
        reversalBatchId: reversalId,
        replacementBatchId: replacementId,
        reason: 'Bad correction',
        replacement: {
          description: 'Unbalanced',
          effectiveDate: '2026-07-11',
          postings: [
            { ledgerAccountId: accountId('expense'), money: money(40n, USD) },
            { ledgerAccountId: accountId('card'), money: money(-39n, USD) },
          ],
        },
      }),
    ).toThrow(expect.objectContaining<Partial<KeelError>>({ code: 'unbalanced_batch' }));
  });
});
