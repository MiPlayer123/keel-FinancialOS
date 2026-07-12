import { canonicalStringify, fromJson, toJson } from './canonical.js';
import { INCLUDE } from './manifest.js';
import type { CsvFile, HouseholdExport } from './types.js';

const neutralizeSpreadsheetCell = (cell: string): string =>
  /^[=+\-@\t\r]/u.test(cell) ? `'${cell}` : cell;

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : canonicalStringify(value);
  return neutralizeSpreadsheetCell(text);
};

const quoteCsv = (cell: string): string => `"${cell.replaceAll('"', '""')}"`;

/** One explicit-column RFC-4180 file per included table. */
export const toCsvFiles = (snapshot: HouseholdExport): CsvFile[] => {
  const prepared = fromJson(toJson(snapshot));
  return INCLUDE.map((definition) => {
    const lines = [
      definition.columns.map(quoteCsv).join(','),
      ...prepared.tables[definition.table].map((row) =>
        definition.columns.map((column) => quoteCsv(cellText(row[column]))).join(',')),
    ];
    return { name: `${definition.table}.csv`, csv: `${lines.join('\r\n')}\r\n` };
  });
};
