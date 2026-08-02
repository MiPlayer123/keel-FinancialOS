import { describe, expect, it } from 'vitest';
import {
  ExportSecretError,
  INCLUDE,
  canonicalStringify,
  fromJson,
  toCsvFiles,
  toJson,
} from '../src/index.js';
import { emptyTables, snapshot, withTable } from './fixtures.js';

// SLICE 3 (statement-ingestion-v2.md §5 [A11]) — the five new statement-ingestion
// tables join the audited export contract (Law 6): CSV + JSON + secret-scan +
// round-trip restore. raw_evidence is inert ledger-adjacent evidence (a verbatim
// parser/model read of an already-exported source file) and carries no secrets —
// the recursive json-secret guard still fires if one were ever planted.

const EXTRACTION_ID = '33333333-3333-4333-8333-333333333333';
const HOUSEHOLD = '00000000-0000-4000-8000-00000000a001';

const extractionRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXTRACTION_ID,
  household_id: HOUSEHOLD,
  document_version_id: '44444444-4444-4444-8444-444444444444',
  account_id: '00000000-0000-4000-8000-00000000a401',
  kind_hint: 'bank',
  period_start: '2026-06-01',
  period_end: '2026-06-30',
  opening_minor: '10000',
  ending_minor: '12000',
  currency: 'USD',
  extractor: 'fixture',
  extractor_version: 'v1',
  model_version: null,
  prompt_version: null,
  confidence: 0.9,
  // Inert evidence — a verbatim parse of the source file, no secret.
  raw_evidence: { pages: 1, note: 'DEPOSIT 200.00' },
  status: 'extracted',
  error_code: null,
  created_at: '2026-06-30T12:00:00.000Z',
  ...overrides,
});

const lineRow = (overrides: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  household_id: HOUSEHOLD,
  extraction_id: EXTRACTION_ID,
  line_no: 1,
  line_date: '2026-06-15',
  amount_minor: '2000',
  description_raw: 'DEPOSIT',
  currency: 'USD',
  src_page: 1,
  src_bbox: '10,20,30,40',
  src_row: null,
  src_col: null,
  src_byte_offset: '128',
  ofx_path: null,
  field_confidence: 0.95,
  null_reason: null,
  created_at: '2026-06-30T12:00:00.000Z',
  ...overrides,
});

const holdingRow = () => ({
  id: '66666666-6666-4666-8666-666666666666',
  household_id: HOUSEHOLD,
  extraction_id: EXTRACTION_ID,
  symbol: 'ACME',
  cusip: '000000000',
  isin: 'US0000000000',
  name: 'Acme Index Fund',
  qty: '12.5',
  price_minor: '10000',
  value_minor: '125000',
  cost_basis_minor: '100000',
  currency: 'USD',
  src_page: 2,
  src_bbox: null,
  ofx_path: 'OFX/INVSTMTMSGSRSV1/INVSTMTTRNRS/INVSTMTRS/INVPOSLIST/POSSTOCK',
  field_confidence: 0.9,
  null_reason: null,
  created_at: '2026-06-30T12:00:00.000Z',
});

const hashRow = () => ({
  household_id: HOUSEHOLD,
  content_sha256: 'c'.repeat(64),
  first_document_id: '77777777-7777-4777-8777-777777777777',
  first_version_id: '44444444-4444-4444-8444-444444444444',
  byte_size: '20480',
  created_at: '2026-06-30T12:00:00.000Z',
});

const draftRow = () => ({
  id: '88888888-8888-4888-8888-888888888888',
  household_id: HOUSEHOLD,
  document_version_id: '44444444-4444-4444-8444-444444444444',
  account_id: '00000000-0000-4000-8000-00000000a401',
  source_hash: 'c'.repeat(64),
  status: 'extracted',
  extraction_id: EXTRACTION_ID,
  statement_id: null,
  decided_by: null,
  decided_at: null,
  created_at: '2026-06-30T12:00:00.000Z',
});

