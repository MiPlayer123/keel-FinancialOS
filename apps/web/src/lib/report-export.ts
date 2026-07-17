/**
 * C15 — "Export the report you're viewing" (teardown item C15).
 *
 * `admin.export_all` (packages/exports) is a household-WIDE relational table
 * dump by construction (one file per canonical table, raw columns) — it does
 * not know about the Reports scope bar (date range + account/entity subset)
 * and its row shape doesn't match a human-readable transaction register.
 * Rather than force that package's shape, this is a small dedicated builder
 * over the SAME `RichTransactionRow[]` the Reports page already has
 * client-side (from the `transactions.rich` read, unpaginated — the widgets
 * already trust this full set for on-screen totals, so exporting from it is
 * exactly "what's on screen", not an approximation).
 *
 * Pure module: no DOM, no Date.now() (caller injects `generatedAt`) — unit
 * tested in report-export.test.ts. The download (Blob/anchor) side effect
 * stays in the page component, same split as this repo's pure-domain
 * convention elsewhere (packages/ledger etc.).
 *
 * Law 9 (reproducible numbers): every file states its own scope, data as-of
 * timestamp, and export-generated timestamp in a leading comment block, so a
 * CSV that outlives its filename (renamed, emailed, dropped in a folder)
 * still self-describes exactly what it covers.
 *
 * Law 5 (ingested text is data-tier): descriptions/notes/account names/
 * category names/tags came from bank memos, receipts, CSV imports, or a
 * user-typed label — untrusted text. Spreadsheet formula-injection
 * neutralization mirrors packages/exports/src/csv.ts's
 * `neutralizeSpreadsheetCell` (a cell beginning with = + - @ or a tab/CR gets
 * a leading `'` so Excel/Sheets never evaluates it as a formula) — applied
 * ONLY to those free-text columns, not to the Amount column: a negative
 * dollar figure legitimately starts with `-` and is machine-generated (never
 * user-controlled text), so neutralizing it would silently turn every
 * expense into an unsummable text cell and defeat the CSV's point.
 */

import type { RichTransactionRow } from './keel-api';

const neutralizeSpreadsheetCell = (cell: string): string =>
  /^[=+\-@\t\r]/u.test(cell) ? `'${cell}` : cell;

/**
 * Sanitizes free text destined for an UNQUOTED `#`-comment metadata line
 * (review r3604408469): `scopeText` can carry a user-created entity name,
 * and unlike the quoted data cells below, these header lines are written
 * raw with no surrounding quotes to escape a comma/newline. A CR/LF inside
 * the name would otherwise start a new physical line that a spreadsheet
 * app still parses as CSV — if THAT line begins with `=`/`+`/`-`/`@` it
 * becomes an interpretable formula cell. Strip embedded CR/LF (a metadata
 * line is single-line by construction) before applying the same
 * leading-character neutralization used everywhere else in this file.
 */
const sanitizeMetadataText = (text: string): string =>
  neutralizeSpreadsheetCell(text.replaceAll(/[\r\n]+/gu, ' '));

/** Plain RFC-4180 quoting for values this code generates itself (dates,
 *  amounts, currency codes, enums, ids) — never user/bank-originated text. */
const quoteCsv = (cell: string): string => `"${cell.replaceAll('"', '""')}"`;

/** Quoting + formula-injection neutralization for user/bank-originated text
 *  (Law 5): descriptions, notes, account/category names, tags. */
const quoteUntrustedCsv = (cell: string): string =>
  `"${neutralizeSpreadsheetCell(cell).replaceAll('"', '""')}"`;

/**
 * Minor units -> plain decimal string, digit-shifting only (no floats, Law
 * 4). Matches the 2-decimal-digit convention `lib/money.ts#formatMoney`
 * already uses for every currency in this web layer (no currency symbol, no
 * thousands separator, so spreadsheets can SUM the column directly).
 */
function minorToPlainDecimal(amountMinor: string, digits = 2): string {
  const negative = amountMinor.trim().startsWith('-');
  const magnitude = BigInt(amountMinor.replace('-', '') || '0');
  const divisor = 10n ** BigInt(digits);
  const whole = magnitude / divisor;
  const frac = magnitude % divisor;
  const fracStr = digits > 0 ? `.${frac.toString().padStart(digits, '0')}` : '';
  const sign = negative && magnitude > 0n ? '-' : '';
  return `${sign}${whole.toString()}${fracStr}`;
}

