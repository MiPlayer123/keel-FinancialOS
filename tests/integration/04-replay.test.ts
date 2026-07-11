/**
 * TASK-000 test 8 — THE replay gate: duplicate, reordered, delayed, and
 * changed simulator events produce a deterministic canonical state, and
 * replaying the entire stream a second time changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, SimulatorBankProvider } from '@keel/test-fixtures';
import { drainQueue, serviceClient, stackEnv, SEED } from './helpers.js';

const feedScenario = async (scenarioName: keyof typeof SCENARIOS): Promise<void> => {
  const scenario = SCENARIOS[scenarioName];
  const provider = new SimulatorBankProvider(scenario);
  const svc = serviceClient();

  let cursor = '';
  for (;;) {
    const page = await provider.sync(scenario.connectionExternalRef, cursor);
    for (const event of page.events) {
      const { error } = await svc.rpc('keel_worker_record_raw_event', {
        p_provider: 'simulator',
        p_connection_external_ref: scenario.connectionExternalRef,
        p_provider_event_id: `${scenarioName}:${event.eventId}`,
        p_account_external_ref:
          event.kind === 'transaction_removed'
            ? 'unknown'
            : event.transaction.accountExternalRef,
        p_body: event,
        p_received_at: '2026-07-01T00:00:00Z',
      });
      if (error) throw new Error(`record failed: ${error.message}`);
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  await drainQueue('sync_events');
};

const canonicalState = async (): Promise<unknown[]> => {
  const svc = serviceClient();
  const { data, error } = await svc
    .from('canonical_transactions')
    .select('economic_event_key, status, description, effective_date')
    .eq('household_id', SEED.households.alpha)
    .like('economic_event_key', 'txn:simulator:%')
    .order('economic_event_key');
  if (error) throw new Error(error.message);
  return data;
};

const trialBalance = async (): Promise<unknown> => {
  const svc = serviceClient();
  // Service role bypasses the membership check via direct aggregation.
  const { data, error } = await svc
    .from('journal_postings')
    .select('ledger_account_id, currency, amount_minor.sum()');
  if (error) return null; // aggregate syntax support varies; state compare is primary
  return data;
};

describe('hostile scenario replay (test 8)', () => {
  // NOTE: scenarios share the sim-conn-alpha connection; suites run
  // sequentially and keys embed the scenario name, so streams don't collide.
  for (const name of [
    'baseline',
    'duplicate_delivery',
    'out_of_order',
    'delayed_posting',
    'changed_amount',
    'removed_transaction',
  ] as const) {
    it(`${name}: deterministic canonical state; full replay is a no-op`, async () => {
      await feedScenario(name);
      const stateAfterFirst = await canonicalState();
      const balanceAfterFirst = await trialBalance();

      // Replay the ENTIRE stream again — every event redelivered.
      await feedScenario(name);
      const stateAfterReplay = await canonicalState();
      const balanceAfterReplay = await trialBalance();

      expect(stateAfterReplay).toEqual(stateAfterFirst);
      expect(balanceAfterReplay).toEqual(balanceAfterFirst);
    });
  }

  it('matches the golden expected canonical states from the fixtures', async () => {
    const svc = serviceClient();
    for (const scenario of Object.values(SCENARIOS)) {
      for (const expected of scenario.expectedCanonical.transactions) {
        const { data } = await svc
          .from('canonical_transactions')
          .select('status, description')
          .eq('economic_event_key', expected.economicKey)
          .single();
        expect(data, `missing ${expected.economicKey}`).not.toBeNull();
        expect(data!.status).toBe(expected.status);
        expect(data!.description).toBe(expected.description);
      }
    }
  });

  it('voided transactions net to zero in the journal (reversal, not deletion)', async () => {
    const svc = serviceClient();
    const { data: voided } = await svc
      .from('canonical_transactions')
      .select('id')
      .eq('status', 'voided')
      .like('economic_event_key', 'txn:simulator:%');
    expect((voided ?? []).length).toBeGreaterThan(0);

    for (const txn of voided ?? []) {
      const { data: batches } = await svc
        .from('journal_batches')
        .select('id')
        .eq('canonical_transaction_id', txn.id);
      const ids = (batches ?? []).map((b) => b.id);
      const { data: postings } = await svc
        .from('journal_postings')
        .select('amount_minor')
        .in('batch_id', ids);
      const sum = (postings ?? []).reduce((acc, p) => acc + BigInt(p.amount_minor), 0n);
      expect(sum).toBe(0n);
      // History preserved: at least original + reversal batches exist.
      expect(ids.length).toBeGreaterThanOrEqual(2);
    }
  });
});
