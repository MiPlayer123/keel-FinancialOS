import { describe, expect, it } from 'vitest';
import { EXCLUDE, INCLUDE } from '../src/index.js';

describe('export manifest', () => {
  it('classifies each manifest public-table decision exactly once', () => {
    expect(INCLUDE).toHaveLength(99);
    expect(EXCLUDE.filter((entry) => entry.schema === 'public')).toHaveLength(19);
    const decisions = [
      ...INCLUDE.map((entry) => entry.table),
      ...EXCLUDE.filter((entry) => entry.schema === 'public').map((entry) => entry.table),
    ];
    expect(new Set(decisions).size).toBe(decisions.length);
  });

  it('documents auth.users separately and includes command_executions', () => {
    expect(INCLUDE.map((entry) => entry.table)).toContain('command_executions');
    expect(INCLUDE.map((entry) => entry.table)).toEqual(
      expect.arrayContaining([
        'household_notes',
        'household_tasks',
        'budget_expected_income',
        'budget_targets',
        'detected_paycheck_dismissals',
        'expected_reimbursements',
        'expected_reimbursement_receipts',
        'expected_reimbursement_status_events',
      ]),
    );
    expect(EXCLUDE).toContainEqual(
      expect.objectContaining({ schema: 'auth', table: 'users' }),
    );
    for (const entry of EXCLUDE) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it('exports the business-tag binding, not just the tag label (Law 6)', () => {
    // canonical.ts projects strictly onto `columns`, so a schema addition that
    // is not listed here is silently dropped from every export. tags.entity_id
    // is the whole of business expense attribution (20260831120000): without
    // it an export says which tags exist and which transactions carry them,
    // but not which tag IS a business's, and the 40-char tag-name truncation
    // means it cannot be re-derived by name either.
    expect(INCLUDE.find((entry) => entry.table === 'tags')?.columns).toContain('entity_id');
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
