import {
  EXCLUDE,
  INCLUDE,
  type ExportTableName,
  type IncludedTableDefinition,
} from './manifest.js';
import { assertNoExportSecrets } from './secret-scan.js';
import { sha256Hex } from './sha256.js';
import type { ExportRow, ExportTables, HouseholdExport, TrialBalanceRow } from './types.js';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const canonicalValue = (value: unknown): JsonValue => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const child = record[key];
      if (child !== undefined) result[key] = canonicalValue(child);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
};

export const canonicalStringify = (value: unknown): string => JSON.stringify(canonicalValue(value));

const normalizeTimestamp = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new TypeError(`Invalid timestamp in ${field}.`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid timestamp in ${field}.`);
  return date.toISOString();
};

const normalizeBigint = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw new TypeError(`BIGINT field ${field} must be a decimal string.`);
  }
  return value;
};

const compareDecimalStrings = (left: string, right: string): number => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  // compareRows calls this only after equality has already been ruled out.
  return leftValue < rightValue ? -1 : 1;
};

const compareRows = (
  left: ExportRow,
  right: ExportRow,
  sortKey: readonly string[],
  bigintColumns: readonly string[],
): number => {
  for (const key of sortKey) {
    const a = left[key];
    const b = right[key];
    if (a === b) continue;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    const compared = bigintColumns.includes(key)
      ? compareDecimalStrings(canonicalStringify(a).replaceAll('"', ''), canonicalStringify(b).replaceAll('"', ''))
      : canonicalStringify(a).localeCompare(canonicalStringify(b), 'en');
    if (compared !== 0) return compared;
  }
  return canonicalStringify(left).localeCompare(canonicalStringify(right), 'en');
};

const prepareTables = (tables: ExportTables): ExportTables => {
  const result: Partial<Record<ExportTableName, readonly ExportRow[]>> = {};
  for (const rawDefinition of INCLUDE) {
    const definition: IncludedTableDefinition = rawDefinition;
    const table = definition.table as ExportTableName;
    const rows = Object.hasOwn(tables, table) ? tables[table] : [];
    const prepared = rows.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const column of definition.columns) {
        if (!Object.hasOwn(row, column)) continue;
        const value = row[column];
        projected[column] = definition.bigintColumns.includes(column)
          ? normalizeBigint(value, `${definition.table}.${column}`)
          : definition.timestampColumns.includes(column)
            ? normalizeTimestamp(value, `${definition.table}.${column}`)
            : canonicalValue(value);
      }
      return projected;
    });
    result[table] = prepared.sort((left, right) =>
      compareRows(left, right, definition.sortKey, definition.bigintColumns));
  }
  return result as ExportTables;
};

const prepareTrialBalance = (
  rows: readonly TrialBalanceRow[] | undefined,
): readonly TrialBalanceRow[] => [...(rows ?? [])].sort((left, right) =>
  left.ledgerAccountId.localeCompare(right.ledgerAccountId, 'en') ||
  left.currency.localeCompare(right.currency, 'en'));

export const toJson = (snapshot: HouseholdExport): string => {
  assertNoExportSecrets(snapshot);
  const tables = prepareTables(snapshot.tables);
  const include = INCLUDE.map((rawDefinition) => {
    const definition: IncludedTableDefinition = rawDefinition;
    const table = definition.table as ExportTableName;
    return {
      table: definition.table,
      columns: definition.columns,
      sortKey: definition.sortKey,
      count: tables[table].length,
      sha256: sha256Hex(canonicalStringify(tables[table])),
      ...(definition.omittedColumns === undefined
        ? {}
        : { omittedColumns: definition.omittedColumns }),
    };
  });
  return canonicalStringify({
    formatVersion: 'keel.export.json.v1',
    asOf: normalizeTimestamp(snapshot.asOf, 'asOf'),
    scope: { householdId: snapshot.householdId },
    manifest: {
      version: 'keel.export.manifest.v2',
      formatVersions: {
        json: '1',
        csv: '1',
        qif: '1',
        beancount: '1',
      },
      include,
      exclude: EXCLUDE,
    },
    trialBalance: prepareTrialBalance(snapshot.trialBalance),
    tables,
  });
};

interface JsonEnvelope {
  readonly asOf: string;
  readonly scope: { readonly householdId: string };
  readonly tables: ExportTables;
  readonly trialBalance?: readonly TrialBalanceRow[];
}

export const fromJson = (json: string): HouseholdExport => {
  const parsed = JSON.parse(json) as Partial<JsonEnvelope>;
  if (
    typeof parsed.asOf !== 'string' ||
    typeof parsed.scope?.householdId !== 'string' ||
    parsed.tables === undefined
  ) {
    throw new TypeError('Invalid KEEL JSON export envelope.');
  }
  return {
    householdId: parsed.scope.householdId,
    asOf: parsed.asOf,
    tables: parsed.tables,
    trialBalance: parsed.trialBalance ?? [],
  };
};
