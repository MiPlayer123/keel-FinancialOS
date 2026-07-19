/**
 * CSV statement parser tests (Law 1 deterministic, Law 4 no-floats string math,
 * Law 5 inert data). Covers the header-alias matrix, debit/credit split,
 * parenthesized negatives, `$1,234.56`→123456 string-math identity (property:
 * parse∘format round-trips and no float ever enters the value path), RFC-4180
 * quoting, BOM, the >5000-row reject, and hostile input → null/never-throw.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_CSV_ROWS,
  decodeCsvBytes,
  parseCsvStatement,
  tokenizeCsv,
  parseMoneyToMinor,
  formatMinorToDecimal,
} from '../src/statement/index.js';
import {
  CSV_BOM,
  CSV_DEBIT_CREDIT,
  CSV_HOSTILE_HEADERS,
  CSV_HOSTILE_MONEY,
  CSV_NOT_TABULAR,
  CSV_RFC4180,
  CSV_SIMPLE,
  GARBAGE,
  RED_TEAM_STRINGS,
  csvWithRedTeamDescriptions,
} from './fixtures/statement-cases.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('money string-math (Law 4: no floats)', () => {
  it('parses $1,234.56 to 123456 with no float in the path', () => {
    const r = parseMoneyToMinor('$1,234.56');
    expect(r.ok && r.minor).toBe('123456');
  });

  it('parenthesized negative ($10.00) → -1000', () => {
    const r = parseMoneyToMinor('($10.00)');
    expect(r.ok && r.minor).toBe('-1000');
  });

  it('trailing-minus 10.00- → -1000', () => {
    const r = parseMoneyToMinor('10.00-');
    expect(r.ok && r.minor).toBe('-1000');
  });

  it('truncates over-precision toward zero (never rounds)', () => {
    expect(parseMoneyToMinor('1.239')).toEqual({ ok: true, minor: '123' });
  });

  it('pads short fractions', () => {
    expect(parseMoneyToMinor('1.2')).toEqual({ ok: true, minor: '120' });
    expect(parseMoneyToMinor('5')).toEqual({ ok: true, minor: '500' });
  });

  it('handles JPY scale 0', () => {
    expect(parseMoneyToMinor('1234', 0)).toEqual({ ok: true, minor: '1234' });
    expect(parseMoneyToMinor('1234.99', 0)).toEqual({ ok: true, minor: '1234' });
  });

  it('a parenthesized zero is 0, not "-0"', () => {
    expect(parseMoneyToMinor('($0.00)')).toEqual({ ok: true, minor: '0' });
    expect(parseMoneyToMinor('.', 0)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('surfaces the empty-cell reason distinctly', () => {
    expect(parseMoneyToMinor('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('honors an explicit leading + sign', () => {
    expect(parseMoneyToMinor('+5.00')).toEqual({ ok: true, minor: '500' });
  });

  it('.5 truncated to scale 0 leaves nothing → unparseable', () => {
    expect(parseMoneyToMinor('.5', 0)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('formats a negative scale-0 value', () => {
    expect(formatMinorToDecimal('-5', 0)).toBe('-5');
  });

  it('rejects hostile / non-numeric cells to a typed failure (never throws)', () => {
    for (const bad of ['=cmd', '@SUM(A1)', 'abc', '1.2.3', '', '   ', '$', '()', '.', RED_TEAM_STRINGS[0]!]) {
      const r = parseMoneyToMinor(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('formatMinorToDecimal round-trips and rejects garbage', () => {
    expect(formatMinorToDecimal('123456')).toBe('1234.56');
    expect(formatMinorToDecimal('-1000')).toBe('-10.00');
    expect(formatMinorToDecimal('5', 0)).toBe('5');
    expect(formatMinorToDecimal('12', 2)).toBe('0.12');
    expect(formatMinorToDecimal('not-a-number')).toBeNull();
  });

  it('property: parse∘format is identity for random cents, no NaN/float leak', () => {
    fc.assert(
      fc.property(fc.integer({ min: -99_999_999, max: 99_999_999 }), (cents) => {
        const minor = String(cents);
        const decimal = formatMinorToDecimal(minor, 2)!;
        // the decimal string must contain exactly one '.' and 2 fraction digits
        expect(/^-?\d+\.\d{2}$/.test(decimal)).toBe(true);
        const back = parseMoneyToMinor(decimal, 2);
        expect(back.ok && back.minor).toBe(minor === '-0' ? '0' : minor);
      }),
    );
  });
});

describe('RFC-4180 tokenizer', () => {
  it('handles embedded comma, newline, doubled quote, BOM', () => {
    const rows = tokenizeCsv(decodeCsvBytes(CSV_RFC4180));
    expect(rows[1]![1]!.value).toBe('Store, with comma');
    expect(rows[2]![1]!.value).toBe('Line one\nline two');
    expect(rows[3]![1]!.value).toBe('He said "hi"');
  });

  it('strips a UTF-8 BOM', () => {
    const text = decodeCsvBytes(CSV_BOM);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith('Date')).toBe(true);
    // and a full parse through the BOM path succeeds
    const rec = parseCsvStatement(CSV_BOM);
    expect(rec.lines[0]!.amountMinor).toBe('-900');
    // decoding non-BOM bytes leaves them intact (ternary false side)
    expect(decodeCsvBytes(new TextEncoder().encode('X'))).toBe('X');
  });

  it('assigns byte offsets to cells', () => {
    const rows = tokenizeCsv('a,b\n12,34');
    expect(rows[1]![0]!.byteOffset).toBe(4); // "a,b\n" = 4 bytes
    expect(rows[1]![1]!.byteOffset).toBe(7);
  });

  it('handles CRLF line endings', () => {
    const rows = tokenizeCsv('Date,Amount\r\n2026-07-01,-5.00\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]!.value).toBe('-5.00');
  });

  it('parses a trailing row with no final newline', () => {
    const rows = tokenizeCsv('a,b\nc,d');
    expect(rows).toHaveLength(2);
    expect(rows[1]![1]!.value).toBe('d');
  });
});

describe('header-alias matrix', () => {
  const cases: Array<[string, string]> = [
    ['Date,Amount,Description', 'date/amount/description'],
    ['Posted,Amount,Memo', 'posted/amount/memo'],
    ['Transaction Date,Amt,Payee', 'transaction date/amt/payee'],
    ['Post Date,Transaction Amount,Narrative', 'post date/txn amount/narrative'],
  ];
  it.each(cases)('resolves header row %s', (header) => {
    const bytes = enc(`${header}\n2026-07-01,-5.00,thing`);
    const rec = parseCsvStatement(bytes);
    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0]!.amountMinor).toBe('-500');
    expect(rec.lines[0]!.lineDate).toBe('2026-07-01');
    expect(rec.lines[0]!.descriptionRaw).toBe('thing');
  });
});

describe('debit/credit split', () => {
  it('debit is outflow (negative), credit is inflow (positive)', () => {
    const rec = parseCsvStatement(CSV_DEBIT_CREDIT);
    expect(rec.lines).toHaveLength(3);
    // $1,234.56 debit → negative
    expect(rec.lines[0]!.amountMinor).toBe('-123456');
    // $2,000.00 credit → positive
    expect(rec.lines[1]!.amountMinor).toBe('200000');
    // ($10.00) debit already parenthesized-negative, still negative
    expect(rec.lines[2]!.amountMinor).toBe('-1000');
  });

  it('records provenance row/col/byte-offset for the money cell', () => {
    const rec = parseCsvStatement(CSV_DEBIT_CREDIT);
    const p = rec.lines[0]!.provenance.amountMinor;
    expect(p.src_row).toBe(1);
    expect(p.src_col).toBe(2); // Debit column index
    expect(typeof p.src_byte_offset).toBe('number');
  });

  it('both debit and credit filled → ambiguous inert null', () => {
    const bytes = enc('Date,Debit,Credit\n2026-07-01,5.00,6.00');
    const rec = parseCsvStatement(bytes);
    expect(rec.lines[0]!.amountMinor).toBeNull();
    expect(rec.lines[0]!.provenance.amountMinor.null_reason).toBe('ambiguous');
  });

  it('neither debit nor credit → absent inert null', () => {
    const rec = parseCsvStatement(enc('Date,Debit,Credit\n2026-07-01,,'));
    expect(rec.lines[0]!.amountMinor).toBeNull();
    expect(rec.lines[0]!.provenance.amountMinor.null_reason).toBe('absent');
  });

  it('a $0.00 debit stays 0 (never "-0")', () => {
    const rec = parseCsvStatement(enc('Date,Debit,Credit\n2026-07-01,$0.00,'));
    expect(rec.lines[0]!.amountMinor).toBe('0');
  });

  it('an accounting-negative ($5.00) debit is still an outflow -500', () => {
    const rec = parseCsvStatement(enc('Date,Debit,Credit\n2026-07-01,($5.00),'));
    expect(rec.lines[0]!.amountMinor).toBe('-500');
  });

  it('a malformed debit cell → inert null with unparseable reason', () => {
    const rec = parseCsvStatement(enc('Date,Debit,Credit\n2026-07-01,=cmd,'));
    expect(rec.lines[0]!.amountMinor).toBeNull();
    expect(rec.lines[0]!.provenance.amountMinor.null_reason).toBe('unparseable');
  });
});

describe('date parsing + range', () => {
  it('rejects an impossible date (2026-13-40) to null, unparseable reason', () => {
    const rec = parseCsvStatement(enc('Date,Amount\n2026-13-40,-1.00'));
    expect(rec.lines[0]!.lineDate).toBeNull();
    expect(rec.lines[0]!.provenance.lineDate.null_reason).toBe('unparseable');
    expect(rec.periodStart).toBeNull();
  });

  it('derives min/max period from out-of-order dates', () => {
    const rec = parseCsvStatement(
      enc('Date,Amount\n2026-07-15,-1.00\n2026-07-02,-1.00\n2026-07-28,-1.00'),
    );
    expect(rec.periodStart).toBe('2026-07-02');
    expect(rec.periodEnd).toBe('2026-07-28');
  });

  it('accepts US MM/DD/YYYY and rejects a bad month there too', () => {
    expect(parseCsvStatement(enc('Date,Amount\n07/04/2026,-1.00')).lines[0]!.lineDate).toBe(
      '2026-07-04',
    );
    expect(parseCsvStatement(enc('Date,Amount\n13/40/2026,-1.00')).lines[0]!.lineDate).toBeNull();
  });

  it('a missing date column marks lineDate absent (not unparseable)', () => {
    const rec = parseCsvStatement(enc('Amount,Description\n-1.00,x'));
    expect(rec.lines[0]!.lineDate).toBeNull();
    expect(rec.lines[0]!.provenance.lineDate.null_reason).toBe('absent');
  });
});

describe('period + balances', () => {
  it('derives period from min/max line date; balances null when absent', () => {
    const rec = parseCsvStatement(CSV_SIMPLE);
    expect(rec.periodStart).toBe('2026-07-01');
    expect(rec.periodEnd).toBe('2026-07-03');
    expect(rec.openingMinor).toBeNull();
    expect(rec.endingMinor).toBeNull();
    expect(rec.provenance.openingMinor.null_reason).toBe('absent');
  });

  it('applies the account currency when provided', () => {
    const rec = parseCsvStatement(CSV_SIMPLE, { currency: 'eur' });
    expect(rec.currency).toBe('EUR');
    expect(rec.lines[0]!.currency).toBe('EUR');
  });

  it('ignores an invalid currency hint', () => {
    const rec = parseCsvStatement(CSV_SIMPLE, { currency: 'US' });
    expect(rec.currency).toBeNull();
  });
});

describe('row cap (§6 [A9])', () => {
  it('rejects >5000 rows BEFORE building the line array', () => {
    const header = 'Date,Amount,Description\n';
    const row = '2026-07-01,-1.00,x\n';
    const bytes = enc(header + row.repeat(MAX_CSV_ROWS + 1));
    const rec = parseCsvStatement(bytes);
    expect(rec.lines).toHaveLength(0);
    expect(rec.rawEvidence['rejected']).toBe('row_cap_exceeded');
    expect(rec.provenance.currency.null_reason).toBe('truncated');
  });

  it('accepts exactly 5000 rows', () => {
    const header = 'Date,Amount,Description\n';
    const row = '2026-07-01,-1.00,x\n';
    const bytes = enc(header + row.repeat(MAX_CSV_ROWS));
    const rec = parseCsvStatement(bytes);
    expect(rec.lines).toHaveLength(MAX_CSV_ROWS);
  });
});

describe('malformed / hostile input never throws (Law 5)', () => {
  it('garbage bytes → inert record, no throw', () => {
    expect(() => parseCsvStatement(GARBAGE)).not.toThrow();
    const rec = parseCsvStatement(GARBAGE);
    expect(rec.extractor).toBe('csv');
  });

  it('empty file → inert record', () => {
    const rec = parseCsvStatement(new Uint8Array());
    expect(rec.rawEvidence['error']).toBe('empty_file');
    expect(rec.lines).toHaveLength(0);
  });

  it('non-tabular .csv → inert, no throw', () => {
    expect(() => parseCsvStatement(CSV_NOT_TABULAR)).not.toThrow();
  });
});

describe('red-team: formula injection + RED_TEAM_STRINGS stored verbatim inert (Law 5)', () => {
  it('formula-injection headers do not execute; hostile description stored verbatim', () => {
    const rec = parseCsvStatement(CSV_HOSTILE_HEADERS);
    // The row's description is the first red-team string, stored EXACTLY.
    expect(rec.lines[0]!.descriptionRaw).toBe(RED_TEAM_STRINGS[0]);
    // rawEvidence retains the raw header verbatim (inert jsonb).
    expect(rec.rawEvidence['rawHeader']).toEqual([
      '=cmd|/c calc',
      '@SUM(A1:A9)',
      'Amount',
      'Description',
    ]);
  });

  it('debit/credit columns carrying payloads → inert null money, verbatim description', () => {
    const rec = parseCsvStatement(CSV_HOSTILE_MONEY);
    expect(rec.lines[0]!.amountMinor).toBeNull();
    expect(rec.lines[0]!.descriptionRaw).toBe(RED_TEAM_STRINGS[3]);
    expect(rec.lines[1]!.descriptionRaw).toBe(RED_TEAM_STRINGS[8]);
  });

  it('every RED_TEAM_STRING survives verbatim as an inert description', () => {
    const rec = parseCsvStatement(csvWithRedTeamDescriptions());
    RED_TEAM_STRINGS.forEach((s, i) => {
      // newlines were flattened to spaces in the fixture builder
      const expected = s.replace(/\n/g, ' ');
      expect(rec.lines[i]!.descriptionRaw).toBe(expected);
    });
  });
});

describe('fuzz: arbitrary bytes never throw and never leak a float amount', () => {
  it('property over random CSV-ish strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const rec = parseCsvStatement(enc(`Date,Amount,Description\n${s}`));
        for (const line of rec.lines) {
          if (line.amountMinor !== null) {
            expect(/^-?\d+$/.test(line.amountMinor)).toBe(true); // integer string only
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
