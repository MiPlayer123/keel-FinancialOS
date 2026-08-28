import { describe, expect, it } from 'vitest';
import { EXCLUDE, INCLUDE } from '../src/index.js';

describe('export manifest', () => {
  it('classifies each manifest public-table decision exactly once', () => {
    expect(INCLUDE).toHaveLength(93);
    expect(EXCLUDE.filter((entry) => entry.schema === 'public')).toHaveLength(14);
    const decisions = [
      ...INCLUDE.map((entry) => entry.table),
      ...EXCLUDE.filter((entry) => entry.schema === 'public').map((entry) => entry.table),
    ];
    expect(new Set(decisions).size).toBe(decisions.length);
  });

  it('documents auth.users separately and includes command_executions', () => {
    expect(INCLUDE.map((entry) => entry.table)).toContain('command_executions');
    expect(INCLUDE.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['household_notes', 'household_tasks']),
    );
    expect(EXCLUDE).toContainEqual(
      expect.objectContaining({ schema: 'auth', table: 'users' }),
    );
    for (const entry of EXCLUDE) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it('defines explicit columns, timestamp columns, bigint columns, and composite sort keys', () => {
    for (const entry of INCLUDE) {
      expect(entry.columns.length, entry.table).toBeGreaterThan(0);
      expect(entry.sortKey.length, entry.table).toBeGreaterThan(0);
      expect(entry.timestampColumns).toBeDefined();
      expect(entry.bigintColumns).toBeDefined();
    }

    expect(INCLUDE.find((entry) => entry.table === 'journal_postings')?.bigintColumns)
      .toEqual(['amount_minor']);
    expect(INCLUDE.find((entry) => entry.table === 'audit_log')?.bigintColumns)
      .toEqual(['id']);
    expect(INCLUDE.find((entry) => entry.table === 'recurring_occurrences')?.bigintColumns)
      .toEqual(['expected_amount_minor']);
    expect(INCLUDE.find((entry) => entry.table === 'paychecks')?.bigintColumns)
      .toEqual(['gross_minor', 'net_minor']);
    expect(INCLUDE.find((entry) => entry.table === 'paycheck_transaction_matches')?.bigintColumns)
      .toEqual(['allocated_minor']);
    expect(INCLUDE.find((entry)=>entry.table==='reimbursement_claims')?.bigintColumns).toEqual(['amount_minor']);
  });

  it('exports exact raw bytes and digest but explicitly omits parsed raw body JSON', () => {
    const raw = INCLUDE.find((entry) => entry.table === 'raw_provider_events');
    expect(raw?.columns).toContain('body_text');
    expect(raw?.columns).toContain('body_sha256');
    expect(raw?.columns).not.toContain('body');
    expect(raw?.omittedColumns).toEqual({
      body: 'Parsed convenience copy omitted; body_text is the exact immutable source.',
    });
  });
});
