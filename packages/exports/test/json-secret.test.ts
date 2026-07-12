import { describe, expect, it } from 'vitest';
import {
  ExportSecretError,
  assertNoExportSecrets,
  canonicalStringify,
  fromJson,
  sha256Hex,
  toJson,
} from '../src/index.js';
import { emptyTables, snapshot, withTable } from './fixtures.js';

describe('canonical JSON', () => {
  it('recursively sorts keys and converts Date/bigint values without precision loss', () => {
    expect(canonicalStringify({ z: 9000000000000000000n, a: { y: 2, x: 1 }, d: new Date(0) }))
      .toBe('{"a":{"x":1,"y":2},"d":"1970-01-01T00:00:00.000Z","z":"9000000000000000000"}');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalizes timestamps, uses composite row sorting, and hashes each table array', () => {
    const tables = {
      ...emptyTables(),
      households: [
        { id: 'b', name: 'Second', created_at: '2026-07-12T01:02:03-04:00' },
        { id: 'a', name: 'First', created_at: new Date('2026-07-12T01:02:03Z') },
      ],
      audit_log: [
        { id: '10', household_id: 'hh', actor: {}, action: 'x', object_type: 'x', object_id: null, command_id: null, before: null, after: null, at: '2026-07-12T01:00:00Z' },
        { id: '2', household_id: 'hh', actor: {}, action: 'x', object_type: 'x', object_id: null, command_id: null, before: null, after: null, at: '2026-07-12T01:00:00Z' },
      ],
    };
    const text = toJson(snapshot({ asOf: '2026-07-12T01:02:03-04:00', tables }));
    const parsed = JSON.parse(text);

    expect(parsed.asOf).toBe('2026-07-12T05:02:03.000Z');
    expect(parsed.tables.households.map((row: { id: string }) => row.id)).toEqual(['a', 'b']);
    expect(parsed.tables.households[0].created_at).toBe('2026-07-12T01:02:03.000Z');
    expect(parsed.tables.households[1].created_at).toBe('2026-07-12T05:02:03.000Z');
    expect(parsed.tables.audit_log.map((row: { id: string }) => row.id)).toEqual(['2', '10']);

    const householdManifest = parsed.manifest.include.find(
      (entry: { table: string }) => entry.table === 'households',
    );
    expect(householdManifest.count).toBe(2);
    expect(householdManifest.sha256).toBe(
      sha256Hex(canonicalStringify(parsed.tables.households)),
    );
  });

  it('re-emits a parsed captured snapshot byte-identically', () => {
    const first = toJson(withTable('households', [
      { id: 'hh', name: 'Household', created_at: '2026-07-12T12:00:00Z' },
    ]));
    expect(toJson(fromJson(first))).toBe(first);
  });
});

describe('recursive secret boundary', () => {
  it.each([
    ['access_token', { access_token: 'planted' }],
    ['public_token', { public_token: 'planted' }],
    ['link_token', { link_token: 'planted' }],
    ['secret', { secret: 'planted' }],
    ['client_secret', { client_secret: 'planted' }],
    ['wrapped_dek', { wrapped_dek: 'planted' }],
    ['ciphertext', { ciphertext: 'planted' }],
    ['private_key', { private_key: 'planted' }],
    ['JWK private d', { kty: 'EC', crv: 'P-256', d: 'planted' }],
    ['JWK private d in a string', JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'planted' })],
    ['camelCase accessToken', { accessToken: 'planted' }],
    ['hyphenated access-token', { 'access-token': 'planted' }],
    ['nested token in a string', JSON.stringify({ outer: [{ accessToken: 'planted' }] })],
    ['serialized value', 'prefix access_token=planted'],
  ])('rejects %s recursively', (_label, value) => {
    expect(() => assertNoExportSecrets({ nested: [{ value }] })).toThrow(ExportSecretError);
  });

  it.each([
    ['raw_provider_events', 'body_text'],
    ['import_rows', 'raw'],
    ['audit_log', 'actor'],
    ['audit_log', 'before'],
    ['audit_log', 'after'],
    ['domain_events', 'actor'],
    ['domain_events', 'payload'],
    ['connection_health_events', 'details'],
    ['account_lineage', 'previous_state'],
    ['account_lineage', 'new_state'],
    ['balance_snapshots', 'snapshot_metadata'],
    ['command_executions', 'result'],
  ] as const)('fails export when %s.%s contains a planted token', (table, field) => {
    const planted = table === 'raw_provider_events'
      ? JSON.stringify({ client_secret: 'canary' })
      : { client_secret: 'canary' };
    const row = { id: 'row', household_id: 'hh', [field]: planted };
    expect(() => toJson(withTable(table, [row]))).toThrow(ExportSecretError);
  });

  it('does not flag ordinary financial text', () => {
    expect(() => assertNoExportSecrets({
      memo: 'groceries and rent after secret meter rotation',
      nested: [null, 42, true, 'https://example.invalid/?secret=${INERT_DATA}'],
    }))
      .not.toThrow();
  });

  it('rejects a serialized generic secret key assignment', () => {
    expect(() => assertNoExportSecrets('{"secret":"planted"}')).toThrow(ExportSecretError);
  });
});
