import { describe, expect, it } from 'vitest';
import { AUTHZ_VERSION } from '@keel/authz';

describe('authz package', () => {
  it('resolves through the workspace', () => {
    expect(AUTHZ_VERSION).toBe('0.1.0');
  });
});
