import { INCLUDE, type ExportTables, type HouseholdExport } from '../src/index.js';

export const emptyTables = (): ExportTables =>
  Object.fromEntries(INCLUDE.map((entry) => [entry.table, []])) as unknown as ExportTables;

export const snapshot = (
  overrides: Partial<HouseholdExport> = {},
): HouseholdExport => ({
  householdId: '00000000-0000-4000-8000-00000000a001',
  asOf: '2026-07-12T12:00:00.000Z',
  tables: emptyTables(),
  trialBalance: [],
  ...overrides,
});

export const withTable = (
  table: keyof ExportTables,
  rows: readonly Readonly<Record<string, unknown>>[],
): HouseholdExport => {
  const tables = { ...emptyTables(), [table]: rows } as ExportTables;
  return snapshot({ tables });
};
