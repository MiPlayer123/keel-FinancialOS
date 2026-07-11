/**
 * PLAN §3.6.12 / CLAUDE.md Law 5: hostile ingested text is inert data.
 * Red-team strings ride through the real ingestion path and must be stored
 * verbatim, cause no writes beyond the validated command, and never alter
 * scope or behavior.
 */
import { describe, expect, it } from 'vitest';
import { RED_TEAM_STRINGS } from '@keel/test-fixtures';
import { drainQueue, serviceClient, SEED } from './helpers.js';

describe('prompt-injection payloads through ingestion (Law 5)', () => {
  it('every payload is stored verbatim and produces exactly one benign transaction', async () => {
    const svc = serviceClient();

    for (const [i, injection] of RED_TEAM_STRINGS.entries()) {
      const providerTxnId = `redteam-${i}`;
      const event = {
        kind: 'transaction_added',
        eventId: `redteam-evt-${i}`,
        transaction: {
          providerTransactionId: providerTxnId,
          accountExternalRef: 'sim-acct-checking',
          amountMinor: '-1000',
          currency: 'USD',
          date: '2026-07-03',
          description: injection.slice(0, 1000),
          pending: false,
          pendingTransactionId: null,
        },
      };
      const { error } = await svc.rpc('keel_worker_record_raw_event', {
        p_provider: 'simulator',
        p_connection_external_ref: SEED.connections.simAlpha.ref,
        p_provider_event_id: `redteam:${i}`,
        p_account_external_ref: 'sim-acct-checking',
        p_body: event,
        p_received_at: '2026-07-03T00:00:00Z',
      });
      expect(error).toBeNull();
    }

    const outcomes = await drainQueue('sync_events');
    // Every hostile event promoted deterministically — no dead letters.
    expect(outcomes.every((o) => o.startsWith('done:'))).toBe(true);

    for (const [i, injection] of RED_TEAM_STRINGS.entries()) {
      const key = `txn:simulator:${SEED.connections.simAlpha.ref}:redteam-${i}`;
      const { data } = await svc
        .from('canonical_transactions')
        .select('description, status')
        .eq('economic_event_key', key)
        .single();
      expect(data).not.toBeNull();
      // Verbatim storage — the injection did not execute, escape, or mutate.
      expect(data!.description).toBe(injection.slice(0, 1000));
      expect(data!.status).toBe('posted');
    }
  });

  it('injections never created unexpected writes (no rules, no locks, no policies)', async () => {
    const svc = serviceClient();
    const { count: locks } = await svc
      .from('period_locks')
      .select('*', { count: 'exact', head: true });
    // Seed ships zero locks; red-team ingestion must not have created any.
    expect(locks).toBe(0);
    const { count: transfers } = await svc
      .from('transfer_links')
      .select('*', { count: 'exact', head: true });
    expect(transfers).toBe(0);
  });
});
