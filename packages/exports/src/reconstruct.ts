import type { HouseholdExport, TrialBalanceRow } from './types.js';

/** Rebuild the ledger view using only portable journal postings. */
export const reconstructTrialBalance = (snapshot: HouseholdExport): TrialBalanceRow[] => {
  const totals = new Map<string, bigint>();
  for (const posting of snapshot.tables.journal_postings) {
    const ledgerAccountId = posting['ledger_account_id'];
    const currency = posting['currency'];
    const amountMinor = posting['amount_minor'];
    if (
      typeof ledgerAccountId !== 'string' ||
      typeof currency !== 'string' ||
      typeof amountMinor !== 'string' ||
      !/^-?\d+$/u.test(amountMinor)
    ) {
      throw new TypeError('Invalid exported journal posting.');
    }
    const key = `${ledgerAccountId}\u0000${currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + BigInt(amountMinor));
  }
  return [...totals].map(([key, balance]) => {
    const separator = key.indexOf('\u0000');
    const ledgerAccountId = key.slice(0, separator);
    const currency = key.slice(separator + 1);
    return { ledgerAccountId, currency, balanceMinor: balance.toString() };
  }).sort((left, right) =>
    left.ledgerAccountId.localeCompare(right.ledgerAccountId, 'en') ||
    left.currency.localeCompare(right.currency, 'en'));
};
