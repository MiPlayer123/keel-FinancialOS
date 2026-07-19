import { describe, expect, it } from 'vitest';

import { computeIsSyncing } from './keel-api';

const FRESH = new Date('2026-07-19T00:00:00Z').getTime();

describe('computeIsSyncing', () => {
  it('is false for a disconnected connection even with a leftover generation mismatch', () => {
    // The exact live Fidelity state: disconnected, desired 57 vs committed 56.
    // Must NOT report syncing (would otherwise stick "Syncing…" forever and
    // disable Fix balance / Sync now on a dead connection).
    expect(
      computeIsSyncing({
        status: 'disconnected',
        syncDesiredGeneration: 57,
        syncCommittedGeneration: 56,
        syncContinuationPending: false,
        syncContinuationMarkedAt: null,
        now: FRESH,
      }),
    ).toBe(false);
  });

  it('is false for a disconnected connection even with a fresh continuation flag', () => {
    expect(
      computeIsSyncing({
        status: 'disconnected',
        syncDesiredGeneration: 56,
        syncCommittedGeneration: 56,
        syncContinuationPending: true,
        syncContinuationMarkedAt: new Date(FRESH - 1000).toISOString(),
        now: FRESH,
      }),
    ).toBe(false);
  });

  it('is true for an active connection with a generation mismatch', () => {
    expect(
      computeIsSyncing({
        status: 'active',
        syncDesiredGeneration: 57,
        syncCommittedGeneration: 56,
        syncContinuationPending: false,
        syncContinuationMarkedAt: null,
        now: FRESH,
      }),
    ).toBe(true);
  });

  it('is false for an active, fully-committed connection with no pending continuation', () => {
    expect(
      computeIsSyncing({
        status: 'active',
        syncDesiredGeneration: 56,
        syncCommittedGeneration: 56,
        syncContinuationPending: false,
        syncContinuationMarkedAt: null,
        now: FRESH,
      }),
    ).toBe(false);
  });

  it('is true for an active connection with a fresh continuation flag', () => {
    expect(
      computeIsSyncing({
        status: 'active',
        syncDesiredGeneration: 56,
        syncCommittedGeneration: 56,
        syncContinuationPending: true,
        syncContinuationMarkedAt: new Date(FRESH - 60_000).toISOString(),
        now: FRESH,
      }),
    ).toBe(true);
  });

  it('is false for an active connection whose continuation flag has gone stale', () => {
    expect(
      computeIsSyncing({
        status: 'active',
        syncDesiredGeneration: 56,
        syncCommittedGeneration: 56,
        syncContinuationPending: true,
        // 16 minutes ago — past the 15-minute staleness cutoff.
        syncContinuationMarkedAt: new Date(FRESH - 16 * 60_000).toISOString(),
        now: FRESH,
      }),
    ).toBe(false);
  });

  it('is false for a reauth_required connection with a mismatch', () => {
    expect(
      computeIsSyncing({
        status: 'reauth_required',
        syncDesiredGeneration: 57,
        syncCommittedGeneration: 56,
        syncContinuationPending: false,
        syncContinuationMarkedAt: null,
        now: FRESH,
      }),
    ).toBe(false);
  });
});
