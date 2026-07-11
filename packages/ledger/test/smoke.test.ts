import { describe, expect, it } from 'vitest';
import { LEDGER_VERSION } from '@keel/ledger';

describe('ledger package', () => {
  it('resolves through the workspace', () => {
    expect(LEDGER_VERSION).toBe('0.1.0');
  });
});
