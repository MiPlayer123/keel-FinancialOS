/**
 * RFC-4180 CSV statement parser (Law 1: deterministic; Law 4: money via string
 * math, no floats; Law 5: all cell text is inert data — the parser can only
 * ever store it, never act on it). Input is ONLY `Uint8Array` bytes (decoded
 * UTF-8, BOM-stripped); this module imports no network, Supabase, or fetch.
 *
 * Pipeline: tokenize per RFC-4180 (quotes, embedded commas/newlines, doubled
 * quotes, CRLF/LF) → map header aliases (Date/Posted/Transaction Date; a single
 * Amount OR a Debit+Credit split; Description/Memo/Payee) → per row convert the
 * money cell to minor units by STRING MATH → attach row/col/byte-offset
 * provenance → derive period from min/max line date; balances stay null when the
 * source has no balance columns (a CSV of transactions rarely carries them).
 *
 * Row cap: >5000 data rows are REJECTED before any line array is built (a
 * resource guard, and the same 5000 cap the staging migration enforces). A
 * malformed file returns an inert extraction with null fields + null_reason,
 * never a thrown exception. Pure: no I/O, no Supabase, no model.
 */
import {
  emptyStatementFields,
  provenance,
  STATEMENT_PARSER_VERSION,
  type FieldProvenance,
  type NullReason,
  type StatementExtractionRecord,
  type StatementLineRecord,
} from './types.js';
import { currencyScale, parseMoneyToMinor } from './money.js';

/** Hard cap on data rows; rejected before building the line array (§6, [A9]). */
export const MAX_CSV_ROWS = 5000;

/** A tokenized cell with the byte offset where it began in the original file. */
interface Cell {
  readonly value: string;
  readonly byteOffset: number;
}

/** UTF-8 byte length of a JS string (for byte-offset provenance). */
const utf8Len = (s: string): number => {
  // TextEncoder is a pure ECMAScript/WHATWG built-in (no network); fine here.
  return new TextEncoder().encode(s).length;
};

/**
 * RFC-4180 tokenizer. Returns rows of cells, each cell tagged with its starting
 * byte offset in the decoded (BOM-stripped) text. Handles quoted fields with
 * embedded commas, embedded newlines, and doubled quotes (`""` → `"`). Tolerant
 * of both CRLF and LF line endings. Never throws.
 */
export const tokenizeCsv = (text: string): Cell[][] => {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let inQuotes = false;
  let cellStartByte = 0;
  let byte = 0; // running UTF-8 byte offset of the char about to be read
  let cellHasContent = false; // did we start a cell at this position?

  const startCellIfNeeded = (): void => {
    if (!cellHasContent) {
      cellStartByte = byte;
      cellHasContent = true;
    }
  };
  const pushCell = (): void => {
    row.push({ value: field, byteOffset: cellStartByte });
    field = '';
    cellHasContent = false;
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };

  // A pending quote inside a quoted field: we saw a '"' and must look at the
  // next char to decide escaped-quote ("") vs field-close. `for...of` iterates
  // by code point, so multi-byte characters stay intact.
  let pendingQuote = false;

  for (const ch of text) {
    const chBytes = utf8Len(ch);
    if (pendingQuote) {
      pendingQuote = false;
      if (ch === '"') {
        field += '"'; // escaped quote
        byte += chBytes;
        continue;
      }
      inQuotes = false; // the pending quote closed the field; fall through
    }
    if (inQuotes) {
      if (ch === '"') {
        pendingQuote = true;
        byte += chBytes;
        continue;
      }
      field += ch;
      byte += chBytes;
      continue;
    }
    // not in quotes
    if (ch === '"') {
      startCellIfNeeded();
      inQuotes = true;
      byte += chBytes;
      continue;
    }
    if (ch === ',') {
      startCellIfNeeded();
      pushCell();
      byte += chBytes;
      continue;
    }
    if (ch === '\r') {
      // swallow; the following \n (if any) triggers the row break
      byte += chBytes;
      continue;
    }
    if (ch === '\n') {
      startCellIfNeeded();
      pushRow();
      byte += chBytes;
      continue;
    }
    startCellIfNeeded();
    field += ch;
    byte += chBytes;
  }
  // Flush trailing content for a file that does not end in a newline. The
  // closure mutates `cellHasContent`/`row` inside the loop above; ESLint's flow
  // analysis cannot see those writes and wrongly narrows them to constants, so
  // the rule is disabled for this genuinely-needed runtime guard.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (cellHasContent || field.length > 0 || row.length > 0) {
    pushRow();
  }
  // drop a wholly-empty trailing row produced by a final newline
  return rows.filter((r) => !(r.length === 1 && r[0]?.value === ''));
};

