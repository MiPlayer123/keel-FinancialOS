import { describe, expect, it } from 'vitest';
import {
  ExportSecretError,
  INCLUDE,
  canonicalStringify,
  fromJson,
  toCsvFiles,
  toJson,
} from '../src/index.js';
import { withTable } from './fixtures.js';

// SLICE 0 (statement-ingestion-v2.md) — approval_tokens joins the audited
// export contract (Law 6). This proves CSV + JSON serialization, a JSON
// round-trip that preserves the token record (including normalized_payload and
// scope jsonb), and that the recursive secret boundary still fires on a planted
// secret inside a token payload — the guard that lets us export
// normalized_payload verbatim safely.

const tokenRow = (overrides: Record<string, unknown> = {}) => ({
  token_id: '11111111-1111-4111-8111-111111111111',
  household_id: '00000000-0000-4000-8000-00000000a001',
  actor_user_id: '00000000-0000-4000-8000-000000000001',
  command: 'statements.approve_draft',
  payload_sha256: 'a'.repeat(64),
  // A statement approval payload — only already-exported ledger facts, no secret.
  normalized_payload: {
    account_id: '00000000-0000-4000-8000-00000000a401',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    opening_minor: '100',
    ending_minor: '120',
    currency: 'USD',
    source_hash: 'c'.repeat(64),
    lines: [{ line_key: 'deposit', date: '2026-06-15', amount_minor: '20', description: 'deposit' }],
  },
  scope: { entities: [], accounts: ['00000000-0000-4000-8000-00000000a401'], period: '2026-06-01/2026-06-30' },
  account_id: '00000000-0000-4000-8000-00000000a401',
  proposal_kind: 'statement_draft',
  proposal_ref: '22222222-2222-4222-8222-222222222222',
  proposal_version: 1,
  policy_version: 'statement-close-v1',
  status: 'issued',
  issued_at: '2026-06-30T12:00:00.000Z',
  expires_at: '2026-06-30T12:15:00.000Z',
  redeemed_at: null,
  redeemed_command_id: null,
  created_at: '2026-06-30T12:00:00.000Z',
  ...overrides,
});

describe('approval_tokens export', () => {
  it('is in the audited INCLUDE list with the full column set and no bigint columns', () => {
    const entry = INCLUDE.find((e) => e.table === 'approval_tokens');
    expect(entry).toBeDefined();
    expect(entry?.columns).toContain('normalized_payload');
    expect(entry?.columns).toContain('payload_sha256');
    expect(entry?.bigintColumns).toEqual([]);
    expect(entry?.sortKey).toEqual(['token_id']);
  });

  it('serializes to a CSV file with an explicit header and neutralized jsonb cells', () => {
    const files = toCsvFiles(withTable('approval_tokens', [tokenRow()]));
    const csv = files.find((f) => f.name === 'approval_tokens.csv');
    expect(csv).toBeDefined();
    // Header is the exact manifest column order.
    expect(csv?.csv.startsWith('"token_id","household_id"')).toBe(true);
    // The jsonb payload is embedded as canonical JSON text in its cell.
    expect(csv?.csv).toContain('source_hash');
    expect(csv?.csv).toContain('statements.approve_draft');
  });

  it('round-trips through JSON preserving the token record and jsonb payload', () => {
    const original = withTable('approval_tokens', [tokenRow()]);
    const restored = fromJson(toJson(original));
    expect(restored.tables.approval_tokens).toHaveLength(1);
    const row = restored.tables.approval_tokens[0];
    if (!row) throw new Error('expected a restored approval_tokens row');
    expect(row.token_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(row.payload_sha256).toBe('a'.repeat(64));
    expect(row.status).toBe('issued');
    // jsonb columns survive the round-trip structurally.
    expect(canonicalStringify(row.normalized_payload)).toBe(
      canonicalStringify(tokenRow().normalized_payload),
    );
    // Re-emitting the restored snapshot is byte-identical.
    const once = toJson(original);
    expect(toJson(fromJson(once))).toBe(once);
  });

  it('still fails the export secret scan if a token payload ever carries a secret', () => {
    const poisoned = withTable('approval_tokens', [
      tokenRow({ normalized_payload: { access_token: 'planted' } }),
    ]);
    expect(() => toJson(poisoned)).toThrow(ExportSecretError);
  });
});
