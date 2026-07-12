import type { ExportRow, HouseholdExport } from './types.js';

/** Current economic batches: the latest unreversed batch for each non-void transaction. */
export const currentLiveJournalBatches = (snapshot: HouseholdExport): readonly ExportRow[] => {
  const liveTransactionIds = new Set(snapshot.tables.canonical_transactions
    .filter((transaction) => transaction['status'] !== 'voided')
    .map((transaction) => transaction['id']));
  const supersededBatchIds = new Set(snapshot.tables.journal_revisions
    .map((revision) => revision['original_batch_id']));

  return snapshot.tables.journal_batches.filter((batch) =>
    typeof batch['canonical_transaction_id'] === 'string' &&
    liveTransactionIds.has(batch['canonical_transaction_id']) &&
    batch['reverses_batch_id'] === null &&
    !supersededBatchIds.has(batch['id']));
};
