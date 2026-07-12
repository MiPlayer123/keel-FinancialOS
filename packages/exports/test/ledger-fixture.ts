import type { ExportTables, HouseholdExport } from '../src/index.js';
import { emptyTables, snapshot } from './fixtures.js';

export const ledgerSnapshot = (
  amountMinor = '9000000000000000000',
  currency = 'USD',
): HouseholdExport => {
  const tables = {
    ...emptyTables(),
    households: [{ id: 'hh', name: 'Example', created_at: '2026-01-01T00:00:00Z' }],
    entities: [{ id: 'entity', household_id: 'hh', name: 'Personal', kind: 'personal', created_at: '2026-01-01T00:00:00Z', archived_at: null }],
    ledger_accounts: [
      { id: 'asset', household_id: 'hh', entity_id: 'entity', name: 'Cash "Main"', kind: 'asset', currency, is_category: false, created_at: '2026-01-01T00:00:00Z', archived_at: null },
      { id: 'income', household_id: 'hh', entity_id: 'entity', name: 'Salary & Bonus', kind: 'income', currency, is_category: true, created_at: '2026-01-01T00:00:00Z', archived_at: null },
    ],
    accounts: [{ id: 'account', household_id: 'hh', entity_id: 'entity', connection_id: null, ledger_account_id: 'asset', name: 'Cash Account', subtype: 'checking', currency, external_ref: null, created_at: '2026-01-01T00:00:00Z', archived_at: null }],
    canonical_transactions: [{ id: 'txn', household_id: 'hh', entity_id: 'entity', account_id: 'account', status: 'posted', source: 'manual', description: '=cmd() "pay"\nline', effective_date: '2026-07-12', economic_event_key: 'manual:export:1', created_at: '2026-07-12T00:00:00Z', voided_at: null }],
    journal_batches: [{ id: 'batch', household_id: 'hh', canonical_transaction_id: 'txn', description: 'Payroll "quoted"\nline', effective_date: '2026-07-12', reverses_batch_id: null, command_id: 'command', posted_at: '2026-07-12T00:00:00Z' }],
    journal_postings: [
      { id: 'posting-asset', batch_id: 'batch', ledger_account_id: 'asset', entity_id: 'entity', amount_minor: amountMinor, currency },
      { id: 'posting-income', batch_id: 'batch', ledger_account_id: 'income', entity_id: 'entity', amount_minor: `-${amountMinor}`, currency },
    ],
  } as ExportTables;

  return snapshot({
    householdId: 'hh',
    tables,
    trialBalance: [
      { ledgerAccountId: 'asset', currency, balanceMinor: amountMinor },
      { ledgerAccountId: 'income', currency, balanceMinor: `-${amountMinor}` },
    ],
  });
};

/** Historical revision + void whose live economic state is replacement only. */
export const revisedAndVoidedLedgerSnapshot = (): HouseholdExport => {
  const base = ledgerSnapshot('100');
  const revisionTransaction = base.tables.canonical_transactions[0];
  const baseBatch = base.tables.journal_batches[0];
  const assetPosting = base.tables.journal_postings[0];
  const incomePosting = base.tables.journal_postings[1];
  if (!revisionTransaction || !baseBatch || !assetPosting || !incomePosting) {
    throw new Error('Base ledger fixture is incomplete.');
  }
  const originalBatch = {
    ...baseBatch,
    description: 'Superseded original',
  };
  const reversalBatch = {
    ...originalBatch,
    id: 'revision-reversal',
    description: 'REVERSAL: superseded original',
    reverses_batch_id: 'batch',
  };
  const replacementBatch = {
    ...originalBatch,
    id: 'revision-replacement',
    description: 'Current replacement',
  };
  const voidTransaction = {
    ...revisionTransaction,
    id: 'void-txn',
    status: 'voided',
    description: 'Voided transaction',
    economic_event_key: 'manual:export:void',
    voided_at: '2026-07-12T01:00:00Z',
  };
  const voidBatch = {
    ...originalBatch,
    id: 'void-original',
    canonical_transaction_id: 'void-txn',
    description: 'Voided original',
  };
  const voidReversalBatch = {
    ...voidBatch,
    id: 'void-reversal',
    description: 'REVERSAL: voided original',
    reverses_batch_id: 'void-original',
  };
  const postings = (
    batchId: string,
    assetMinor: string,
  ): ExportTables['journal_postings'] => [
    { ...assetPosting, id: `${batchId}-asset`, batch_id: batchId, amount_minor: assetMinor },
    { ...incomePosting, id: `${batchId}-income`, batch_id: batchId, amount_minor: (-BigInt(assetMinor)).toString() },
  ];
  const tables = {
    ...base.tables,
    canonical_transactions: [revisionTransaction, voidTransaction],
    journal_batches: [
      originalBatch,
      reversalBatch,
      replacementBatch,
      voidBatch,
      voidReversalBatch,
    ],
    journal_postings: [
      ...postings('batch', '100'),
      ...postings('revision-reversal', '-100'),
      ...postings('revision-replacement', '70'),
      ...postings('void-original', '50'),
      ...postings('void-reversal', '-50'),
    ],
    journal_revisions: [
      {
        id: 'revision',
        original_batch_id: 'batch',
        reversal_batch_id: 'revision-reversal',
        replacement_batch_id: 'revision-replacement',
        reason: 'fixture revision',
        created_at: '2026-07-12T01:00:00Z',
      },
      {
        id: 'void',
        original_batch_id: 'void-original',
        reversal_batch_id: 'void-reversal',
        replacement_batch_id: null,
        reason: 'fixture void',
        created_at: '2026-07-12T01:00:00Z',
      },
    ],
  } as ExportTables;
  return {
    ...base,
    tables,
    trialBalance: [
      { ledgerAccountId: 'asset', currency: 'USD', balanceMinor: '70' },
      { ledgerAccountId: 'income', currency: 'USD', balanceMinor: '-70' },
    ],
  };
};
