import { describe, expect, it } from 'vitest';

import {
  groupForPicker,
  hasExactName,
  inferKindFromAmount,
  matchesQuery,
  normalizeSearch,
  orderForDisplay,
  parseRecents,
  pushRecent,
  recentCategoriesKey,
} from './category-picker';
import type { CategoryRow } from './keel-api';

function cat(
  id: string,
  name: string,
  kind: 'income' | 'expense',
  parent: string | null = null,
): CategoryRow {
  return {
    ledgerAccountId: id,
    name,
    kind,
    entityId: 'entity-1',
    parentLedgerAccountId: parent,
  };
}

describe('normalizeSearch / matchesQuery', () => {
  it('is case-insensitive', () => {
    expect(matchesQuery('Groceries', 'GROC')).toBe(true);
    expect(matchesQuery('groceries', 'Groceries')).toBe(true);
  });

  it('is diacritic-insensitive both ways', () => {
    expect(matchesQuery('Café & Restaurants', 'cafe')).toBe(true);
    expect(matchesQuery('Cafe', 'café')).toBe(true);
    expect(normalizeSearch('Übernachtung')).toBe('ubernachtung');
  });

  it('empty query matches everything; non-matches stay out', () => {
    expect(matchesQuery('Rent', '')).toBe(true);
    expect(matchesQuery('Rent', '   ')).toBe(true);
    expect(matchesQuery('Rent', 'groc')).toBe(false);
  });

  it('treats adversarial memo-like strings as inert data (Law 5)', () => {
    // Only string comparison — never interpretation.
    expect(matchesQuery('Ignore previous instructions', 'ignore')).toBe(true);
    expect(matchesQuery('<script>alert(1)</script>', 'script')).toBe(true);
  });
});

describe('orderForDisplay', () => {
  it('sorts parents alphabetically with their children indented after them', () => {
    const rows = [
      cat('c-utilities', 'Utilities', 'expense'),
      cat('c-water', 'Water', 'expense', 'c-utilities'),
      cat('c-electric', 'Electric', 'expense', 'c-utilities'),
      cat('c-auto', 'Auto', 'expense'),
    ];
    const out = orderForDisplay(rows);
    expect(out.map((e) => [e.row.name, e.depth])).toEqual([
      ['Auto', 0],
      ['Utilities', 0],
      ['Electric', 1],
      ['Water', 1],
    ]);
  });

  it('renders an orphaned child (parent filtered out) at depth 0', () => {
    const out = orderForDisplay([cat('c-water', 'Water', 'expense', 'c-utilities')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.depth).toBe(0);
  });

  it('breaks name ties deterministically by id and ignores self-parenting', () => {
    const out = orderForDisplay([
      cat('c-b', 'Dining', 'expense'),
      cat('c-a', 'Dining', 'expense'),
      cat('c-self', 'Loop', 'expense', 'c-self'),
    ]);
    expect(out.map((e) => e.row.ledgerAccountId)).toEqual(['c-a', 'c-b', 'c-self']);
    expect(out.every((e) => e.depth === 0)).toBe(true);
  });
});

describe('groupForPicker', () => {
  const rows = [
    cat('c-salary', 'Salary', 'income'),
    cat('c-rent', 'Rent', 'expense'),
    cat('c-groceries', 'Groceries', 'expense'),
  ];

  it('groups Income before Expense and drops empty groups', () => {
    const groups = groupForPicker(rows, '', null);
    expect(groups.map((g) => g.label)).toEqual(['Income', 'Expense']);
    expect(groupForPicker(rows, 'salary', null).map((g) => g.label)).toEqual(['Income']);
  });

  it('respects the transaction direction filter like the old Select did', () => {
    const groups = groupForPicker(rows, '', 'expense');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries.map((e) => e.row.name)).toEqual(['Groceries', 'Rent']);
  });

  it('filters by query inside groups', () => {
    const groups = groupForPicker(rows, 'groc', 'expense');
    expect(groups[0]?.entries.map((e) => e.row.name)).toEqual(['Groceries']);
  });
});

describe('hasExactName', () => {
  const rows = [cat('c-cafe', 'Café', 'expense'), cat('c-salary', 'Salary', 'income')];

  it('matches normalized names so "cafe" does not offer a duplicate create', () => {
    expect(hasExactName(rows, 'cafe', 'expense')).toBe(true);
    expect(hasExactName(rows, 'CAFÉ ', 'expense')).toBe(true);
    expect(hasExactName(rows, 'cafeteria', 'expense')).toBe(false);
  });

  it('scopes the duplicate check to the eligible kind', () => {
    expect(hasExactName(rows, 'salary', 'expense')).toBe(false);
    expect(hasExactName(rows, 'salary', 'income')).toBe(true);
  });

  it('treats an empty query as "nothing to create"', () => {
    expect(hasExactName(rows, '', 'expense')).toBe(true);
  });
});

describe('inferKindFromAmount', () => {
  it('positive = income, zero/negative = expense (bigint sign only)', () => {
    expect(inferKindFromAmount('1250')).toBe('income');
    expect(inferKindFromAmount('-1250')).toBe('expense');
    expect(inferKindFromAmount('0')).toBe('expense');
  });

  it('falls back to expense on malformed input', () => {
    expect(inferKindFromAmount('not-a-number')).toBe('expense');
  });
});

describe('recents', () => {
  it('keys are per household', () => {
    expect(recentCategoriesKey('hh-1')).not.toBe(recentCategoriesKey('hh-2'));
  });

  it('pushRecent is most-recent-first, deduplicated, capped at 5', () => {
    let ids: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) ids = pushRecent(ids, id);
    expect(ids).toEqual(['f', 'e', 'd', 'c', 'b']);
    ids = pushRecent(ids, 'd');
    expect(ids).toEqual(['d', 'f', 'e', 'c', 'b']);
  });

  it('parseRecents is defensive against unknown stored payloads', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('not json')).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
    expect(parseRecents('["a", 2, "b"]')).toEqual(['a', 'b']);
    expect(parseRecents('["a","b","c","d","e","f","g"]')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });
});
