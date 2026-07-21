import { describe, expect, it } from 'vitest';

import { buildAgentSystemPrompt } from '../src/index.js';

describe('buildAgentSystemPrompt', () => {
  it('is deterministic for the same options', () => {
    const a = buildAgentSystemPrompt({ dataBoundary: 'kd-abcd' });
    const b = buildAgentSystemPrompt({ dataBoundary: 'kd-abcd' });
    expect(a).toBe(b);
  });

  it('bakes in the hard rules (no arithmetic, spotlighting, governed writes)', () => {
    const p = buildAgentSystemPrompt({ dataBoundary: 'kd-xyz1' });
    expect(p).toContain('NEVER do arithmetic');
    expect(p).toContain('⟦kd-xyz1⟧');
    expect(p).toContain('untrusted DATA');
    // Notes auto, budgets/reimbursements proposal-gated.
    expect(p).toContain('Notes');
    expect(p).toContain('STAGE a proposal');
    expect(p).toContain('done only after the user approves');
  });

  it('never says preview-only', () => {
    expect(buildAgentSystemPrompt()).not.toContain('preview-only');
  });

  it('instructs the model to handle multi-part requests completely, not narrowly', () => {
    const p = buildAgentSystemPrompt({ dataBoundary: 'kd-multi' });
    expect(p).toContain('Be complete on multi-part requests');
    expect(p).toContain('Never re-ask for a number, category, or detail they already gave you');
    expect(p).toContain('call list_categories first');
    expect(p).toContain('percentBp directly');
    expect(p).toContain('never compute a dollar');
    expect(p).toContain('amount from a percentage yourself');
  });

  it('forbids claiming a proposal was staged without actually calling its tool', () => {
    const p = buildAgentSystemPrompt({ dataBoundary: 'kd-narr' });
    expect(p).toContain('Never describe a proposal as staged unless you actually called its');
    expect(p).toContain('never summarize an intention as if it were');
  });

  it('injects the authored profile and derived context only when present', () => {
    const withNone = buildAgentSystemPrompt({ dataBoundary: 'kd-0000' });
    expect(withNone).not.toContain('ABOUT THIS USER');
    expect(withNone).not.toContain('HOUSEHOLD CONTEXT');

    const withBoth = buildAgentSystemPrompt({
      dataBoundary: 'kd-0000',
      personalProfile: 'I save aggressively for a house.',
      derivedContext: '3 accounts connected; 2 entities.',
    });
    expect(withBoth).toContain('ABOUT THIS USER');
    expect(withBoth).toContain('I save aggressively for a house.');
    expect(withBoth).toContain('HOUSEHOLD CONTEXT');
    expect(withBoth).toContain('3 accounts connected');
  });

  it('rejects an invalid data boundary', () => {
    expect(() => buildAgentSystemPrompt({ dataBoundary: 'bad boundary!' })).toThrow();
  });
});