/**
 * Decode bytes as UTF-8, stripping a leading BOM. `TextDecoder('utf-8')` strips
 * a UTF-8 BOM itself by default (ignoreBOM defaults to false), so no manual
 * slice is needed. Pure; never throws.
 */
export const decodeCsvBytes = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8').decode(bytes);

/** Normalize a header cell for alias matching: lowercased, trimmed, despaced. */
const normHeader = (h: string): string => h.trim().toLowerCase().replace(/\s+/gu, ' ');

const DATE_ALIASES = [
  'date',
  'posted',
  'posted date',
  'post date',
  'transaction date',
  'trans date',
  'effective date',
];
const AMOUNT_ALIASES = ['amount', 'amt', 'transaction amount'];
const DEBIT_ALIASES = ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out'];
const CREDIT_ALIASES = ['credit', 'deposit', 'deposits', 'money in', 'paid in'];
const DESC_ALIASES = [
  'description',
  'memo',
  'payee',
  'name',
  'details',
  'narrative',
  'transaction',
];
const CURRENCY_ALIASES = ['currency', 'ccy', 'curr'];

/** Column index of the first header matching any alias, else -1. */
const findCol = (headers: readonly string[], aliases: readonly string[]): number =>
  headers.findIndex((h) => aliases.includes(h));

/** Parse a date cell into YYYY-MM-DD, tolerating a few common layouts. */
const parseDateCell = (raw: string): string | null => {
  const s = raw.trim();
  if (s.length === 0) return null;
  // ISO YYYY-MM-DD or YYYY/MM/DD
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(s);
  if (iso) {
    const [, y = '', mo = '', d = ''] = iso;
    return isoIfValid(y, mo, d);
  }
  // US MM/DD/YYYY or MM-DD-YYYY
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/u.exec(s);
  if (us) {
    const [, mo = '', d = '', y = ''] = us;
    return isoIfValid(y, mo, d);
  }
  return null;
};

const isoIfValid = (y: string, mo: string, d: string): string | null => {
  const mm = Number(mo);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y.padStart(4, '0')}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

/** Min/max of a non-empty date list as [start, end]; null pair when empty. */
const dateRange = (dates: readonly string[]): readonly [string | null, string | null] => {
  const present = dates.filter((d) => d.length > 0);
  const first = present[0];
  if (first === undefined) return [null, null];
  let min = first;
  let max = first;
  for (const d of present) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
};

/** Column configuration resolved from the header row. */
interface ColMap {
  readonly date: number;
  readonly amount: number;
  readonly debit: number;
  readonly credit: number;
  readonly desc: number;
  readonly currency: number;
}

/**
 * Resolve the money value for a row as a signed minor-unit string, with a
 * provenance locator, from either a single Amount column or a Debit/Credit
 * split. Debit is an outflow (negative); Credit an inflow (positive). Returns
 * null minor + a null_reason when nothing parses.
 */
