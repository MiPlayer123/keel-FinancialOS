/**
 * Canonical "is this an investment account" policy — ONE list, three surfaces.
 *
 * `accounts.subtype` is free text (Plaid's own subtype string for
 * Plaid-linked accounts, or one of the fixed values in add-account-dialog's
 * SUBTYPES for manual ones) — there is no enum to switch on, and the Plaid
 * account `type` is NOT stored, only its asset/liability projection. So the
 * canonical decision is subtype-based:
 *
 *   1. Exact match against PLAID_INVESTMENT_SUBTYPES — the full published
 *      Plaid subtype set for account type `investment` (and its legacy
 *      `brokerage` alias): crypto exchange, trust, HSA, 529, every IRA
 *      variant, Canadian/UK registered plans, etc.
 *   2. Keyword fallback for manual/free-text subtypes ("My Roth IRA").
 *   3. Display tier ONLY: 'cash management' — a brokerage cash-management
 *      account (Plaid type `depository`) IS an account the user expects on
 *      the investments surfaces (ruling in migration 20260718122000), but it
 *      must NOT by itself trigger a Plaid Investments API call (an item with
 *      only depository accounts errors on /investments/holdings/get), so it
 *      is excluded from the holdings-sync-eligibility tier.
 *
 * Mirrored (keep byte-identical policy, all three lists) in:
 *   - supabase/functions/_shared/investment-subtype.ts (worker eligibility)
 *   - public.keel_is_investment_subtype (SQL read models; display tier)
 *
 * Best-effort classification: it gates UI visibility and provider-call
 * eligibility only; it never blocks a write.
 */

/**
 * Plaid `account.subtype` values documented under account type `investment`
 * / legacy `brokerage` (lowercase, exact). Deliberately EXCLUDES `other`:
 * with only the subtype stored, `other` is ambiguous across Plaid types
 * (investment/other both use it) and would misclassify non-investment
 * accounts; the worker still catches type=investment `other` accounts via
 * Plaid's live `type` field when deciding holdings-sync eligibility.
 */
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

/** Keyword fallback for manual/free-text subtypes only — exact Plaid
 *  subtypes are covered by PLAID_INVESTMENT_SUBTYPES above. */
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

/** Exact member of Plaid's published investment subtype set. */
export function isPlaidInvestmentSubtype(subtype: string): boolean {
  return PLAID_INVESTMENT_SET.has(subtype.trim().toLowerCase());
}

/**
 * Brokerage cash-management sweep account (Plaid type `depository`,
 * subtype `cash management`) — investment-adjacent for DISPLAY (its balance
 * is cash-equivalent money market), never for provider-call eligibility.
 */
export function isCashManagementSubtype(subtype: string): boolean {
  return subtype.trim().toLowerCase() === 'cash management';
}

/**
 * Display tier: should this account appear on investment surfaces
 * (investments page read models, account-page Holdings card)? Exact Plaid
 * set ∪ keyword fallback ∪ 'cash management' (broadened, see header).
 * Mirrors public.keel_is_investment_subtype.
 */
export function looksLikeInvestmentAccount(subtype: string): boolean {
  const lower = subtype.trim().toLowerCase();
  return PLAID_INVESTMENT_SET.has(lower) || matchesKeyword(lower) || lower === 'cash management';
}

/**
 * Provider-call tier: is this subtype evidence that the item carries the
 * Plaid Investments product (so the worker may call
 * /investments/holdings/get)? Same as the display tier MINUS
 * 'cash management' — a depository cash-management account alone must not
 * trigger an Investments call (it errors on items without the product).
 */
export function isHoldingsSyncEligibleSubtype(subtype: string): boolean {
  const lower = subtype.trim().toLowerCase();
  return PLAID_INVESTMENT_SET.has(lower) || matchesKeyword(lower);
}

/**
 * F-023: "Retirement" is an ACCOUNT CLASS, not a legal entity (Mikul
 * 2026-07-18) — the accounts page groups these under their owning entity.
 * Same best-effort keyword contract as above: retirement-flavored subtypes
 * only (a taxable brokerage is investment but NOT retirement). UI grouping
 * only; never gates a write.
 */
const RETIREMENT_KEYWORDS = [
  'ira',
  '401k',
  '401a',
  '403b',
  '457',
  'roth',
  'pension',
  'retirement',
  'annuity',
  'keogh',
  'sarsep',
  'thrift savings',
];

export function looksLikeRetirementAccount(subtype: string): boolean {
  const lower = subtype.toLowerCase();
  return RETIREMENT_KEYWORDS.some((kw) => lower.includes(kw));
}
