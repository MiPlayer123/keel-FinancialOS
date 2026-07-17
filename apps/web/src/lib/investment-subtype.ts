/**
 * `accounts.subtype` is free text (Plaid's own subtype string for
 * Plaid-linked accounts, or one of the fixed values in add-account-dialog's
 * SUBTYPES for manual ones) — there is no enum to switch on. This is a
 * best-effort keyword match to decide whether an account's page should
 * offer the Holdings card, not a validated classification; it only gates
 * UI visibility; it never blocks a write.
 */
const INVESTMENT_KEYWORDS = [
  'investment',
  'brokerage',
  'ira',
  '401k',
  '403b',
  'roth',
  'hsa',
  'mutual fund',
  '529',
  'pension',
  'retirement',
  'annuity',
  'stock plan',
];

export function looksLikeInvestmentAccount(subtype: string): boolean {
  const lower = subtype.toLowerCase();
  return INVESTMENT_KEYWORDS.some((kw) => lower.includes(kw));
}
