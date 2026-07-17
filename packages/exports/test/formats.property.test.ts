import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ExportSecretError,
  formatMinorUnits,
  fromJson,
  parseDecimalToMinor,
  toBeancount,
  toCsvFiles,
  toJson,
  toQif,
} from '../src/index.js';
import { withTable } from './fixtures.js';
import { ledgerSnapshot, revisedAndVoidedLedgerSnapshot } from './ledger-fixture.js';

const parseCsv = (csv: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted && char === '"' && csv[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && char === '\r' && csv[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += char;
    }
  }
  expect(quoted).toBe(false);
  return rows;
};

const qifAmounts = (qif: string): string[] => qif.split('\n')
  .filter((line) => /^T-?\d/u.test(line))
  .map((line) => line.slice(1));

const beancountAmounts = (beancount: string): Array<{ amount: string; currency: string }> =>
  beancount.split('\n').flatMap((line) => {
    const match = /^  \S+  (-?\d+(?:\.\d+)?) ([A-Z]{3})$/u.exec(line);
    return match ? [{ amount: match[1]!, currency: match[2]! }] : [];
  });

describe('ISO-4217 string scaling', () => {
  it.each([
    ['123', 'JPY', '123'],
    ['123', 'USD', '1.23'],
    ['-5', 'USD', '-0.05'],
    ['1234', 'KWD', '1.234'],
    ['1', 'BHD', '0.001'],
    ['0', 'USD', '0.00'],
  ])('formats %s %s as %s', (minor, currency, expected) => {
    expect(formatMinorUnits(minor, currency)).toBe(expected);
    expect(parseDecimalToMinor(expected, currency)).toBe(minor);
  });

  it('rejects an unknown currency or malformed integer/decimal', () => {
    expect(() => formatMinorUnits('1', 'ZZZ')).toThrow('Unsupported ISO-4217 currency');
    expect(() => formatMinorUnits('1.2', 'USD')).toThrow('decimal integer string');
    expect(() => parseDecimalToMinor('1.234', 'USD')).toThrow('currency exponent');
  });
});

describe('CSV export', () => {
  it('is RFC-4180 parseable, canonicalizes JSON cells, and neutralizes formula prefixes', () => {
    const exportValue = withTable('import_rows', [{
      id: 'row',
      import_batch_id: 'batch',
      row_number: 1,
      raw: { z: 2, a: '=cmd()' },
      created_at: '2026-07-12T12:00:00Z',
    }]);
    const files = toCsvFiles(exportValue);
    expect(files).toHaveLength(68);
    const parsed = parseCsv(files.find((file) => file.name === 'import_rows.csv')!.csv);
    expect(parsed[0]).toEqual(['id', 'import_batch_id', 'row_number', 'raw', 'created_at']);
    expect(parsed[1]![3]).toBe('{"a":"=cmd()","z":2}');

    const dangerous = toCsvFiles(withTable('canonical_transactions', [
      { id: '1', description: '=cmd()' },
      { id: '2', description: '+SUM(A1)' },
      { id: '3', description: '-10+20' },
      { id: '4', description: '@evil' },
      { id: '5', description: '\tformula' },
      { id: '6', description: '\rformula' },
    ])).find((file) => file.name === 'canonical_transactions.csv')!;
    const descriptionIndex = parseCsv(dangerous.csv)[0]!.indexOf('description');
    for (const row of parseCsv(dangerous.csv).slice(1)) {
      expect(row[descriptionIndex]?.startsWith("'")).toBe(true);
    }
  });
});

describe('QIF and beancount', () => {
  it('emits parseable exact asset-side QIF and balanced double-entry beancount', () => {
    const fixture = ledgerSnapshot();
    const qif = toQif(fixture);
    expect(qif).toContain('!Account\nNCash Account\nTBank\n^');
    expect(qif).toContain('D07/12/2026');
    expect(qifAmounts(qif)).toEqual(['90000000000000000.00']);
    expect(parseDecimalToMinor(qifAmounts(qif)[0]!, 'USD')).toBe('9000000000000000000');

    const beancount = toBeancount(fixture);
    expect(beancount).toContain('1970-01-01 open Assets:Cash-Main-Idasset USD');
    expect(beancount).toContain('2026-07-12 * "Payroll \\"quoted\\" line"');
    const postings = beancountAmounts(beancount);
    expect(postings).toHaveLength(2);
    expect(postings.map((posting) => parseDecimalToMinor(posting.amount, posting.currency)))
      .toEqual(['9000000000000000000', '-9000000000000000000']);
    expect(postings.reduce((sum, posting) =>
      sum + BigInt(parseDecimalToMinor(posting.amount, posting.currency)), 0n)).toBe(0n);
  });

  it('emits only the current live batch after a revision and nothing for a void', () => {
    const fixture = revisedAndVoidedLedgerSnapshot();
    const qif = toQif(fixture);
    expect(qifAmounts(qif)).toEqual(['0.70']);
    expect(qifAmounts(qif).map((amount) => parseDecimalToMinor(amount, 'USD')))
      .toEqual([fixture.trialBalance?.find((row) => row.ledgerAccountId === 'asset')?.balanceMinor]);

    const beancount = toBeancount(fixture);
    expect(beancount).toContain('Current replacement');
    expect(beancount).not.toContain('Superseded original');
    expect(beancount).not.toContain('Voided original');
    expect(beancountAmounts(beancount)
      .map((posting) => parseDecimalToMinor(posting.amount, posting.currency))
      .sort())
      .toEqual((fixture.trialBalance ?? []).map((row) => row.balanceMinor).sort());
  });

  it('rejects an unbalanced batch and scans all source values before every format', () => {
    const unbalanced = ledgerSnapshot('10');
    const badTables = {
      ...unbalanced.tables,
      journal_postings: [unbalanced.tables.journal_postings[0]!],
    };
    expect(() => toBeancount({ ...unbalanced, tables: badTables })).toThrow('does not balance');

    const secret = withTable('import_rows', [{ id: 'x', raw: { access_token: 'canary' } }]);
    for (const formatter of [toJson, toCsvFiles, toQif, toBeancount]) {
      expect(() => formatter(secret)).toThrow(ExportSecretError);
    }
  });
});

describe('large bigint format property', () => {
  it('round-trips values above 2^53 through JSON, CSV, QIF, and beancount exactly', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 9007199254740993n, max: 9000000000000000000n }),
      (amount) => {
        const text = amount.toString();
        const fixture = ledgerSnapshot(text);
        const parsed = fromJson(toJson(fixture));
        expect(parsed.tables.journal_postings[0]?.amount_minor).toBe(text);

        const csv = toCsvFiles(fixture).find((file) => file.name === 'journal_postings.csv')!;
        const rows = parseCsv(csv.csv);
        const amountIndex = rows[0]!.indexOf('amount_minor');
        expect(rows[1]![amountIndex]).toBe(text);

        const qifAmount = qifAmounts(toQif(fixture))[0]!;
        expect(parseDecimalToMinor(qifAmount, 'USD')).toBe(text);

        const bean = beancountAmounts(toBeancount(fixture));
        expect(parseDecimalToMinor(bean[0]!.amount, 'USD')).toBe(text);
        expect(parseDecimalToMinor(bean[1]!.amount, 'USD')).toBe(`-${text}`);
      },
    ), { numRuns: 25 });
  });
});
