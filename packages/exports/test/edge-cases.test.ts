import { describe, expect, it } from 'vitest';
import {
  canonicalStringify,
  formatMinorUnits,
  fromJson,
  parseDecimalToMinor,
  reconstructTrialBalance,
  toBeancount,
  toJson,
  toQif,
  utf8ByteLength,
  type ExportTables,
  type HouseholdExport,
} from '../src/index.js';
import { emptyTables, snapshot, withTable } from './fixtures.js';
import { ledgerSnapshot } from './ledger-fixture.js';

describe('canonical defensive cases', () => {
  it('uses JSON semantics for non-finite numbers and undefined object members', () => {
    expect(canonicalStringify({ finite: 1, nan: Number.NaN, infinite: Infinity, omit: undefined }))
      .toBe('{"finite":1,"infinite":null,"nan":null}');
    expect(() => canonicalStringify(undefined)).toThrow('Unsupported canonical JSON value');
    expect(() => canonicalStringify(() => 1)).toThrow('Unsupported canonical JSON value');
  });

  it('rejects invalid timestamps and any numeric or malformed BIGINT', () => {
    expect(() => toJson(snapshot({ asOf: 'not-a-date' }))).toThrow('Invalid timestamp');
    expect(() => toJson(snapshot({ asOf: 1 as unknown as string }))).toThrow('Invalid timestamp');
    expect(() => toJson(withTable('audit_log', [{ id: 9007199254740992 }]))).toThrow(
      'must be a decimal string',
    );
    expect(() => toJson(withTable('audit_log', [{ id: '12x' }]))).toThrow(
      'must be a decimal string',
    );
  });

  it('accepts nullable/bigint DTO values and deterministically orders null, equal, and absent keys', () => {
    const tables = {
      ...emptyTables(),
      households: [
        { id: 'same', name: 'b', created_at: null },
        { id: 'same', name: 'a', created_at: null },
        { id: null, name: 'null', created_at: null },
        { name: 'absent', created_at: null },
      ],
      audit_log: [
        { id: 5n, at: null },
        { id: null, at: null },
      ],
      balance_snapshots: [{ id: 'b', available_minor: null, current_minor: '0' }],
    } as unknown as ExportTables;
    const withoutTrialBalance: HouseholdExport = {
      householdId: 'hh',
      asOf: '2026-07-12T12:00:00Z',
      tables,
    };
    const parsed = JSON.parse(toJson(withoutTrialBalance));
    expect(parsed.tables.audit_log.map((row: { id?: string | null }) => row.id)).toEqual([
      null,
      '5',
    ]);
    expect(parsed.tables.households.map((row: { name: string }) => row.name)).toEqual([
      'absent',
      'null',
      'a',
      'b',
    ]);
    expect(parsed.trialBalance).toEqual([]);

    const definedAfterNull = JSON.parse(toJson(withTable('households', [
      { id: null, created_at: null },
      { id: 'x', created_at: null },
    ])));
    expect(definedAfterNull.tables.households.map((row: { id: string | null }) => row.id))
      .toEqual([null, 'x']);

    const descendingBigints = JSON.parse(toJson(withTable('audit_log', [
      { id: '1', at: null },
      { id: '2', at: null },
    ])));
    expect(descendingBigints.tables.audit_log.map((row: { id: string }) => row.id))
      .toEqual(['1', '2']);
  });

  it('sorts trial-balance currencies and handles a deliberately missing table array', () => {
    const tables = { ...emptyTables() } as Record<string, unknown>;
    delete tables['households'];
    const parsed = JSON.parse(toJson(snapshot({
      tables: tables as unknown as ExportTables,
      trialBalance: [
        { ledgerAccountId: 'a', currency: 'USD', balanceMinor: '1' },
        { ledgerAccountId: 'a', currency: 'JPY', balanceMinor: '1' },
      ],
    })));
    expect(parsed.tables.households).toEqual([]);
    expect(parsed.trialBalance.map((row: { currency: string }) => row.currency))
      .toEqual(['JPY', 'USD']);
  });

  it.each([
    '{}',
    '{"asOf":"2026-01-01T00:00:00Z"}',
    '{"asOf":"2026-01-01T00:00:00Z","scope":{"householdId":"hh"}}',
  ])('rejects malformed JSON export envelope %s', (json) => {
    expect(() => fromJson(json)).toThrow('Invalid KEEL JSON export envelope');
  });

  it('parses a valid envelope without an optional trial balance', () => {
    expect(fromJson(JSON.stringify({
      asOf: '2026-01-01T00:00:00Z',
      scope: { householdId: 'hh' },
      tables: emptyTables(),
    })).trialBalance).toEqual([]);
  });
});

