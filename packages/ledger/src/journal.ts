import type {
  CurrencyCode,
  JournalBatchId,
  LedgerAccountId,
  Money,
} from '@keel/contracts';
import { KeelError } from '@keel/contracts';

export interface PostingDraft {
  ledgerAccountId: LedgerAccountId;
  money: Money;
}

export interface JournalPosting {
  readonly ledgerAccountId: LedgerAccountId;
  readonly money: Money;
}

export interface JournalBatch {
  readonly batchId: JournalBatchId;
  readonly description: string;
  readonly effectiveDate: string;
  readonly postings: readonly JournalPosting[];
}

export interface BuildBatchInput {
  readonly batchId: JournalBatchId;
  readonly description: string;
  readonly effectiveDate: string;
  readonly postings: readonly PostingDraft[];
}

export const buildBatch = (input: BuildBatchInput): JournalBatch => {
  if (input.postings.length < 2) {
    throw new KeelError('invalid_money', 'a journal batch requires at least two postings');
  }

  const balances = new Map<CurrencyCode, bigint>();
  for (const posting of input.postings) {
    if (posting.money.amountMinor === 0n) {
      throw new KeelError('invalid_money', 'journal postings must not be zero');
    }
    balances.set(
      posting.money.currency,
      (balances.get(posting.money.currency) ?? 0n) + posting.money.amountMinor,
    );
  }

  for (const [currency, delta] of balances) {
    if (delta !== 0n) {
      throw new KeelError('unbalanced_batch', 'journal batch must balance per currency', {
        currency,
        delta,
      });
    }
  }

  const postings = input.postings.map((posting): JournalPosting =>
    Object.freeze({
      ledgerAccountId: posting.ledgerAccountId,
      money: Object.freeze({ ...posting.money }),
    }),
  );

  return Object.freeze({
    batchId: input.batchId,
    description: input.description,
    effectiveDate: input.effectiveDate,
    postings: Object.freeze(postings),
  });
};