describe('statement-ingestion export (SLICE 3)', () => {
  it('all five new tables are in the audited INCLUDE list with money columns declared bigint', () => {
    for (const t of [
      'statement_extractions',
      'statement_extraction_lines',
      'statement_extraction_holdings',
      'document_hashes',
      'statement_drafts',
    ]) {
      expect(INCLUDE.find((e) => e.table === t), t).toBeDefined();
    }
    expect(INCLUDE.find((e) => e.table === 'statement_extraction_lines')?.bigintColumns)
      .toEqual(['amount_minor', 'src_byte_offset']);
    expect(INCLUDE.find((e) => e.table === 'statement_extraction_holdings')?.bigintColumns)
      .toEqual(['price_minor', 'value_minor', 'cost_basis_minor']);
    // statements gained the anchor provenance columns.
    expect(INCLUDE.find((e) => e.table === 'statements')?.columns)
      .toContain('balance_check');
    expect(INCLUDE.find((e) => e.table === 'statements')?.columns)
      .toContain('anchor_reason');
  });

  it('serializes each new table to a CSV file with an explicit header', () => {
    const snap = snapshot({
      tables: {
        ...emptyTables(),
        statement_extractions: [extractionRow()],
        statement_extraction_lines: [lineRow()],
        statement_extraction_holdings: [holdingRow()],
        document_hashes: [hashRow()],
        statement_drafts: [draftRow()],
      } as never,
    });
    const files = toCsvFiles(snap);
    for (const t of [
      'statement_extractions',
      'statement_extraction_lines',
      'statement_extraction_holdings',
      'document_hashes',
      'statement_drafts',
    ]) {
      expect(files.find((f) => f.name === `${t}.csv`), t).toBeDefined();
    }
  });

  it('round-trips through JSON preserving raw_evidence jsonb and bigint text', () => {
    const original = snapshot({
      tables: {
        ...emptyTables(),
        statement_extractions: [extractionRow()],
        statement_extraction_lines: [lineRow()],
      } as never,
    });
    const restored = fromJson(toJson(original));
    expect(restored.tables.statement_extractions).toHaveLength(1);
    const extraction = restored.tables.statement_extractions[0];
    if (!extraction) throw new Error('expected a restored statement_extractions row');
    expect(canonicalStringify(extraction.raw_evidence)).toBe(
      canonicalStringify(extractionRow().raw_evidence),
    );
    const line = restored.tables.statement_extraction_lines[0];
    if (!line) throw new Error('expected a restored statement_extraction_lines row');
    expect(line.amount_minor).toBe('2000');
    const once = toJson(original);
    expect(toJson(fromJson(once))).toBe(once);
  });

  it('still fails the export secret scan if raw_evidence ever carried a secret', () => {
    const poisoned = withTable('statement_extractions', [
      extractionRow({ raw_evidence: { access_token: 'planted' } }),
    ]);
    expect(() => toJson(poisoned)).toThrow(ExportSecretError);
  });
});

// SLICE 6 (statement-ingestion-v2.md §5/§8/§12 [A11]) — statement_outbox, the
// transactional-outbox delivery ledger, joins the audited export contract (its
// table shipped in Slice 5 with export deferred; this is where the layer lands).
const outboxRow = () => ({
  id: '99999999-9999-4999-8999-999999999999',
  household_id: HOUSEHOLD,
  document_version_id: '44444444-4444-4444-8444-444444444444',
  account_id: '00000000-0000-4000-8000-00000000a401',
  status: 'pending',
  enqueue_count: 1,
  last_enqueued_at: '2026-06-30T12:05:00.000Z',
  delivered_at: null,
  created_at: '2026-06-30T12:00:00.000Z',
});

describe('statement_outbox export (SLICE 6)', () => {
  it('is in the audited INCLUDE list', () => {
    expect(INCLUDE.find((e) => e.table === 'statement_outbox')).toBeDefined();
  });

  it('serializes to a CSV file with an explicit header', () => {
    const snap = snapshot({
      tables: { ...emptyTables(), statement_outbox: [outboxRow()] } as never,
    });
    const files = toCsvFiles(snap);
    expect(files.find((f) => f.name === 'statement_outbox.csv')).toBeDefined();
  });

  it('round-trips through JSON', () => {
    const original = snapshot({
      tables: { ...emptyTables(), statement_outbox: [outboxRow()] } as never,
    });
    const restored = fromJson(toJson(original));
    expect(restored.tables.statement_outbox).toHaveLength(1);
    const once = toJson(original);
    expect(toJson(fromJson(once))).toBe(once);
  });
});
