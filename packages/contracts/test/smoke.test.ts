import { describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION } from '@keel/contracts';

describe('contracts package', () => {
  it('resolves through the workspace', () => {
    expect(CONTRACTS_VERSION).toBe('0.1.0');
  });
});
