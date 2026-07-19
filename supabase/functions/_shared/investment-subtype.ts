// Mirrors apps/web/src/lib/investment-subtype.ts — same canonical policy
// (keep the three lists byte-identical across the two files and the SQL
// helper public.keel_is_investment_subtype). This side's consumer is the
// worker's decision of whether to call Plaid's Investments product for a
// connection at all (calling it for a connection with no investment
// accounts wastes a provider-metered call and can error for items that
// never had the product authorized), so it primarily uses the
// holdings-sync-eligibility tier: exact Plaid investment subtypes ∪ keyword
// fallback, WITHOUT 'cash management' (a depository cash-management account
// alone must not trigger an Investments call — display surfaces include it,
// provider calls do not; ruling in migration 20260718122000).

/** Plaid `account.subtype` values documented under account type `investment`
 *  / legacy `brokerage` (lowercase, exact). `other` deliberately excluded —
 *  ambiguous across Plaid types when only the subtype is stored; the worker
 *  catches live type=investment accounts via Plaid's `type` field. */
export const PLAID_INVESTMENT_SUBTYPES = [
  '529',
  '401a',
  '401k',
  '403b',
  '457b',
  'brokerage',
  'cash isa',
  'crypto exchange',
  'education savings account',
  'fixed annuity',
  'gic',
  'health reimbursement arrangement',
  'hsa',
  'isa',
  'ira',
  'keogh',
  'lif',
  'life insurance',
  'lira',
  'lrif',
  'lrsp',
  'mutual fund',
  'non-custodial wallet',
  'non-taxable brokerage account',
  'other annuity',
  'other insurance',
  'pension',
  'prif',
  'profit sharing plan',
  'qshr',
  'rdsp',
  'resp',
  'retirement',
  'rlif',
  'roth',
  'roth 401k',
  'rrif',
  'rrsp',
  'sarsep',
  'sep ira',
  'simple ira',
  'sipp',
  'stock plan',
  'tfsa',
  'thrift savings plan',
  'trust',
  'ugma',
  'utma',
  'variable annuity',
] as const;

const PLAID_INVESTMENT_SET: ReadonlySet<string> = new Set<string>(PLAID_INVESTMENT_SUBTYPES);

/** Keyword fallback for manual/free-text subtypes only. */
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

const matchesKeyword = (lower: string): boolean =>
  INVESTMENT_KEYWORDS.some((kw) => lower.includes(kw));

/**
 * Provider-call tier: is this subtype evidence that the item carries the
 * Plaid Investments product? Exact Plaid set ∪ keyword fallback; excludes
 * 'cash management' (see header).
 */
export function isHoldingsSyncEligibleSubtype(subtype: string): boolean {
  const lower = subtype.trim().toLowerCase();
  return PLAID_INVESTMENT_SET.has(lower) || matchesKeyword(lower);
}

/**
 * Display tier (mirrors public.keel_is_investment_subtype and the web
 * `looksLikeInvestmentAccount`): provider-call tier ∪ 'cash management'.
 */
export function looksLikeInvestmentAccount(subtype: string): boolean {
  const lower = subtype.trim().toLowerCase();
  return PLAID_INVESTMENT_SET.has(lower) || matchesKeyword(lower) || lower === 'cash management';
}