describe('currency and UTF-8 defensive cases', () => {
  it('normalizes leading and negative zeroes and accepts bigint input', () => {
    expect(formatMinorUnits(5n, 'USD')).toBe('0.05');
    expect(formatMinorUnits('0005', 'USD')).toBe('0.05');
    expect(formatMinorUnits('-000', 'JPY')).toBe('0');
    expect(parseDecimalToMinor('0001.00', 'USD')).toBe('100');
    expect(() => parseDecimalToMinor('1.0', 'JPY')).toThrow('currency exponent');
    expect(utf8ByteLength('aé€😀')).toBe(10);
  });
});

describe('QIF defensive and split cases', () => {
  it('returns empty for no asset account and skips non-asset/mismatched/reversal/no-posting rows', () => {
    expect(toQif(snapshot())).toBe('');
    const base = ledgerSnapshot('10');
    const tables = {
      ...base.tables,
      ledger_accounts: [
        ...base.tables.ledger_accounts,
        { id: 'liability', household_id: 'hh', entity_id: 'entity', name: 'Card', kind: 'liability', currency: 'USD', is_category: false, created_at: '2026-01-01T00:00:00Z', archived_at: null },
      ],
      accounts: [
        ...base.tables.accounts,
        { ...base.tables.accounts[0]!, id: 'card', ledger_account_id: 'liability' },
      ],
      canonical_transactions: [
        ...base.tables.canonical_transactions,
        { ...base.tables.canonical_transactions[0]!, id: 'other', account_id: 'other-account' },
        { ...base.tables.canonical_transactions[0]!, id: 'no-batch' },
        { ...base.tables.canonical_transactions[0]!, id: 'truly-no-batch' },
      ],
      journal_batches: [
        ...base.tables.journal_batches,
        { ...base.tables.journal_batches[0]!, id: 'reversal', reverses_batch_id: 'batch' },
        { ...base.tables.journal_batches[0]!, id: 'no-postings', canonical_transaction_id: 'no-batch' },
        { ...base.tables.journal_batches[0]!, id: 'no-transaction', canonical_transaction_id: null },
      ],
    } as ExportTables;
    expect(toQif({ ...base, tables })).toContain('T0.10');
  });

  it('emits Split for multiple offsets and ignores a zero asset aggregate', () => {
    const base = ledgerSnapshot('10');
    const tables = {
      ...base.tables,
      journal_postings: [
        base.tables.journal_postings[0]!,
        { ...base.tables.journal_postings[1]!, id: 'offset-1', amount_minor: '-5' },
        { ...base.tables.journal_postings[1]!, id: 'offset-2', amount_minor: '-5' },
      ],
    } as ExportTables;
    expect(toQif({ ...base, tables })).toContain('LSplit');

    const zeroTables = {
      ...tables,
      journal_postings: [
        { ...base.tables.journal_postings[0]!, amount_minor: '10' },
        { ...base.tables.journal_postings[0]!, id: 'asset-negative', amount_minor: '-10' },
        { ...base.tables.journal_postings[1]!, amount_minor: '5' },
        { ...base.tables.journal_postings[1]!, id: 'income-negative', amount_minor: '-5' },
      ],
    } as ExportTables;
    expect(toQif({ ...base, tables: zeroTables })).not.toContain('D07/12/2026');
  });

  it('rejects malformed required strings and dates', () => {
    const base = ledgerSnapshot('10');
    expect(() => toQif({
      ...base,
      tables: { ...base.tables, accounts: [{ ...base.tables.accounts[0]!, ledger_account_id: 1 }] } as ExportTables,
    })).toThrow('Expected string ledger_account_id');
    expect(() => toQif({
      ...base,
      tables: {
        ...base.tables,
        canonical_transactions: [{ ...base.tables.canonical_transactions[0]!, effective_date: 'bad' }],
      } as ExportTables,
    })).toThrow('QIF effective date');
  });
});