const HEADER = [
  'Date',
  'Description',
  'Account',
  'Amount',
  'Currency',
  'Category',
  'Category kind',
  'Status',
  'Tags',
  'Transfer status',
  'Counterparty account',
  'Note',
  'Splits',
  'Transaction ID',
] as const;

/** Category names are user-created (Law 5) — the whole composite cell goes
 *  through neutralization, same as any other free-text column. */
function splitsCell(row: RichTransactionRow): string {
  if (!row.splits || row.splits.length === 0) return '';
  return row.splits.map((s) => `${s.name}: ${minorToPlainDecimal(s.amountMinor)}`).join('; ');
}

/** One CSV data line, each cell already quoted with the function matching
 *  its trust level (see `quoteCsv` vs `quoteUntrustedCsv` above). */
function transactionRow(row: RichTransactionRow): string {
  return [
    quoteCsv(row.effectiveDate.slice(0, 10)),
    quoteUntrustedCsv(row.description),
    quoteUntrustedCsv(row.accountName),
    quoteCsv(minorToPlainDecimal(row.amountMinor)),
    quoteCsv(row.currency),
    quoteUntrustedCsv(row.categoryName ?? 'Uncategorized'),
    quoteCsv(row.categoryKind ?? ''),
    quoteCsv(row.status),
    quoteUntrustedCsv((row.tags ?? []).map((t) => t.name).join('; ')),
    quoteCsv(row.transferStatus ?? ''),
    quoteUntrustedCsv(row.counterpartyAccountName ?? ''),
    quoteUntrustedCsv(row.note ?? ''),
    quoteUntrustedCsv(splitsCell(row)),
    quoteCsv(row.transactionId),
  ].join(',');
}

export type ScopedExportInput = {
  /** Rows already reduced to the report scope — accounts ∩ entity AND the
   *  [from, to] day range (e.g. Reports page's `rangedRows`). No widget-level
   *  exclusion (transfers/debt-payment convention) applies here — this is
   *  the full scoped transaction set, matching the ledger's own row set. */
  rows: RichTransactionRow[];
  scope: { from: string; to: string };
  /** The same Law-9 footnote label every widget already shows
   *  (`report-scope.ts#scopeLabel`) — one source of truth for scope text. */
  scopeText: string;
  /** `transactions.rich`'s query envelope `asOf` — when the underlying data
   *  was read, distinct from `generatedAt` (when the file was built). */
  asOf: string | null;
  /** Injectable so the builder stays pure/deterministic for tests. */
  generatedAt: Date;
};

/** Sorted oldest-first — same reading order as a bank statement / ledger. */
function sortedRows(rows: RichTransactionRow[]): RichTransactionRow[] {
  return [...rows].sort((a, b) => {
    const byDate = a.effectiveDate.localeCompare(b.effectiveDate);
    return byDate !== 0 ? byDate : a.transactionId.localeCompare(b.transactionId);
  });
}

/**
 * RFC-4180-ish CSV (CRLF line endings, every cell quoted) with a leading
 * `#`-prefixed metadata block stating scope/as-of/generated-at. One row per
 * TRANSACTION (not per split) so a naive "sum the Amount column" reproduces
 * net cash flow for the scope — splits are disclosed in their own column as
 * sub-allocation detail, not separate summable rows (Law 3: postings balance
 * per transaction; a spreadsheet SUM must not double-count a split's shares
 * against its own parent cash amount).
 */
export function buildScopedTransactionsCsv(input: ScopedExportInput): string {
  const lines: string[] = [
    `# KEEL Reports export — scope: ${sanitizeMetadataText(input.scopeText)}`,
    `# Range: ${input.scope.from} to ${input.scope.to}`,
    `# Data as of: ${input.asOf ?? 'unknown'}`,
    `# Generated: ${input.generatedAt.toISOString()}`,
    `# ${String(input.rows.length)} transaction${input.rows.length === 1 ? '' : 's'}. One row per transaction (splits shown in the Splits column, not counted as extra rows).`,
    HEADER.map(quoteCsv).join(','),
    ...sortedRows(input.rows).map(transactionRow),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** Filesystem-safe timestamp: no `:` and no `.` (Windows-safe too). */
function fsSafeTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** `keel-reports-export_<from>_to_<to>_<generated-at>.csv` — the from/to in
 *  the name so a folder of downloads sorts/scans by range at a glance,
 *  matching the header block for defense-in-depth self-description. */
export function scopedExportFilename(scope: { from: string; to: string }, generatedAt: Date): string {
  return `keel-reports-export_${scope.from}_to_${scope.to}_${fsSafeTimestamp(generatedAt)}.csv`;
}
