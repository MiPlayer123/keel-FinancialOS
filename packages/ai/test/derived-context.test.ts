import { describe, expect, it } from 'vitest';

import { buildDerivedContext, type DerivedContextFacts } from '../src/index.js';

const base: DerivedContextFacts = {
  accounts: [
    { name: 'Everyday Checking', subtype: 'checking' },
    { name: 'Rewards Card', subtype: 'credit_card' },
  ],
  entities: [{ name: 'Personal' }, { name: 'Rentals LLC' }],
  budgetsMonth: '2026-07',
  hasBudget: true,
};

describe('buildDerivedContext', () => {
  it('is deterministic', () => {
    expect(buildDerivedContext(base)).toBe(buildDerivedContext(base));
  });

  it('summarizes entities, accounts, and budget state', () => {
    const out = buildDerivedContext(base);
    expect(out).toContain('Personal, Rentals LLC');
    expect(out).toContain('2 connected account(s)');
    expect(out).toContain('Everyday Checking (checking)');
    expect(out).toContain('A budget is set up for 2026-07.');
  });

  it('handles the empty household', () => {
    const out = buildDerivedContext({ accounts: [], entities: [], budgetsMonth: '2026-07', hasBudget: false });
    expect(out).toContain('No accounts are connected yet.');
    expect(out).toContain('No budget is set up for 2026-07 yet.');
    expect(out).not.toContain('Entities in this household');
  });

  it('caps long lists', () => {
    const accounts = Array.from({ length: 50 }, (_v, i) => ({ name: `A${String(i)}`, subtype: 'checking' }));
    const out = buildDerivedContext({ ...base, accounts });
    expect(out).toContain('50 connected account(s)');
    expect(out).toContain('and 20 more');
  });
});
