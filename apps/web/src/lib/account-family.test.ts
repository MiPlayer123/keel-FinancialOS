import { describe, expect, it } from 'vitest';
import { isReplaced, successorOf, withPredecessors } from './account-family';

const accounts = [
  { id: 'card-2020', replacedByAccountId: 'card-2023' },
  { id: 'card-2023', replacedByAccountId: 'card-2026' },
  { id: 'card-2026', replacedByAccountId: null },
  { id: 'checking' },
];

describe('account continuity', () => {
  it('follows the replaced-by chain to the live account', () => {
    expect(successorOf('card-2020', accounts)).toBe('card-2026');
    expect(successorOf('card-2026', accounts)).toBe('card-2026');
    expect(successorOf('checking', accounts)).toBe('checking');
    expect(successorOf('unknown', accounts)).toBe('unknown');
  });

  it('expands an account to every number it replaced', () => {
    expect([...withPredecessors(['card-2026'], accounts)].sort()).toEqual(['card-2020', 'card-2023', 'card-2026']);
    expect([...withPredecessors(['checking'], accounts)]).toEqual(['checking']);
  });

  it('hides replaced accounts in pickers', () => {
    expect(accounts.filter((a) => !isReplaced(a, accounts)).map((a) => a.id)).toEqual(['card-2026', 'checking']);
  });

  it('never loops on a bad chain', () => {
    const loop = [{ id: 'a', replacedByAccountId: 'b' }, { id: 'b', replacedByAccountId: 'a' }];
    expect(['a', 'b']).toContain(successorOf('a', loop));
    expect(withPredecessors(['a'], loop).size).toBeLessThanOrEqual(2);
  });
});
