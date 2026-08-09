import type { CategoryRow } from '@/lib/keel-api';

/**
 * Parent-grain rollup for the spending donut (mirrors the matrix's
 * `rollupMatrix` and the Sankey's rollup, so all three widgets agree on every
 * number) plus the taxes-off row filter behind the scope bar's tax toggle.
 * Pure BigInt module — no React, no Supabase.
 */

/** One leaf category's net total over a range (signed; refunds can win). */
export type CategoryRangeEntry = {
  categoryId: string | null;
  name: string;
  amountMinor: bigint;
};

export type CategoryGroupEntry = {
  categoryId: string | null;
  name: string;
  /** Net of the parent's own activity plus every child's. */
  amountMinor: bigint;
  /** Leaf members (the parent's own activity appears as "<name> (general)"),
   *  net-signed, largest first. Empty for a standalone leaf. */
  children: CategoryRangeEntry[];
};

function compareByAmount(
  a: { amountMinor: bigint; name: string; categoryId: string | null },
  b: { amountMinor: bigint; name: string; categoryId: string | null },
): number {
  if (a.amountMinor !== b.amountMinor) return b.amountMinor > a.amountMinor ? 1 : -1;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return (a.categoryId ?? '').localeCompare(b.categoryId ?? '');
}

/**
 * Roll leaf-grain range totals up to parent categories. A leaf whose category
 * has a live parent joins that parent's group and stays reachable as a child;
 * everything else (top-level categories, Uncategorized, archived categories
 * absent from categories.list) stands alone with no children.
 */
export function rollupCategoryTotals(
  entries: CategoryRangeEntry[],
  categories: CategoryRow[],
): CategoryGroupEntry[] {
  const byId = new Map(categories.map((c) => [c.ledgerAccountId, c]));
  const groups = new Map<string, CategoryGroupEntry>();
  const ensure = (key: string, categoryId: string | null, name: string): CategoryGroupEntry => {
    const existing = groups.get(key);
    if (existing) return existing;
    const created: CategoryGroupEntry = { categoryId, name, amountMinor: 0n, children: [] };
    groups.set(key, created);
    return created;
  };
  for (const entry of entries) {
    const cat = entry.categoryId ? byId.get(entry.categoryId) : undefined;
    const parentCat = cat?.parentLedgerAccountId ? byId.get(cat.parentLedgerAccountId) : undefined;
    if (parentCat) {
      const group = ensure(parentCat.ledgerAccountId, parentCat.ledgerAccountId, parentCat.name);
      group.amountMinor += entry.amountMinor;
      group.children.push(entry);
    } else {
      const group = ensure(entry.categoryId ?? 'uncategorized', entry.categoryId, entry.name);
      group.amountMinor += entry.amountMinor;
      // Parent's own (non-sub) activity: keep it as a child line only when the
      // group actually aggregates subs, so the visible children always sum to
      // the group. Recorded now, promoted below once a sub shows up.
      group.children.push({ ...entry, name: `${entry.name} (general)` });
    }
  }
  const out = [...groups.values()];
  for (const group of out) {
    // A group with only its own "(general)" line is a standalone leaf — no
    // drill-down layer exists, so present it childless.
    if (group.children.length === 1 && group.children[0]?.categoryId === group.categoryId) {
      group.children = [];
    } else {
      group.children.sort(compareByAmount);
    }
  }
  return out.sort(compareByAmount);
}

/** Stable key of the seeded Taxes subcategory (under Government & Nonprofit). */
export const TAX_PFC_KEY = 'government_nonprofit_taxes';

/**
 * Ledger-account ids of tax categories: the seeded Taxes subcategory by its
 * rename-proof pfc_key, plus any category nested under one (deterministic,
 * never name/memo-derived — Law 5).
 */
export function taxCategoryIdSet(categories: CategoryRow[]): Set<string> {
  const ids = new Set<string>();
  for (const c of categories) {
    if (c.pfcKey === TAX_PFC_KEY) ids.add(c.ledgerAccountId);
  }
  // Fixpoint, not a single pass: descent must not depend on list order (the
  // schema says one-level nesting, but nothing here should bank on it).
  let grew = ids.size > 0;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (
        c.parentLedgerAccountId &&
        ids.has(c.parentLedgerAccountId) &&
        !ids.has(c.ledgerAccountId)
      ) {
        ids.add(c.ledgerAccountId);
        grew = true;
      }
    }
  }
  return ids;
}

type TaxFilterableRow = {
  categoryLedgerAccountId: string | null;
  splits?: { categoryLedgerAccountId: string | null }[] | null;
};

/**
 * Drop tax-categorized activity from `rows`: a row categorized to a tax
 * category disappears; a split row loses only its tax shares (and disappears
 * when nothing else remains). Rows without tax activity pass through by
 * reference, so memoized derivations downstream stay stable.
 */
export function excludeTaxSpend<T extends TaxFilterableRow>(rows: T[], taxIds: Set<string>): T[] {
  if (taxIds.size === 0) return rows;
  const out: T[] = [];
  for (const row of rows) {
    if (row.splits && row.splits.length > 0) {
      const kept = row.splits.filter(
        (s) => s.categoryLedgerAccountId === null || !taxIds.has(s.categoryLedgerAccountId),
      );
      if (kept.length === row.splits.length) out.push(row);
      else if (kept.length > 0) out.push({ ...row, splits: kept });
      continue;
    }
    if (row.categoryLedgerAccountId !== null && taxIds.has(row.categoryLedgerAccountId)) continue;
    out.push(row);
  }
  return out;
}
