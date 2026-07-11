/** Stage 1C C5b durable Plaid sync-pull integration gate. */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { drainQueue, serviceClient, signIn, SEED } from './helpers.js';

let plaidAccountId: string;
let plaidLedgerAccountId: string;

const enqueueNotification = async (eventId: string): Promise<void> => {
  const { error } = await serviceClient().rpc('keel_worker_record_raw_event', {
    p_provider: 'plaid',
    p_connection_external_ref: SEED.connections.plaidAlpha.ref,
    p_provider_event_id: eventId,
    p_account_external_ref: 'item-notification',
    p_body: {
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: SEED.connections.plaidAlpha.ref,
    },
    p_received_at: '2026-07-11T13:00:00Z',
  });
  if (error) throw new Error(`notification enqueue failed: ${error.message}`);
};

beforeAll(async () => {
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: crypto.randomUUID(),
    p_economic_event_key: `itest:plaid-account:${crypto.randomUUID()}`,
    p_actor: { kind: 'user', userId: SEED.users.alex.id },
    p_household_id: SEED.households.alpha,
    p_payload: {
      entity_id: SEED.entities.alphaPersonal,
      connection_id: SEED.connections.plaidAlpha.id,
      external_ref: 'acct-checking',
      name: 'Plaid Checking',
      kind: 'asset',
      subtype: 'checking',
      currency: 'USD',
    },
  });
  if (error) throw new Error(`Plaid account bootstrap failed: ${error.message}`);
  const effects = (data as { effects: { accountId: string; ledgerAccountId: string } }).effects;
  plaidAccountId = effects.accountId;
  plaidLedgerAccountId = effects.ledgerAccountId;
});

describe('durable Plaid sync pull (Stage 1C C5b)', () => {
  it('recovers from pagination mutation and promotes one posted economic history', async () => {
    await enqueueNotification(`itest:c5b:first:${crypto.randomUUID()}`);
    const outcomes = await drainQueue('sync_events');
    expect(outcomes.some((outcome) => outcome.includes('mutation restart'))).toBe(true);
    expect(outcomes.some((outcome) => outcome.startsWith('done:sync complete'))).toBe(true);
    expect(outcomes.every((outcome) => !outcome.startsWith('dead_letter:'))).toBe(true);

    const svc = serviceClient();
    const { data: connection } = await svc
      .from('connections')
      .select('sync_desired_generation, sync_committed_generation, sync_lease_owner, sync_leased_until')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    expect(connection!.sync_committed_generation).toBeGreaterThan(0);
    expect(connection!.sync_committed_generation).toBe(connection!.sync_desired_generation);
    expect(connection!.sync_lease_owner).toBeNull();
    expect(connection!.sync_leased_until).toBeNull();

    const { data: checkpoint } = await svc
      .from('sync_checkpoints')
      .select('cursor')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .single();
    expect(checkpoint!.cursor).toBe('promotion-complete');

    const { data: attempts } = await svc
      .from('sync_attempts')
      .select('state, promoted_at')
      .eq('connection_id', SEED.connections.plaidAlpha.id);
    expect(attempts!.some((attempt) => attempt.state === 'abandoned')).toBe(true);
    expect(
      attempts!.some((attempt) => attempt.state === 'completed' && attempt.promoted_at !== null),
    ).toBe(true);

    const { data: pages } = await svc
      .from('raw_provider_events')
      .select('body_text, body_sha256')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .eq('account_external_ref', 'item-page');
    expect(pages).toHaveLength(4);
    for (const page of pages ?? []) {
      expect(page.body_sha256).toBe(
        createHash('sha256').update(page.body_text as string).digest('hex'),
      );
    }
    expect(
      pages!.some((page) =>
        page.body_text!.includes('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'),
      ),
    ).toBe(true);

    const { data: normalized } = await svc
      .from('normalized_source_records')
      .select('kind, provider_transaction_id, amount_minor, account_id')
      .in('provider_transaction_id', ['txn-pending-meal', 'txn-posted-meal'])
      .order('created_at');
    expect(normalized).toHaveLength(3);
    expect(normalized!.map((row) => row.kind).sort()).toEqual(['added', 'added', 'removed']);
    expect(normalized!.find((row) => row.kind === 'removed')).toMatchObject({
      amount_minor: null,
      account_id: null,
    });
    const postedNormalized = normalized!.find(
      (row) => row.provider_transaction_id === 'txn-posted-meal',
    );
    expect(postedNormalized!.account_id).toBe(plaidAccountId);
    expect(BigInt(postedNormalized!.amount_minor)).toBe(-5218n);

    const economicKey = `txn:plaid:${SEED.connections.plaidAlpha.ref}:txn-pending-meal`;
    const { data: canonicals } = await svc
      .from('canonical_transactions')
      .select('id, status, description, economic_event_key')
      .eq('economic_event_key', economicKey);
    expect(canonicals).toEqual([
      expect.objectContaining({ status: 'posted', description: 'Dinner Place' }),
    ]);
    const { data: batches } = await svc
      .from('journal_batches')
      .select('id')
      .eq('canonical_transaction_id', canonicals![0]!.id);
    expect(batches).toHaveLength(3);
    const { data: postings } = await svc
      .from('journal_postings')
      .select('amount_minor')
      .in('batch_id', batches!.map((batch) => batch.id))
      .eq('ledger_account_id', plaidLedgerAccountId);
    expect(postings!.reduce((sum, posting) => sum + BigInt(posting.amount_minor), 0n)).toBe(
      -5218n,
    );
  });

  it('re-pulls from the committed cursor as an economic no-op', async () => {
    const svc = serviceClient();
    const canonical = await svc
      .from('canonical_transactions')
      .select('id')
      .eq('account_id', plaidAccountId)
      .single();
    const counts = async (): Promise<Array<number | null>> => {
      const results = await Promise.all([
        svc.from('canonical_transactions').select('*', { count: 'exact', head: true })
          .eq('account_id', plaidAccountId),
        svc.from('normalized_source_records').select('*', { count: 'exact', head: true })
          .eq('account_id', plaidAccountId),
        svc.from('journal_batches').select('*', { count: 'exact', head: true })
          .eq('canonical_transaction_id', canonical.data!.id),
      ]);
      return results.map((result) => result.count);
    };
    const before = await counts();

    await enqueueNotification(`itest:c5b:replay:${crypto.randomUUID()}`);
    const outcomes = await drainQueue('sync_events');
    expect(outcomes.some((outcome) => outcome.startsWith('done:sync complete'))).toBe(true);

    const { data: checkpoint } = await svc
      .from('sync_checkpoints')
      .select('cursor')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .single();
    expect(checkpoint!.cursor).toBe('promotion-complete');
    expect(await counts()).toEqual(before);
  });
});
