import type { JournalBatchId } from '@keel/contracts';
import { buildBatch, type JournalBatch, type PostingDraft } from './journal.js';
import { negateMoney } from './money.js';

export type ReversalBatch = JournalBatch & { readonly reverses: JournalBatchId };

export interface ReverseBatchOptions {
  readonly reversalBatchId: JournalBatchId;
  readonly reason: string;
}

export const reverseBatch = (
  original: JournalBatch,
  opts: ReverseBatchOptions,
): ReversalBatch => {
  const reversal = buildBatch({
    batchId: opts.reversalBatchId,
    description: `Reversal of ${original.description}: ${opts.reason}`,
    effectiveDate: original.effectiveDate,
    postings: original.postings.map(
      (posting): PostingDraft => ({
        ledgerAccountId: posting.ledgerAccountId,
        money: negateMoney(posting.money),
      }),
    ),
  });

  return Object.freeze({ ...reversal, reverses: original.batchId });
};

export interface ReviseBatchOptions extends ReverseBatchOptions {
  readonly replacementBatchId: JournalBatchId;
  readonly replacement: {
    readonly description: string;
    readonly effectiveDate: string;
    readonly postings: readonly PostingDraft[];
  };
}

export const reviseBatch = (
  original: JournalBatch,
  opts: ReviseBatchOptions,
): { reversal: ReversalBatch; replacement: JournalBatch } => ({
  reversal: reverseBatch(original, opts),
  replacement: buildBatch({
    batchId: opts.replacementBatchId,
    description: opts.replacement.description,
    effectiveDate: opts.replacement.effectiveDate,
    postings: opts.replacement.postings,
  }),
});
