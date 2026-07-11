import { describe, expect, it } from 'vitest';
import {
  AUTHORED_PLAID_FIXTURES,
  BASELINE_ADDED,
  INITIAL_EMPTY,
  ITEM_LOGIN_REQUIRED,
  MUTATION_RESTART_PAGES,
  NON_USD,
  PENDING_TO_POSTED_PAGES,
} from '../src/fixtures.js';
import { extractAmountLexemes } from '../src/lossless.js';

describe('authored Plaid documented-shape fixtures', () => {
  it('includes every C0 scenario', () => {
    expect(BASELINE_ADDED.rawResponseText).toContain('txn-groceries');
    expect(PENDING_TO_POSTED_PAGES).toHaveLength(2);
    expect(MUTATION_RESTART_PAGES).toHaveLength(2);
    expect(INITIAL_EMPTY.rawResponseText).toContain('"added":[]');
    expect(NON_USD.rawResponseText).toContain('"EUR"');
    expect(ITEM_LOGIN_REQUIRED.rawResponseText).toContain('ITEM_LOGIN_REQUIRED');
    expect(AUTHORED_PLAID_FIXTURES.length).toBe(8);
  });

  it('stores realistic amounts as exact decimal strings', () => {
    const lexemes = AUTHORED_PLAID_FIXTURES.flatMap(({ rawResponseText }) =>
      extractAmountLexemes(rawResponseText),
    );

    expect(lexemes).toEqual(['12.34', '5.75', '48.20', '52.18', '8.00', '17.45']);
  });
});
