import { describe, expect, it } from 'vitest';
import { FIXTURES_VERSION } from '@keel/test-fixtures';

describe('test-fixtures package', () => {
  it('resolves through the workspace', () => {
    expect(FIXTURES_VERSION).toBe('0.1.0');
  });
});