describe('beancount defensive cases', () => {
  it('returns empty without accounts/batches and handles empty/digit account components', () => {
    expect(toBeancount(snapshot())).toBe('');
    const base = ledgerSnapshot('10');
    const tables = {
      ...base.tables,
      ledger_accounts: base.tables.ledger_accounts.map((row, index) => ({
        ...row,
        id: index === 0 ? '---' : row['id'],
        name: index === 0 ? '123 cash' : '!!!',
      })),
      accounts: [{ ...base.tables.accounts[0]!, ledger_account_id: '---' }],
      journal_postings: base.tables.journal_postings.map((row) =>
        row['ledger_account_id'] === 'asset' ? { ...row, ledger_account_id: '---' } : row),
    } as ExportTables;
    const bean = toBeancount({ ...base, tables });
    expect(bean).toContain('Assets:Account-123-Cash-IdRow');
    expect(bean).toContain('Income:Account-Idincome');
  });

  it('rejects a batch with no postings', () => {
    const base = ledgerSnapshot('10');
    expect(() => toBeancount({
      ...base,
      tables: { ...base.tables, journal_postings: [] } as unknown as ExportTables,
    })).toThrow('does not balance');
  });

  it('rejects unknown kinds, missing text, two-posting imbalance, and missing ledger accounts', () => {
    const base = ledgerSnapshot('10');
    expect(() => toBeancount({
      ...base,
      tables: {
        ...base.tables,
        ledger_accounts: [{ ...base.tables.ledger_accounts[0]!, kind: 'unknown' }],
      } as ExportTables,
    })).toThrow('Unsupported ledger account kind');
    expect(() => toBeancount({
      ...base,
      tables: {
        ...base.tables,
        ledger_accounts: [{ ...base.tables.ledger_accounts[0]!, id: 1 }],
      } as ExportTables,
    })).toThrow('Expected string id');
    expect(() => toBeancount({
      ...base,
      tables: {
        ...base.tables,
        journal_postings: [
          base.tables.journal_postings[0]!,
          { ...base.tables.journal_postings[1]!, amount_minor: '-9' },
        ],
      } as ExportTables,
    })).toThrow('does not balance');
    expect(() => toBeancount({
      ...base,
      tables: {
        ...base.tables,
        journal_postings: base.tables.journal_postings.map((row) => ({
          ...row,
          ledger_account_id: 'missing',
        })),
      } as ExportTables,
    })).toThrow('Missing ledger account');
  });
});

describe('reconstruction rejects malformed wire rows', () => {
  it.each([
    { ledger_account_id: 1, currency: 'USD', amount_minor: '1' },
    { ledger_account_id: 'a', currency: 1, amount_minor: '1' },
    { ledger_account_id: 'a', currency: 'USD', amount_minor: 1 },
    { ledger_account_id: 'a', currency: 'USD', amount_minor: '1.2' },
  ])('rejects $ledger_account_id/$currency/$amount_minor', (posting) => {
    expect(() => reconstructTrialBalance({
      ...snapshot(),
      tables: { ...emptyTables(), journal_postings: [posting] } as ExportTables,
    })).toThrow('Invalid exported journal posting');
  });

  it('accumulates duplicate account/currency rows and sorts currencies', () => {
    const restored = reconstructTrialBalance({
      ...snapshot(),
      tables: {
        ...emptyTables(),
        journal_postings: [
          { ledger_account_id: 'a', currency: 'USD', amount_minor: '1' },
          { ledger_account_id: 'a', currency: 'USD', amount_minor: '2' },
          { ledger_account_id: 'a', currency: 'JPY', amount_minor: '3' },
        ],
      } as ExportTables,
    });
    expect(restored).toEqual([
      { ledgerAccountId: 'a', currency: 'JPY', balanceMinor: '3' },
      { ledgerAccountId: 'a', currency: 'USD', balanceMinor: '3' },
    ]);
  });
});
