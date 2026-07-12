import { fromJson, toJson } from './canonical.js';
import { formatMinorUnits } from './currency.js';
import { currentLiveJournalBatches } from './live-ledger.js';
import type { ExportRow, HouseholdExport } from './types.js';

const ACCOUNT_TYPES: Readonly<Record<string, string>> = {
  asset: 'Assets',
  liability: 'Liabilities',
  income: 'Income',
  expense: 'Expenses',
  equity: 'Equity',
};

const text = (row: ExportRow, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError(`Expected string ${key}.`);
  return value;
};

const component = (name: string): string => {
  const words = name.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const joined = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('-');
  if (joined === '') return 'Account';
  return /^\d/u.test(joined) ? `Account-${joined}` : joined;
};

const accountName = (row: ExportRow): string => {
  const prefix = ACCOUNT_TYPES[text(row, 'kind')];
  if (prefix === undefined) throw new TypeError('Unsupported ledger account kind.');
  const id = text(row, 'id').replace(/[^A-Za-z0-9]/gu, '').slice(0, 8) || 'Row';
  return `${prefix}:${component(text(row, 'name'))}-Id${id}`;
};

const narration = (value: string): string => value
  .replaceAll('\\', '\\\\')
  .replaceAll('"', '\\"')
  .replace(/[\r\n]+/gu, ' ')
  .trim();

/** Current live double-entry beancount journal; rejects any corrupt live batch. */
export const toBeancount = (snapshot: HouseholdExport): string => {
  const prepared = fromJson(toJson(snapshot));
  const accounts = new Map(prepared.tables.ledger_accounts.map((row) => [text(row, 'id'), row]));
  const beanNames = new Map([...accounts].map(([id, row]) => [id, accountName(row)]));
  const lines = [...accounts.values()]
    .sort((left, right) => accountName(left).localeCompare(accountName(right), 'en'))
    .map((row) => `1970-01-01 open ${accountName(row)} ${text(row, 'currency')}`);

  const postingsByBatch = new Map<string, ExportRow[]>();
  for (const posting of prepared.tables.journal_postings) {
    const batchId = text(posting, 'batch_id');
    const postings = postingsByBatch.get(batchId) ?? [];
    postings.push(posting);
    postingsByBatch.set(batchId, postings);
  }

  for (const batch of currentLiveJournalBatches(prepared)) {
    const postings = postingsByBatch.get(text(batch, 'id')) ?? [];
    if (postings.length < 2) throw new Error(`Journal batch ${text(batch, 'id')} does not balance.`);
    const balances = new Map<string, bigint>();
    for (const posting of postings) {
      const currency = text(posting, 'currency');
      balances.set(currency, (balances.get(currency) ?? 0n) + BigInt(text(posting, 'amount_minor')));
    }
    if ([...balances.values()].some((balance) => balance !== 0n)) {
      throw new Error(`Journal batch ${text(batch, 'id')} does not balance.`);
    }
    lines.push('', `${text(batch, 'effective_date')} * "${narration(text(batch, 'description'))}"`);
    for (const posting of postings) {
      const ledgerId = text(posting, 'ledger_account_id');
      const beanName = beanNames.get(ledgerId);
      if (beanName === undefined) throw new Error(`Missing ledger account ${ledgerId}.`);
      const currency = text(posting, 'currency');
      lines.push(`  ${beanName}  ${formatMinorUnits(text(posting, 'amount_minor'), currency)} ${currency}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};
