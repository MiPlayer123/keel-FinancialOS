import { describe, expect, it } from 'vitest';

import {
  AGENT_PROMPT_VERSION,
  buildAgentResponseRecord,
  EmptyAgentResponseError,
} from '../src/index.js';

const base = {
  asOf: '2026-07-19T00:00:00.000Z',
  scope: { householdId: 'h1', entityIds: [] },
  modelVersion: 'claude-x',
  toolsUsed: ['get_net_worth'],
  steps: 2,
  stoppedReason: 'final' as const,
};

describe('buildAgentResponseRecord', () => {
  it('stamps provenance from the server, not the model', () => {
    const rec = buildAgentResponseRecord({ ...base, text: 'Your checking has $1,204.' });
    expect(rec.asOf).toBe(base.asOf);
    expect(rec.scope).toEqual(base.scope);
    expect(rec.modelVersion).toBe('claude-x');
    expect(rec.promptVersion).toBe(AGENT_PROMPT_VERSION);
    expect(rec.toolsUsed).toEqual(['get_net_worth']);
    expect(rec.displayOnly).toBe(true);
    expect(rec.verdict).toBe('uncertain');
    expect(rec.confidence).toBe(0);
    expect(rec.reasonCodes).toEqual(['TOOL_EVIDENCE']);
    expect(rec.evidenceRefs).toEqual(['get_net_worth']);
    expect(rec.requiresApproval).toBe(false);
    expect(rec.policyVersion).toBe('keel-ai-policy@v1');
  });

  it('is not display-only once it carries proposals', () => {
    const rec = buildAgentResponseRecord({
      ...base,
      text: 'I propose setting Groceries to $600.',
      proposedActions: [
        {
          kind: 'budgets.set_target',
          command: 'budgets.set_target',
          summary: 'Groceries → $600',
          payload: { month: '2026-07-01', categoryLedgerAccountId: 'c1', kind: 'amount', amountMinor: '60000' },
        },
      ],
    });
    expect(rec.displayOnly).toBe(false);
    expect(rec.proposedActions).toHaveLength(1);
    expect(rec.requiresApproval).toBe(true);
  });

  it('derives a bounded tldr from the first paragraph', () => {
    const rec = buildAgentResponseRecord({ ...base, text: 'Short answer.\n\nMore detail here.' });
    expect(rec.tldr).toBe('Short answer.');
  });

  it('throws on empty text (fail closed)', () => {
    expect(() => buildAgentResponseRecord({ ...base, text: '   ' })).toThrow(EmptyAgentResponseError);
  });

  it('requires a model version (Law 9)', () => {
    expect(() => buildAgentResponseRecord({ ...base, text: 'x', modelVersion: '' })).toThrow();
  });
});
