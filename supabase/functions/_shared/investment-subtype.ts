// Mirrors apps/web/src/lib/investment-subtype.ts -- same keyword-match
// policy, expressed here for the worker's own decision of whether to call
// Plaid's Investments product for a connection at all (calling it for a
// connection with no investment accounts would waste a provider-metered
// call and can even error for items that never had the product
// authorized). Keep the two lists in sync; this side has no UI-visibility
// role, only a call-avoidance one.
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
