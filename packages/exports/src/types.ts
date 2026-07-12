import type { ExportTableName } from './manifest.js';

export type ExportRow = Readonly<Record<string, unknown>>;
export type ExportTables = Readonly<Record<ExportTableName, readonly ExportRow[]>>;

export interface TrialBalanceRow {
  readonly ledgerAccountId: string;
  readonly currency: string;
  readonly balanceMinor: string;
}

/** Raw, already-authorized snapshot returned by keel_export_household. */
export interface HouseholdExport {
  readonly householdId: string;
  readonly asOf: string | Date;
  readonly tables: ExportTables;
  readonly trialBalance?: readonly TrialBalanceRow[];
}

export interface CsvFile {
  readonly name: string;
  readonly csv: string;
}
