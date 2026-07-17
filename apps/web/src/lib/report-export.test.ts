import { describe, expect, it } from 'vitest';

import { buildScopedTransactionsCsv, scopedExportFilename } from './report-export';
import type { RichTransactionRow } from './keel-api';

const GENERATED_AT = new Date('2026-07-17T19:30:00.000Z');

function row(overrides: Partial<RichTransactionRow> = {}): RichTransactionRow {
  return {
    transactionId: 'txn_1',
    effectiveDate: '2026-06-05',
    description: 'Coffee Shop',
    status: 'posted',
    accountId: 'acc_1',
    accountName: 'Checking',
    amountMinor: '-450',
    currency: 'USD',
    categoryLedgerAccountId: 'cat_1',
    categoryName: 'Dining',
    categoryKind: 'expense',
    ...overrides,
  };
}

describe('buildScopedTransactionsCsv', () => {
  it('states scope/as-of/generated-at in a leading comment block (Law 9)', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts · 2026-06-01 – 2026-06-30',
      asOf: '2026-07-17T18:00:00.000Z',
      generatedAt: GENERATED_AT,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('# KEEL Reports export — scope: All accounts · 2026-06-01 – 2026-06-30');
    expect(lines[1]).toBe('# Range: 2026-06-01 to 2026-06-30');
    expect(lines[2]).toBe('# Data as of: 2026-07-17T18:00:00.000Z');
    expect(lines[3]).toBe('# Generated: 2026-07-17T19:30:00.000Z');
    expect(lines[4]).toBe(
      '# 0 transactions. One row per transaction (splits shown in the Splits column, not counted as extra rows).',
    );
  });

  it('falls back to "unknown" when asOf is null', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    expect(csv).toContain('# Data as of: unknown');
  });

  it('emits one quoted, comma-joined header row matching the column set', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const header = csv.split('\r\n')[5];
    expect(header).toBe(
      [
        '"Date"',
        '"Description"',
        '"Account"',
        '"Amount"',
        '"Currency"',
        '"Category"',
        '"Category kind"',
        '"Status"',
        '"Tags"',
        '"Transfer status"',
        '"Counterparty account"',
        '"Note"',
        '"Splits"',
        '"Transaction ID"',
      ].join(','),
    );
  });

  it('renders one row per transaction with a plain decimal amount (no float parsing, Law 4)', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [row({ amountMinor: '-123456' })],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const dataLine = csv.split('\r\n')[6];
    expect(dataLine).toContain('"-1234.56"');
    // Sanity: BigInt-exact digit shifting, not a float round-trip artifact.
    expect(dataLine).not.toContain('1234.5599999');
  });

  it('sorts rows oldest-first by date, then transaction id', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [
        row({ transactionId: 'txn_b', effectiveDate: '2026-06-10', description: 'B' }),
        row({ transactionId: 'txn_a', effectiveDate: '2026-06-05', description: 'A' }),
        row({ transactionId: 'txn_c', effectiveDate: '2026-06-05', description: 'C' }),
      ],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const dataLines = csv.split('\r\n').slice(6, 9);
    expect(dataLines[0]).toContain('"A"');
    expect(dataLines[1]).toContain('"C"');
    expect(dataLines[2]).toContain('"B"');
  });

  it('discloses splits in their own column without adding extra rows (Law 3: no double-counting the cash amount)', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [
        row({
          amountMinor: '-10000',
          splits: [
            { categoryLedgerAccountId: 'cat_a', name: 'Groceries', kind: 'expense', amountMinor: '6000' },
            { categoryLedgerAccountId: 'cat_b', name: 'Household', kind: 'expense', amountMinor: '4000' },
          ],
        }),
      ],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const lines = csv.trim().split('\r\n');
    // Header (line 5) + exactly one data row.
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain('"Groceries: 60.00; Household: 40.00"');
    expect(lines[6]).toContain('"-100.00"');
  });

  it('neutralizes spreadsheet-formula-injection cells (Law 5: ingested text is data-tier)', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [row({ description: '=cmd|"/c calc"!A1', note: '+1+1', tags: [{ tagId: 't1', name: '@evil' }] })],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const dataLine = csv.split('\r\n')[6];
    expect(dataLine).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(dataLine).toContain(`"'+1+1"`);
    expect(dataLine).toContain(`"'@evil"`);
  });

  it('strips embedded CR/LF from scopeText in the metadata block so injected content cannot start a new CSV line (review r3604408469)', () => {
    // A user-created entity name can carry an embedded CR/LF; scopeText is
    // written into an UNQUOTED "#" comment line (no quotes to escape a
    // newline), so a raw CR/LF would start a new physical line that a
    // spreadsheet app still parses as a row of its own — and if THAT line
    // begins with a formula trigger, it becomes executable.
    const csv = buildScopedTransactionsCsv({
      rows: [row({})],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'Evil Corp\r\n=cmd|"/c calc"!A1 · All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const lines = csv.split('\r\n');
    // The embedded CR/LF is collapsed to a space — the injected text stays
    // INSIDE the single "#" comment line instead of starting a new one.
    expect(lines[0]).toBe('# KEEL Reports export — scope: Evil Corp =cmd|"/c calc"!A1 · All accounts');
    expect(lines[1]).toContain('# Range:');
  });

  it('neutralizes scopeText that itself starts with a formula trigger', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [row({})],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: '=cmd|"/c calc"!A1',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    expect(csv.split('\r\n')[0]).toBe(`# KEEL Reports export — scope: '=cmd|"/c calc"!A1`);
  });

  it('defaults missing category/tags/transfer/note/counterparty fields to blank cells, not "null"/"undefined"', () => {
    const csv = buildScopedTransactionsCsv({
      rows: [row({ categoryName: null, categoryKind: null })],
      scope: { from: '2026-06-01', to: '2026-06-30' },
      scopeText: 'All accounts',
      asOf: null,
      generatedAt: GENERATED_AT,
    });
    const dataLine = csv.split('\r\n')[6];
    expect(dataLine).not.toContain('null');
    expect(dataLine).not.toContain('undefined');
    expect(dataLine).toContain('"Uncategorized"');
  });
});

describe('scopedExportFilename', () => {
  it('is filesystem-safe (no colons) and carries the scope range', () => {
    const name = scopedExportFilename({ from: '2026-06-01', to: '2026-06-30' }, GENERATED_AT);
    expect(name).toBe('keel-reports-export_2026-06-01_to_2026-06-30_2026-07-17T19-30-00-000Z.csv');
    expect(name).not.toContain(':');
  });
});