const rowAmount = (
  cells: readonly Cell[],
  cols: ColMap,
  rowNo: number,
  scale: number,
): { minor: string | null; prov: FieldProvenance } => {
  const at = (i: number): Cell | undefined => (i >= 0 ? cells[i] : undefined);

  if (cols.amount >= 0) {
    const cell = at(cols.amount);
    if (!cell || cell.value.trim().length === 0) {
      return {
        minor: null,
        prov: provenance({ src_row: rowNo, src_col: cols.amount, null_reason: 'absent' }),
      };
    }
    const parsed = parseMoneyToMinor(cell.value, scale);
    return {
      minor: parsed.ok ? parsed.minor : null,
      prov: provenance({
        src_row: rowNo,
        src_col: cols.amount,
        src_byte_offset: cell.byteOffset,
        null_reason: parsed.ok ? null : reasonFor(parsed.reason),
      }),
    };
  }

  // Debit/Credit split: exactly one side should carry a value. Binding the
  // cell only when it is defined AND non-empty narrows the type (no `!`).
  const debitCell = at(cols.debit);
  const creditCell = at(cols.credit);
  const debit =
    debitCell !== undefined && debitCell.value.trim().length > 0 ? debitCell : undefined;
  const credit =
    creditCell !== undefined && creditCell.value.trim().length > 0 ? creditCell : undefined;

  if (debit !== undefined && credit === undefined) {
    const parsed = parseMoneyToMinor(debit.value.trim(), scale);
    // Debit is an outflow → force negative (`negate` handles 0 → 0).
    const minor = parsed.ok ? negate(parsed.minor) : null;
    return {
      minor,
      prov: provenance({
        src_row: rowNo,
        src_col: cols.debit,
        src_byte_offset: debit.byteOffset,
        null_reason: parsed.ok ? null : reasonFor(parsed.reason),
      }),
    };
  }
  if (credit !== undefined && debit === undefined) {
    const parsed = parseMoneyToMinor(credit.value.trim(), scale);
    return {
      minor: parsed.ok ? parsed.minor : null,
      prov: provenance({
        src_row: rowNo,
        src_col: cols.credit,
        src_byte_offset: credit.byteOffset,
        null_reason: parsed.ok ? null : reasonFor(parsed.reason),
      }),
    };
  }
  // Both empty, or both filled (ambiguous) → inert null.
  const bothFilled = debit !== undefined && credit !== undefined;
  return {
    minor: null,
    prov: provenance({
      src_row: rowNo,
      src_col: debit !== undefined ? cols.debit : cols.credit,
      null_reason: bothFilled ? 'ambiguous' : 'absent',
    }),
  };
};

// Money failures that reach a line cell are always malformed content (empty
// cells are filtered to `absent` before parsing), so the reason maps 1:1.
const reasonFor = (r: 'empty' | 'unparseable'): NullReason => r;

/**
 * Force a minor-unit string to an outflow (negative) magnitude, preserving 0 as
 * 0 so a `$0.00` debit never becomes "-0". A debit cell already written as
 * negative (e.g. accounting parens) is still an outflow, so we key on absolute
 * value: strip any leading '-', then re-apply it (unless zero).
 */
const negate = (minor: string): string => {
  const abs = minor.startsWith('-') ? minor.slice(1) : minor;
  return abs === '0' ? '0' : `-${abs}`;
};

/**
 * Parse CSV statement bytes into a defensive extraction record. Never throws.
 * Balances stay null (a transactions CSV carries no opening/ending); period is
 * min/max of the parsed line dates. Rejects >5000 data rows before building the
 * line array (returns an inert record with a `truncated` reason on currency).
 */
