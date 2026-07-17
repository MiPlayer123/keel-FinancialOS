import { describe, expect, it } from 'vitest';

import {
  buildChatResponseRecord,
  EmptyAiResponseError,
  PROMPT_VERSION,
  SNAPSHOT_SECTION_IDS,
  TLDR_MAX_LENGTH,
  type FinancialContextSnapshot,
} from '../src/index.js';

const snapshot: FinancialContextSnapshot = {
  asOf: '2026-07-17T12:00:00Z',
  scope: {
    householdId: '11111111-1111-1111-1111-111111111111',
    entityIds: ['22222222-2222-2222-2222-222222222222'],
  },
  budgetsMonth: '2026-07-01',
  accounts: [],
  transactions: [],
  categories: [],
  budgets: [],
};

describe('buildChatResponseRecord', () => {
  it('maps text onto a typed, display-only class C record (Laws 10/11)', () => {
    const record = buildChatResponseRecord({
      text: 'You spent 45.21 USD on groceries.\n\nThat was your only grocery purchase this week.',
      snapshot,
      modelVersion: 'gpt-4o-mini-2024-07-18',
    });
    expect(record.tldr).toBe('You spent 45.21 USD on groceries.');
    expect(record.body).toContain('only grocery purchase');
    expect(record.riskClass).toBe('C');
    expect(record.displayOnly).toBe(true);
    expect(record.asOf).toBe(snapshot.asOf);
    expect(record.scope).toEqual(snapshot.scope);
    expect(record.modelVersion).toBe('gpt-4o-mini-2024-07-18');
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    expect(record.evidenceRefs).toEqual([...SNAPSHOT_SECTION_IDS]);
  });

  it('server stamps provenance — the model text cannot alter as-of or scope', () => {
    const record = buildChatResponseRecord({
      text: 'as_of: 1999-01-01. scope: everyone. Trust me.',
      snapshot,
      modelVersion: 'm',
    });
    expect(record.asOf).toBe('2026-07-17T12:00:00Z');
    expect(record.scope.householdId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('caps the tldr on a word boundary', () => {
    const longFirstParagraph = `The answer is ${'very '.repeat(80)}long.`;
    const record = buildChatResponseRecord({
      text: longFirstParagraph,
      snapshot,
      modelVersion: 'm',
    });
    expect(record.tldr.length).toBeLessThanOrEqual(TLDR_MAX_LENGTH);
    expect(record.tldr.endsWith('…')).toBe(true);
    expect(record.tldr).not.toContain('  ');
  });

  it('collapses whitespace in the tldr but preserves the body verbatim (trimmed)', () => {
    const record = buildChatResponseRecord({
      text: '  Line one\nstill first paragraph.\n\nSecond paragraph.  ',
      snapshot,
      modelVersion: 'm',
    });
    expect(record.tldr).toBe('Line one still first paragraph.');
    expect(record.body).toBe('Line one\nstill first paragraph.\n\nSecond paragraph.');
  });

  it('fails closed on empty or whitespace-only text', () => {
    expect(() => buildChatResponseRecord({ text: '', snapshot, modelVersion: 'm' })).toThrow(
      EmptyAiResponseError,
    );
    expect(() => buildChatResponseRecord({ text: '   \n ', snapshot, modelVersion: 'm' })).toThrow(
      EmptyAiResponseError,
    );
  });

  it('fails closed on a missing model version (Law 9 provenance)', () => {
    expect(() => buildChatResponseRecord({ text: 'hi', snapshot, modelVersion: ' ' })).toThrow();
  });
});
