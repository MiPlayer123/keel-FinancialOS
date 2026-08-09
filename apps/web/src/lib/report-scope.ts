/**
 * Reports scope bar — pure helpers (teardown C14: ONE scope bar drives every
 * report widget; charts drill into the register).
 *
 * A single scope — date range + account subset + entity — is parsed from the
 * URL search params, applied to every client-side derivation on
 * /dashboard/reports, stated in every widget footnote (Law 9: scope-safe
 * calculation, reproducible numbers), and serialized back so report views are
 * shareable/bookmarkable.
 *
 * Pure module: no React, no Supabase, no Date coupling (callers may inject
 * `now`) — unit-tested in report-scope.test.ts.
 */

export const RANGE_PRESETS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3', label: 'Last 3 months' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'last_12', label: 'Last 12 months' },
] as const;

export type RangePresetKey = (typeof RANGE_PRESETS)[number]['key'];

export const DEFAULT_SCOPE_PRESET: RangePresetKey = 'this_month';

const PRESET_KEYS = new Set<string>(RANGE_PRESETS.map((p) => p.key));
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive [from, to] calendar-day range for a preset chip, anchored on `now`. */
export function presetRange(key: RangePresetKey, now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = isoDate(now);
  switch (key) {
    case 'this_month':
      return { from: isoDate(new Date(Date.UTC(y, m, 1))), to: today };
    case 'last_month':
      return {
        from: isoDate(new Date(Date.UTC(y, m - 1, 1))),
        to: isoDate(new Date(Date.UTC(y, m, 0))),
      };
    case 'last_3':
      return { from: isoDate(new Date(Date.UTC(y, m - 2, 1))), to: today };
    case 'ytd':
      return { from: isoDate(new Date(Date.UTC(y, 0, 1))), to: today };
    case 'last_12':
      return { from: isoDate(new Date(Date.UTC(y, m - 11, 1))), to: today };
  }
}

/**
 * The one scope every report widget honors.
 * - `preset` null means a custom [from, to] typed into the date inputs.
 * - `accountIds` [] means "all accounts" (within the entity, when one is set).
 * - `entityId` null means all entities.
 */
export type ReportScope = {
  preset: RangePresetKey | null;
  /** Inclusive ISO calendar days. Invariant: from <= to. */
  from: string;
  to: string;
  accountIds: string[];
  entityId: string | null;
  /** False = tax payments (the seeded Taxes subcategory) are excluded from
   *  the spending widgets; the tax-schedule card and CSV export stay full. */
  includeTaxes: boolean;
};

/** The subset of URLSearchParams we read — keeps the helper testable. */
export type ScopeParamsLike = { get(name: string): string | null };

/**
 * Parse the scope from URL search params. Precedence: a valid `range` preset
 * wins (preset URLs stay live — "this month" re-anchors each visit); else a
 * valid custom `from`/`to` pair; else the default preset. Unknown account or
 * entity ids are kept here (opaque strings) and resolved against the real
 * account list by `scopedAccountIdSet`, where stale ids drop out.
 */
export function parseReportScope(params: ScopeParamsLike, now: Date = new Date()): ReportScope {
  const rangeParam = params.get('range');
  const fromParam = params.get('from');
  const toParam = params.get('to');

  let preset: RangePresetKey | null = null;
  let from: string;
  let to: string;
  if (rangeParam !== null && PRESET_KEYS.has(rangeParam)) {
    preset = rangeParam as RangePresetKey;
    ({ from, to } = presetRange(preset, now));
  } else if (
    fromParam !== null &&
    toParam !== null &&
    ISO_DAY_RE.test(fromParam) &&
    ISO_DAY_RE.test(toParam) &&
    fromParam <= toParam
  ) {
    from = fromParam;
    to = toParam;
  } else {
    preset = DEFAULT_SCOPE_PRESET;
    ({ from, to } = presetRange(preset, now));
  }

  const accountsParam = params.get('accounts');
  const accountIds =
    accountsParam !== null && accountsParam !== ''
      ? [...new Set(accountsParam.split(',').filter((s) => s !== ''))]
      : [];
  const entityParam = params.get('entity');
  const entityId = entityParam !== null && entityParam !== '' ? entityParam : null;
  const includeTaxes = params.get('taxes') !== 'off';

  return { preset, from, to, accountIds, entityId, includeTaxes };
}

/**
 * Serialize the scope for the URL. The all-defaults scope serializes to '' so
 * plain /dashboard/reports stays canonical; presets serialize as `range` (not
 * frozen dates) so a bookmarked "This month" is always this month.
 */
export function reportScopeToSearch(scope: ReportScope): string {
  const p = new URLSearchParams();
  if (scope.preset !== null) {
    if (scope.preset !== DEFAULT_SCOPE_PRESET) p.set('range', scope.preset);
  } else {
    p.set('from', scope.from);
    p.set('to', scope.to);
  }
  if (scope.entityId !== null) p.set('entity', scope.entityId);
  if (scope.accountIds.length > 0) p.set('accounts', scope.accountIds.join(','));
  if (!scope.includeTaxes) p.set('taxes', 'off');
  return p.toString();
}

export type ScopeAccount = { id: string; entityId: string };

/**
 * Resolve the scope to a concrete set of account ids, or null when the scope
 * places no account restriction at all. The entity narrows first; explicit
 * account picks intersect with it. Stale ids (a URL pasted from another
 * household, a deleted account) drop out rather than silently matching
 * nothing — the resulting set is exactly what the footnote counts.
 */
