import { describe, expect, it } from 'vitest';
import { emptyIngestState, INGEST_VERSION } from '@keel/ingest';

describe('@keel/ingest state', () => {
  it('exports its package version', () => {
    expect(INGEST_VERSION).toBe('0.1.0');
  });

  it('creates an empty provider transaction index', () => {
    const state = emptyIngestState();

    expect(state.byProviderTxnId).toBeInstanceOf(Map);
    expect(state.byProviderTxnId.size).toBe(0);
  });
});
