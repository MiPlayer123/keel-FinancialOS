/**
 * Pure helpers for the cmdk category picker (teardown C4): typeahead search,
 * Income/Expense grouping with one-level parent>child indentation, per-
 * household recents, and sign→kind inference for inline create.
 *
 * Deterministic string/list logic only — no React, no storage, no network —
 * so every behavior is unit-testable. Category names are data-tier strings
 * (Law 5): they are only ever compared and displayed, never interpreted.
 */

import type { CategoryRow } from './keel-api';

/**
 * Entity-scope a category list to a single entity (D-060). Categories are
 * ledger_accounts scoped per entity, so the SAME name exists once per entity
 * with a distinct id — a transaction can only be categorized into its own
 * entity's categories (the categorize / set-splits procs reject a cross-entity
 * category). Scoping to the transaction's entity therefore both removes the
 * apparent duplication AND can only ever hide options the server would reject.
 *
 * When `entityId` is null/undefined (a genuinely cross-entity view, or a row
 * whose entity is not yet known pre-migration) the full list passes through
 * unchanged — callers on those surfaces disambiguate with an entity LABEL
 * (`entityLabel`) instead. Pure, deterministic (no React/network).
 */
export function scopeToEntity<T extends { entityId: string }>(
  categories: readonly T[],
  entityId: string | null | undefined,
): T[] {
  if (entityId === null || entityId === undefined) return [...categories];
  return categories.filter((c) => c.entityId === entityId);
}

/**
 * True when more than one owning entity is represented — the signal that a
 * category picker must disambiguate identically-named categories with an
 * entity label. A single-entity household (or an already entity-scoped list)
 * needs no label, so identical names never collide there.
 */
export function hasMultipleEntities(
  categories: readonly { entityId: string }[],
): boolean {
  const seen = new Set<string>();
  for (const c of categories) {
    seen.add(c.entityId);
    if (seen.size > 1) return true;
  }
  return false;
}

/**
 * Display name for a category, suffixed with its entity only when the picker
 * spans more than one entity (so a single-entity household stays clean). This
 * is what turns two entities' identical "Lodging" rows into "Lodging ·
 * Personal" / "Lodging · Business (LLC)". entityName is a data-tier string,
 * only displayed (Law 5).
 */
export function entityLabel(
  name: string,
  entityName: string | null | undefined,
  showEntity: boolean,
): string {
  if (!showEntity || entityName === null || entityName === undefined || entityName === '') {
    return name;
  }
  return `${name} · ${entityName}`;
}

/** Case- and diacritic-insensitive search form ("Café" matches "cafe"). */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Substring match on the normalized forms; empty query matches everything. */
export function matchesQuery(name: string, query: string): boolean {
  const q = normalizeSearch(query);
  if (q.length === 0) return true;
  return normalizeSearch(name).includes(q);
}

/** One display row: depth 1 only when the parent is present in the same list. */
export type PickerEntry = { row: CategoryRow; depth: 0 | 1 };

/**
 * Deterministic display order for one kind's categories: top-level names
 * alphabetically, each followed by its children alphabetically. A child whose
 * parent was filtered out (or is absent pre-migration) renders at depth 0 —
 * indentation without a visible parent would read as belonging to the row
 * above it.
 */
export function orderForDisplay(options: CategoryRow[]): PickerEntry[] {
  const present = new Set(options.map((c) => c.ledgerAccountId));
  const tops: CategoryRow[] = [];
  const childrenOf = new Map<string, CategoryRow[]>();
  for (const c of options) {
    const pid = c.parentLedgerAccountId ?? null;
    if (pid !== null && pid !== c.ledgerAccountId && present.has(pid)) {
      const kids = childrenOf.get(pid) ?? [];
      kids.push(c);
      childrenOf.set(pid, kids);
    } else {
      tops.push(c);
    }
  }
  const byName = (a: CategoryRow, b: CategoryRow): number => {
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.ledgerAccountId.localeCompare(b.ledgerAccountId);
  };
  tops.sort(byName);
  const out: PickerEntry[] = [];
  for (const t of tops) {
    out.push({ row: t, depth: 0 });
    const kids = childrenOf.get(t.ledgerAccountId);
    if (kids) {
      kids.sort(byName);
      for (const k of kids) out.push({ row: k, depth: 1 });
    }
  }
  return out;
}

export type PickerGroup = {
  kind: 'income' | 'expense';
  label: 'Income' | 'Expense';
  entries: PickerEntry[];
};

/**
 * Filter by the transaction's direction (when known) and the query, then
 * group Income before Expense. Empty groups are dropped.
 */
export function groupForPicker(
  categories: CategoryRow[],
  query: string,
  rowKind: 'income' | 'expense' | null,
): PickerGroup[] {
  const eligible = categories.filter(
    (c) => (rowKind ? c.kind === rowKind : true) && matchesQuery(c.name, query),
  );
  const groups: PickerGroup[] = [];
  for (const kind of ['income', 'expense'] as const) {
    const entries = orderForDisplay(eligible.filter((c) => c.kind === kind));
    if (entries.length > 0) {
      groups.push({ kind, label: kind === 'income' ? 'Income' : 'Expense', entries });
    }
  }
  return groups;
}

/** True when some eligible category's name equals the query (normalized). */
export function hasExactName(
  categories: CategoryRow[],
  query: string,
  rowKind: 'income' | 'expense' | null,
): boolean {
  const q = normalizeSearch(query);
  if (q.length === 0) return true; // nothing to create
  return categories.some(
    (c) => (rowKind ? c.kind === rowKind : true) && normalizeSearch(c.name) === q,
  );
}

/**
 * Default kind for inline create, inferred from the transaction's sign
 * (positive = money in = income). Display-only routing — no arithmetic
 * beyond a bigint sign check (Law 4); the user confirms via an explicit
 * toggle before anything is created.
 */
export function inferKindFromAmount(amountMinor: string): 'income' | 'expense' {
  try {
    return BigInt(amountMinor) > 0n ? 'income' : 'expense';
  } catch {
    return 'expense';
  }
}

/** localStorage key for a household's recently used categories. */
export function recentCategoriesKey(householdId: string): string {
  return `keel-recent-categories:${householdId}`;
}

export const RECENT_CATEGORIES_MAX = 5;

/** Most-recent-first, deduplicated, capped push. Pure — caller persists. */
export function pushRecent(
  ids: readonly string[],
  id: string,
  max: number = RECENT_CATEGORIES_MAX,
): string[] {
  return [id, ...ids.filter((x) => x !== id)].slice(0, max);
}

/** Parse a persisted recents payload defensively (unknown localStorage text). */
export function parseRecents(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .slice(0, RECENT_CATEGORIES_MAX);
  } catch {
    return [];
  }
}
