import { fromJson, toJson } from './canonical.js';
import { formatMinorUnits } from './currency.js';
import { currentLiveJournalBatches } from './live-ledger.js';
import type { ExportRow, HouseholdExport } from './types.js';

const text = (row: ExportRow, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`Expected string ${key}.`);
  return value;
};

const qifText = (value: string): string => value.replace(/[\r\n]+/gu, ' ').trim();

const qifDate = (date: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) throw new TypeError('QIF effective date must be YYYY-MM-DD.');
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return `${month}/${day}/${year}`;
};

/** Combined QIF with one Bank account section per real asset account. */
export const toQif = (snapshot: HouseholdExport): string => {
  const prepared = fromJson(toJson(snapshot));
  const ledgerById = new Map(prepared.tables.ledger_accounts.map((row) => [text(row, 'id'), row]));
  const batchesByTransaction = new Map<string, ExportRow[]>();
  for (const batch of currentLiveJournalBatches(prepared)) {
    const transactionId = text(batch, 'canonical_transaction_id');
    const batches = batchesByTransaction.get(transactionId) ?? [];
    batches.push(batch);
    batchesByTransaction.set(transactionId, batches);
  }
  const postingsByBatch = new Map<string, ExportRow[]>();
  for (const posting of prepared.tables.journal_postings) {
    const batchId = text(posting, 'batch_id');
    const postings = postingsByBatch.get(batchId) ?? [];
    postings.push(posting);
    postingsByBatch.set(batchId, postings);
  }

  const lines: string[] = [];
  for (const account of prepared.tables.accounts) {
    const ledgerId = text(account, 'ledger_account_id');
    const ledger = ledgerById.get(ledgerId);
    if (ledger?.['kind'] !== 'asset') continue;
    const currency = text(account, 'currency');
    lines.push('!Account', `N${qifText(text(account, 'name'))}`, 'TBank', '^', '!Type:Bank');

    for (const transaction of prepared.tables.canonical_transactions) {
      if (transaction['account_id'] !== account['id']) continue;
      for (const batch of batchesByTransaction.get(text(transaction, 'id')) ?? []) {
        const postings = postingsByBatch.get(text(batch, 'id')) ?? [];
        const assetMinor = postings
          .filter((posting) => posting['ledger_account_id'] === ledgerId && posting['currency'] === currency)
          .reduce((sum, posting) => sum + BigInt(text(posting, 'amount_minor')), 0n);
        if (assetMinor === 0n) continue;
        const offsets = postings.filter((posting) => posting['ledger_account_id'] !== ledgerId);
        let category = 'Split';
        if (offsets.length === 1) {
          const [offset] = offsets as [ExportRow];
          const offsetLedger = ledgerById.get(text(offset, 'ledger_account_id')) as ExportRow;
          category = qifText(text(offsetLedger, 'name'));
        }
        lines.push(
          `D${qifDate(text(transaction, 'effective_date'))}`,
          `T${formatMinorUnits(assetMinor, currency)}`,
          `P${qifText(text(transaction, 'description'))}`,
          `M${qifText(text(transaction, 'economic_event_key'))}`,
          `L${category}`,
          '^',
        );
      }
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};