export const parseCsvStatement = (
  bytes: Uint8Array,
  opts: { readonly currency?: string | null } = {},
): StatementExtractionRecord => {
  const base = {
    extractor: 'csv',
    extractorVersion: STATEMENT_PARSER_VERSION,
    model: null,
    promptVersion: null,
  };
  const emptyRecord = (
    rawEvidence: Record<string, unknown>,
  ): StatementExtractionRecord => ({
    ...emptyStatementFields('bank'),
    ...base,
    rawEvidence,
  });

  // TextDecoder (fatal:false) never throws on bytes — malformed sequences
  // become U+FFFD — so no decode try/catch is needed here.
  const text = decodeCsvBytes(bytes);
  const rows = tokenizeCsv(text);
  const headerCells = rows[0];
  if (headerCells === undefined) {
    return emptyRecord({ error: 'empty_file' });
  }

  const headers = headerCells.map((c) => normHeader(c.value));
  const rawHeader = headerCells.map((c) => c.value); // inert, verbatim (Law 5)

  const cols: ColMap = {
    date: findCol(headers, DATE_ALIASES),
    amount: findCol(headers, AMOUNT_ALIASES),
    debit: findCol(headers, DEBIT_ALIASES),
    credit: findCol(headers, CREDIT_ALIASES),
    desc: findCol(headers, DESC_ALIASES),
    currency: findCol(headers, CURRENCY_ALIASES),
  };

  const dataRows = rows.slice(1);
  // Reject before building the line array (resource + parity with staging cap).
  if (dataRows.length > MAX_CSV_ROWS) {
    return {
      ...emptyStatementFields('bank'),
      ...base,
      provenance: {
        ...emptyStatementFields('bank').provenance,
        currency: provenance({ null_reason: 'truncated' }),
      },
      rawEvidence: {
        rawHeader,
        rejected: 'row_cap_exceeded',
        rowCount: dataRows.length,
        maxRows: MAX_CSV_ROWS,
      },
    };
  }

  const statementCurrency =
    opts.currency != null && /^[A-Za-z]{3}$/u.test(opts.currency)
      ? opts.currency.toUpperCase()
      : null;

  const lines: StatementLineRecord[] = [];
  const lineDates: string[] = [];
  let confidentRows = 0;

  for (const [idx, cells] of dataRows.entries()) {
    const rowNo = idx + 1; // 1-based, excludes header
    const scale = currencyScale(statementCurrency);

    const dateCell = cols.date >= 0 ? cells[cols.date] : undefined;
    const lineDate = dateCell ? parseDateCell(dateCell.value) : null;
    if (lineDate) lineDates.push(lineDate);

    const { minor, prov: amountProv } = rowAmount(cells, cols, rowNo, scale);

    const descCell = cols.desc >= 0 ? cells[cols.desc] : undefined;
    const descriptionRaw =
      descCell && descCell.value.length > 0 ? descCell.value : null; // inert (Law 5)

    if (lineDate !== null && minor !== null) confidentRows += 1;

    lines.push({
      lineNo: rowNo,
      lineDate,
      amountMinor: minor,
      currency: statementCurrency,
      descriptionRaw,
      externalId: null,
      provenance: {
        lineDate: provenance({
          src_row: rowNo,
          src_col: cols.date,
          src_byte_offset: dateCell?.byteOffset ?? null,
          null_reason: lineDate === null ? (dateCell ? 'unparseable' : 'absent') : null,
        }),
        amountMinor: amountProv,
        descriptionRaw: provenance({
          src_row: rowNo,
          src_col: cols.desc,
          src_byte_offset: descCell?.byteOffset ?? null,
          null_reason: descriptionRaw === null ? 'absent' : null,
        }),
        externalId: provenance({ null_reason: 'absent' }),
      },
    });
  }

  const [periodStart, periodEnd] = dateRange(lineDates);
  const confidence = lines.length === 0 ? 0 : confidentRows / lines.length;

  const emptyProv = emptyStatementFields('bank').provenance;
  return {
    periodStart,
    periodEnd,
    openingMinor: null,
    endingMinor: null,
    currency: statementCurrency,
    kindHint: 'bank',
    accountHint: null,
    lines,
    holdings: [],
    confidence,
    provenance: {
      ...emptyProv,
      periodStart: provenance({
        null_reason: periodStart === null ? 'absent' : null,
        field_confidence: periodStart === null ? null : 1,
      }),
      periodEnd: provenance({
        null_reason: periodEnd === null ? 'absent' : null,
        field_confidence: periodEnd === null ? null : 1,
      }),
      openingMinor: provenance({ null_reason: 'absent' }),
      endingMinor: provenance({ null_reason: 'absent' }),
      currency: provenance({
        null_reason: statementCurrency === null ? 'absent' : null,
      }),
    },
    ...base,
    rawEvidence: { rawHeader, resolvedColumns: cols, rowCount: dataRows.length },
  };
};
