/**
 * Spendable-first display for bank cash accounts (owner directive 2026-11-04).
 *
 * For checking and savings, the account page and the Accounts list lead with
 * the bank's AVAILABLE balance (current minus pending debits and holds), with
 * KEEL's ledger balance shown smaller beneath it. Everything else keeps the
 * ledger figure: a credit card's "available" is remaining credit, not money,
 * and investments show market value.
 *
 * Display only. Totals, net worth and goals still sum the ledger balance, so
 * they keep reconciling to the transaction register (Law 9). The available
 * figure is passed through as the provider reported it — no client-side
 * arithmetic (Law 1). Absent an available figure (manual accounts, or banks
 * that don't report one) this returns null and the caller shows the ledger
 * balance as before — hides-at-absence, never a guessed number (Law 8).
 */

const CASH_SUBTYPES = new Set(['checking', 'savings']);

/** True for bank checking/savings subtypes (exact match, case-insensitive). */
export function isCashAccountSubtype(subtype: string): boolean {
  return CASH_SUBTYPES.has(subtype.trim().toLowerCase().replaceAll('_', ' '));
}

/**
 * The available balance to lead with, or null to keep the ledger balance.
 * Only an asset-kind checking/savings account with a provider-reported
 * available figure qualifies.
 */
export function spendableLeadMinor(input: {
  subtype: string;
  kind: string;
  availableMinor: string | null | undefined;
}): string | null {
  if (input.kind !== 'asset') return null;
  if (!isCashAccountSubtype(input.subtype)) return null;
  const available = input.availableMinor?.trim();
  if (!available) return null;
  return available;
}