export function scopedAccountIdSet(
  scope: Pick<ReportScope, 'accountIds' | 'entityId'>,
  accounts: ScopeAccount[],
): Set<string> | null {
  const entityAccounts =
    scope.entityId === null ? accounts : accounts.filter((a) => a.entityId === scope.entityId);
  if (scope.accountIds.length === 0) {
    if (scope.entityId === null) return null;
    return new Set(entityAccounts.map((a) => a.id));
  }
  const chosen = new Set(scope.accountIds);
  return new Set(entityAccounts.filter((a) => chosen.has(a.id)).map((a) => a.id));
}

/** True when the row's account is inside the scope (null set = unrestricted). */
export function rowInScope(row: { accountId: string }, accountSet: Set<string> | null): boolean {
  return accountSet === null || accountSet.has(row.accountId);
}

/** Rows inside BOTH the account scope and the inclusive [from, to] day range. */
export function scopeRows<T extends { accountId: string; effectiveDate: string }>(
  rows: T[],
  scope: Pick<ReportScope, 'from' | 'to'>,
  accountSet: Set<string> | null,
): T[] {
  return rows.filter((r) => {
    if (!rowInScope(r, accountSet)) return false;
    const day = r.effectiveDate.slice(0, 10);
    return day >= scope.from && day <= scope.to;
  });
}

/** Total calendar months intersecting [from, to], uncapped — lets callers
 *  detect when `scopeMonths` truncated the range so a wide custom scope
 *  doesn't silently claim coverage its monthly widgets don't show (review
 *  r3603814914). */
export function scopeMonthSpan(from: string, to: string): number {
  const [fy = 1970, fm = 1] = from.slice(0, 7).split('-').map(Number);
  const [ty = 1970, tm = 1] = to.slice(0, 7).split('-').map(Number);
  return ty * 12 + (tm - 1) - (fy * 12 + (fm - 1)) + 1;
}

/**
 * YYYY-MM keys of every calendar month intersecting [from, to], oldest first,
 * capped to the most recent `cap` (a 12-column table still scrolls; beyond
 * that it stops being a table). A scope wider than `cap` months only shows
 * the most recent `cap` — callers must disclose this via `scopeMonthSpan`
 * rather than let the widget's own "N months" label imply full coverage.
 */
export function scopeMonths(from: string, to: string, cap = 12): string[] {
  const [fy = 1970, fm = 1] = from.slice(0, 7).split('-').map(Number);
  const [ty = 1970, tm = 1] = to.slice(0, 7).split('-').map(Number);
  const start = fy * 12 + (fm - 1);
  const end = ty * 12 + (tm - 1);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
  }
  return out.slice(-cap);
}

/**
 * A month bucket clamped to the scope range. A bar/column for a partially
 * covered month summed only the in-range days, so its drill link must carry
 * exactly those days (Law 9: the register a chart opens must reproduce the
 * number that was clicked).
 */
export function clampMonthToRange(
  month: string,
  from: string,
  to: string,
): { from: string; to: string } {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = isoDate(new Date(Date.UTC(y, m, 0)));
  return { from: first > from ? first : from, to: last < to ? last : to };
}

/**
 * Deep link into the ledger register matching a widget's numbers:
 * `category` (null = uncategorized, undefined = no category filter),
 * `from`/`to` day bounds, and `account` — the ledger's account filter is
 * single-select, so the account param is carried only when the scope resolves
 * to exactly ONE account. A multi-account scope drills with category+dates
 * only; the ledger's own filter bar visibly shows "All accounts", so the
 * wider register is disclosed, never a silent narrowing.
 */
export function ledgerDrillHref(input: {
  categoryId?: string | null;
  from: string;
  to: string;
  accountSet: Set<string> | null;
}): string {
  const p = new URLSearchParams();
  if (input.categoryId !== undefined) p.set('category', input.categoryId ?? 'uncategorized');
  p.set('from', input.from);
  p.set('to', input.to);
  if (input.accountSet !== null && input.accountSet.size === 1) {
    const [only] = input.accountSet;
    if (only !== undefined) p.set('account', only);
  }
  return `/dashboard/ledger?${p.toString()}`;
}

/**
 * The scope descriptor every widget footnote leads with — "3 of 5 accounts ·
 * 2026-05-01 – 2026-07-17" (Law 9: the active scope sits adjacent to the
 * numbers it qualifies; same footnote pattern the widgets already use).
 */
export function scopeLabel(input: {
  scope: Pick<ReportScope, 'from' | 'to' | 'entityId'>;
  accountSet: Set<string> | null;
  totalAccounts: number;
  entityName?: string | null;
}): string {
  const { scope, accountSet, totalAccounts } = input;
  const accountsText =
    accountSet === null || (scope.entityId === null && accountSet.size === totalAccounts)
      ? 'All accounts'
      : `${String(accountSet.size)} of ${String(totalAccounts)} account${totalAccounts === 1 ? '' : 's'}`;
  const entityText =
    input.entityName != null && input.entityName !== '' ? `${input.entityName} · ` : '';
  return `${entityText}${accountsText} · ${input.scope.from} – ${input.scope.to}`;
}

/** Most frequent currency in `rows` (report cards format in one currency). */
export function dominantCurrency(rows: { currency: string }[], fallback = 'USD'): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best = fallback;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}
