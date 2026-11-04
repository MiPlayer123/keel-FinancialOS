import { describe, expect, it } from 'vitest';

import {
  clampMonthToRange,
  DEFAULT_SCOPE_PRESET,
  defaultScopePreset,
  dominantCurrency,
  ledgerDrillHref,
  parseReportScope,
  presetRange,
  reportScopeToSearch,
  scopeLabel,
  scopeMonths,
  scopeMonthSpan,
  scopeRows,
  scopedAccountIdSet,
  type ReportScope,
} from './report-scope';

// A fixed clock: Friday 2026-07-17 (mid-month, mid-year — exercises partials).
const NOW = new Date('2026-07-17T12:00:00Z');

function params(entries: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => entries[name] ?? null };
}

describe('presetRange', () => {
  it('anchors every preset on the injected clock', () => {
    expect(presetRange('this_month', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-17' });
    expect(presetRange('last_month', NOW)).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(presetRange('last_3', NOW)).toEqual({ from: '2026-05-01', to: '2026-07-17' });
    expect(presetRange('ytd', NOW)).toEqual({ from: '2026-01-01', to: '2026-07-17' });
    expect(presetRange('last_12', NOW)).toEqual({ from: '2025-08-01', to: '2026-07-17' });
  });

  it('handles the January year rollover for last_month', () => {
    const jan = new Date('2026-01-05T00:00:00Z');
    expect(presetRange('last_month', jan)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('quarter presets', () => {
  it('this quarter runs from the quarter start to today', () => {
    expect(presetRange('this_quarter', new Date('2026-11-03T12:00:00Z'))).toEqual({
      from: '2026-10-01',
      to: '2026-11-03',
    });
  });
  it('last quarter is the full previous quarter, across a year boundary', () => {
    expect(presetRange('last_quarter', new Date('2026-11-03T12:00:00Z'))).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(presetRange('last_quarter', new Date('2026-02-10T12:00:00Z'))).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });
});

describe('defaultScopePreset', () => {
  it('opens on last month during the first week, this month after', () => {
    expect(defaultScopePreset(new Date('2026-11-02T12:00:00Z'))).toBe('last_month');
    expect(defaultScopePreset(new Date('2026-11-07T12:00:00Z'))).toBe('last_month');
    expect(defaultScopePreset(new Date('2026-11-08T12:00:00Z'))).toBe('this_month');
  });

  it('a bare URL early in the month parses to last month; serializing pins the preset', () => {
    const early = new Date('2026-11-02T12:00:00Z');
    const s = parseReportScope(params({}), early);
    expect(s).toMatchObject({ preset: 'last_month', from: '2026-10-01', to: '2026-10-31' });
    expect(reportScopeToSearch(s)).toBe('range=last_month');
    expect(reportScopeToSearch({ ...s, preset: 'this_month' })).toBe('range=this_month');
  });
});

describe('parseReportScope', () => {
  it('defaults to the this_month preset with no params', () => {
    expect(parseReportScope(params({}), NOW)).toEqual({
      preset: DEFAULT_SCOPE_PRESET,
      from: '2026-07-01',
      to: '2026-07-17',
      accountIds: [],
      entityId: null,
      includeTaxes: true,
    });
  });

  it('a valid range preset wins over from/to', () => {
    const s = parseReportScope(params({ range: 'last_month', from: '2020-01-01', to: '2020-02-01' }), NOW);
    expect(s.preset).toBe('last_month');
    expect(s.from).toBe('2026-06-01');
    expect(s.to).toBe('2026-06-30');
  });

  it('accepts a custom from/to pair as preset null', () => {
    const s = parseReportScope(params({ from: '2026-05-10', to: '2026-06-20' }), NOW);
    expect(s).toMatchObject({ preset: null, from: '2026-05-10', to: '2026-06-20' });
  });

  it('rejects malformed or inverted custom ranges (falls back to default)', () => {
    const badCases: Record<string, string>[] = [
      { from: '2026-06-20', to: '2026-05-10' }, // inverted
      { from: 'garbage', to: '2026-06-20' },
      { from: '2026-05-10' }, // half a pair
      { range: 'not_a_preset' },
    ];
    for (const bad of badCases) {
      const s = parseReportScope(params(bad), NOW);
      expect(s.preset).toBe(DEFAULT_SCOPE_PRESET);
      expect(s.from).toBe('2026-07-01');
    }
  });

  it('splits and dedupes the accounts param; empty entity is null', () => {
    const s = parseReportScope(params({ accounts: 'a,b,,a', entity: '' }), NOW);
    expect(s.accountIds).toEqual(['a', 'b']);
    expect(s.entityId).toBeNull();
  });

  it('taxes=off parses to includeTaxes false; anything else stays on', () => {
    expect(parseReportScope(params({ taxes: 'off' }), NOW).includeTaxes).toBe(false);
    expect(parseReportScope(params({ taxes: 'on' }), NOW).includeTaxes).toBe(true);
    expect(parseReportScope(params({}), NOW).includeTaxes).toBe(true);
  });
});

describe('reportScopeToSearch', () => {
  it('always pins the preset (the default is date-adaptive)', () => {
    expect(reportScopeToSearch(parseReportScope(params({}), NOW))).toBe('range=this_month');
  });

  it('round-trips presets, custom ranges, accounts, and entity', () => {
    const cases: Record<string, string>[] = [
      { range: 'last_3' },
      { from: '2026-05-10', to: '2026-06-20' },
      { range: 'ytd', entity: 'ent-1', accounts: 'a,b' },
      { accounts: 'a' },
      { taxes: 'off' },
      { range: 'last_3', taxes: 'off' },
    ];
    for (const c of cases) {
      const scope = parseReportScope(params(c), NOW);
      const reparsed = parseReportScope(new URLSearchParams(reportScopeToSearch(scope)), NOW);
      expect(reparsed).toEqual(scope);
    }
  });

  it('serializes presets as range keys, never frozen dates', () => {
    const scope: ReportScope = {
      preset: 'last_month',
      from: '2026-06-01',
      to: '2026-06-30',
      accountIds: [],
      entityId: null,
      includeTaxes: true,
    };
    expect(reportScopeToSearch(scope)).toBe('range=last_month');
  });
});

const ACCOUNTS = [
  { id: 'chk', entityId: 'personal' },
  { id: 'sav', entityId: 'personal' },
  { id: 'biz', entityId: 'llc' },
];

describe('scopedAccountIdSet', () => {
  it('null (unrestricted) when no entity and no account picks', () => {
    expect(scopedAccountIdSet({ accountIds: [], entityId: null }, ACCOUNTS)).toBeNull();
  });

  it('an entity alone restricts to its accounts', () => {
    expect(scopedAccountIdSet({ accountIds: [], entityId: 'llc' }, ACCOUNTS)).toEqual(
      new Set(['biz']),
    );
  });

  it('account picks intersect with the entity; stale ids drop out', () => {
    expect(
      scopedAccountIdSet({ accountIds: ['chk', 'biz', 'deleted'], entityId: 'personal' }, ACCOUNTS),
    ).toEqual(new Set(['chk']));
    expect(scopedAccountIdSet({ accountIds: ['deleted'], entityId: null }, ACCOUNTS)).toEqual(
      new Set(),
    );
  });
});

describe('scopedAccountIdSet — account continuity', () => {
  it('picking a card brings the old number it replaced', () => {
    const accounts = [
      { id: 'card-old', entityId: 'personal', replacedByAccountId: 'card-new' },
      { id: 'card-new', entityId: 'personal' },
      { id: 'chk', entityId: 'personal' },
    ];
    expect(scopedAccountIdSet({ accountIds: ['card-new'], entityId: null }, accounts)).toEqual(
      new Set(['card-new', 'card-old']),
    );
    expect(scopedAccountIdSet({ accountIds: ['chk'], entityId: null }, accounts)).toEqual(new Set(['chk']));
  });
});

describe('scopeRows', () => {
  const rows = [
    { accountId: 'chk', effectiveDate: '2026-07-01' },
    { accountId: 'chk', effectiveDate: '2026-06-30' },
    { accountId: 'biz', effectiveDate: '2026-07-02' },
  ];

  it('filters by both the day range and the account set', () => {
    expect(scopeRows(rows, { from: '2026-07-01', to: '2026-07-31' }, null)).toHaveLength(2);
    expect(
      scopeRows(rows, { from: '2026-06-01', to: '2026-07-31' }, new Set(['chk'])),
    ).toHaveLength(2);
    expect(scopeRows(rows, { from: '2026-07-01', to: '2026-07-31' }, new Set(['chk']))).toEqual([
      rows[0],
    ]);
  });

  it('range bounds are inclusive on both ends', () => {
    expect(scopeRows(rows, { from: '2026-06-30', to: '2026-07-01' }, null)).toHaveLength(2);
  });
});

describe('scopeMonths', () => {
  it('lists every month intersecting the range, partial months included', () => {
    expect(scopeMonths('2026-05-15', '2026-07-17')).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('a single-month range yields one key', () => {
    expect(scopeMonths('2026-07-01', '2026-07-17')).toEqual(['2026-07']);
  });

  it('crosses year boundaries and caps to the most recent N', () => {
    expect(scopeMonths('2025-11-01', '2026-02-28')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(scopeMonths('2024-01-01', '2026-07-17', 3)).toEqual(['2026-05', '2026-06', '2026-07']);
  });
});

describe('scopeMonthSpan', () => {
  it('matches scopeMonths length when the range is under the cap', () => {
    expect(scopeMonthSpan('2026-05-15', '2026-07-17')).toBe(3);
    expect(scopeMonthSpan('2026-07-01', '2026-07-17')).toBe(1);
  });

  it('reports the FULL span even when scopeMonths would cap it (review r3603814914)', () => {
    // 2024-01 through 2026-07 is 31 months — scopeMonths caps to the most
    // recent 12; this must still report all 31 so callers can disclose it.
    expect(scopeMonthSpan('2024-01-01', '2026-07-17')).toBe(31);
    expect(scopeMonths('2024-01-01', '2026-07-17')).toHaveLength(12);
  });
});

describe('clampMonthToRange', () => {
  it('a fully covered month keeps its own bounds', () => {
    expect(clampMonthToRange('2026-06', '2026-05-01', '2026-07-17')).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('partially covered months clamp to the scope edges', () => {
    expect(clampMonthToRange('2026-05', '2026-05-15', '2026-07-17')).toEqual({
      from: '2026-05-15',
      to: '2026-05-31',
    });
    expect(clampMonthToRange('2026-07', '2026-05-01', '2026-07-17')).toEqual({
      from: '2026-07-01',
      to: '2026-07-17',
    });
  });

  it('knows February and leap years (2028)', () => {
    expect(clampMonthToRange('2028-02', '2028-01-01', '2028-12-31')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });
});

describe('ledgerDrillHref', () => {
  const range = { from: '2026-05-01', to: '2026-07-17' };

  it('carries category, dates, and a single scoped account', () => {
    expect(
      ledgerDrillHref({ categoryId: 'cat-1', ...range, accountSet: new Set(['chk']) }),
    ).toBe('/dashboard/ledger?category=cat-1&from=2026-05-01&to=2026-07-17&account=chk');
  });

  it('null category means uncategorized; undefined means no category param', () => {
    expect(ledgerDrillHref({ categoryId: null, ...range, accountSet: null })).toBe(
      '/dashboard/ledger?category=uncategorized&from=2026-05-01&to=2026-07-17',
    );
    expect(ledgerDrillHref({ ...range, accountSet: null })).toBe(
      '/dashboard/ledger?from=2026-05-01&to=2026-07-17',
    );
  });

  it('omits the account param for multi-account scopes (ledger filter is single-select)', () => {
    expect(
      ledgerDrillHref({ categoryId: 'cat-1', ...range, accountSet: new Set(['chk', 'sav']) }),
    ).not.toContain('account=');
  });
});

describe('scopeLabel', () => {
  const scope = { from: '2026-05-01', to: '2026-07-17', entityId: null };

  it('unrestricted scope reads "All accounts"', () => {
    expect(scopeLabel({ scope, accountSet: null, totalAccounts: 5 })).toBe(
      'All accounts · 2026-05-01 – 2026-07-17',
    );
  });

  it('a full explicit selection still reads "All accounts"', () => {
    expect(
      scopeLabel({ scope, accountSet: new Set(['a', 'b']), totalAccounts: 2 }),
    ).toBe('All accounts · 2026-05-01 – 2026-07-17');
  });

  it('a subset counts honestly and an entity name leads', () => {
    expect(scopeLabel({ scope, accountSet: new Set(['a']), totalAccounts: 5 })).toBe(
      '1 of 5 accounts · 2026-05-01 – 2026-07-17',
    );
    expect(
      scopeLabel({
        scope: { ...scope, entityId: 'llc' },
        accountSet: new Set(['biz']),
        totalAccounts: 3,
        entityName: 'Acme LLC',
      }),
    ).toBe('Acme LLC · 1 of 3 accounts · 2026-05-01 – 2026-07-17');
  });

  it('an entity scope never collapses to "All accounts" even when sizes match', () => {
    // 3 household accounts, all 3 in the entity — the entity name + count must
    // stay explicit; "All accounts" would overstate the scope.
    expect(
      scopeLabel({
        scope: { ...scope, entityId: 'llc' },
        accountSet: new Set(['a', 'b', 'c']),
        totalAccounts: 3,
        entityName: 'Acme LLC',
      }),
    ).toBe('Acme LLC · 3 of 3 accounts · 2026-05-01 – 2026-07-17');
  });
});

describe('dominantCurrency', () => {
  it('picks the most frequent currency; falls back on empty', () => {
    expect(
      dominantCurrency([{ currency: 'USD' }, { currency: 'EUR' }, { currency: 'USD' }]),
    ).toBe('USD');
    expect(dominantCurrency([])).toBe('USD');
    expect(dominantCurrency([], 'EUR')).toBe('EUR');
  });
});
