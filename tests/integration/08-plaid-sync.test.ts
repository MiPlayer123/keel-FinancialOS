/**
 * C5b: deterministic Plaid /transactions/sync pull through the real worker.
 * Injected pages exercise mutation restart, pending-to-posted supersession,
 * cursor advancement, balanced promotion, and replay idempotency.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { drainQueue, serviceClient, SEED, signIn } from './helpers.js';

const ECONOMIC_KEY = `txn:plaid:${SEED.connections.plaidC5b.ref}:txn-pending-meal`;
let finalInjectedBodyText = '';

const page = (body: unknown): { connection_id: string; page_index: number; body_text: string } => ({
  connection_id: SEED.connections.plaidC5b.id,
  page_index: 0,
  body_text: JSON.stringify(body),
});

const pendingTransaction = {
  transaction_id: 'txn-pending-meal',
  account_id: 'acct-checking',
  amount: '52.18',
  iso_currency_code: 'USD',
  date: '2026-07-04',
  name: 'Dinner Place',
  pending: true,
  pending_transaction_id: null,
};

const recordNotification = async (suffix: string): Promise<void> => {
  const svc = serviceClient();
  const { error } = await svc.rpc('keel_worker_record_raw_event', {
    p_provider: 'plaid',
    p_connection_external_ref: SEED.connections.plaidC5b.ref,
    p_provider_event_id: `c5b-sync-notification-${suffix}`,
    p_account_external_ref: 'item-notification',
    p_body: {
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: SEED.connections.plaidC5b.ref,
    },
    p_received_at: '2026-07-11T13:30:00Z',
  });
  if (error) throw new Error(`notification record failed: ${error.message}`);
};

const recordDisabledNotification = async (): Promise<void> => {
  const { error } = await serviceClient().rpc('keel_worker_record_raw_event', {
    p_provider: 'plaid',
    p_connection_external_ref: SEED.connections.plaidAlpha.ref,
    p_provider_event_id: `c5c-disabled-${crypto.randomUUID()}`,
    p_account_external_ref: 'item-notification',
    p_body: {
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: SEED.connections.plaidAlpha.ref,
    },
    p_received_at: '2026-07-11T15:50:00Z',
  });
  if (error) throw new Error(`disabled notification record failed: ${error.message}`);
};

const economicCounts = async (): Promise<{
  canonical: number;
  batches: number;
  postings: number;
}> => {
  const svc = serviceClient();
  const { data: canonical, error } = await svc
    .from('canonical_transactions')
    .select('id')
    .eq('economic_event_key', ECONOMIC_KEY);
  if (error) throw new Error(error.message);
  const txnIds = canonical.map((row) => row.id);
  if (txnIds.length === 0) return { canonical: 0, batches: 0, postings: 0 };

  const { data: batches, error: batchError } = await svc
    .from('journal_batches')
    .select('id')
    .in('canonical_transaction_id', txnIds);
  if (batchError) throw new Error(batchError.message);
  const batchIds = batches.map((row) => row.id);
  const { count: postingCount, error: postingError } =
    batchIds.length === 0
      ? { count: 0, error: null }
      : await svc
          .from('journal_postings')
          .select('*', { count: 'exact', head: true })
          .in('batch_id', batchIds);
  if (postingError) throw new Error(postingError.message);

  return {
    canonical: txnIds.length,
    batches: batchIds.length,
    postings: postingCount ?? 0,
  };
};

beforeAll(async () => {
  const alex = await signIn(SEED.users.alex.email);
  const { error: accountError } = await alex.rpc('keel_cmd_create_account', {
    p_command_id: '00000000-0000-4000-8000-00000000c5b1',
    p_economic_event_key: 'itest:c5b:plaid-checking-account',
    p_actor: { kind: 'user', userId: SEED.users.alex.id },
    p_household_id: SEED.households.alpha,
    p_payload: {
      entity_id: SEED.entities.alphaPersonal,
      connection_id: SEED.connections.plaidC5b.id,
      name: 'Plaid Checking',
      kind: 'asset',
      subtype: 'checking',
      currency: 'USD',
      external_ref: 'acct-checking',
    },
  });
  if (accountError) throw new Error(`account create failed: ${accountError.message}`);

  const pages = [
    page({
      added: [pendingTransaction],
      modified: [],
      removed: [],
      next_cursor: 'c1',
      has_more: true,
      request_id: 'req-before-mutation',
    }),
    page({ error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' }),
    page({
      added: [pendingTransaction],
      modified: [],
      removed: [],
      next_cursor: 'c1',
      has_more: true,
      request_id: 'req-after-restart-1',
    }),
    page({
      added: [
        {
          ...pendingTransaction,
          transaction_id: 'txn-posted-meal',
          date: '2026-07-05',
          pending: false,
          pending_transaction_id: 'txn-pending-meal',
        },
      ],
      modified: [],
      removed: [{ transaction_id: 'txn-pending-meal' }],
      next_cursor: 'promotion-complete',
      has_more: false,
      request_id: 'req-after-restart-2',
    }),
  ].map((row, pageIndex) => ({ ...row, page_index: pageIndex }));
  finalInjectedBodyText = pages[3]!.body_text;

  const svc = serviceClient();
  const { error: deleteError } = await svc
    .from('sync_test_pages')
    .delete()
    .eq('connection_id', SEED.connections.plaidC5b.id);
  if (deleteError) throw new Error(deleteError.message);
  const { error: insertError } = await svc.from('sync_test_pages').insert(pages);
  if (insertError) throw new Error(insertError.message);
});

describe('Plaid sync worker (C5b)', () => {
  it('recovers from mutation restart, promotes pending to posted, advances the cursor, and replays as a no-op', async () => {
    const svc = serviceClient();
    await recordNotification('first');
    // Drain to empty. Correctness is asserted on the resulting LEDGER STATE
    // below (canonical/attempts/cursor/postings) — the authoritative truth —
    // not on worker log strings, which race with drain timing.
    const outcomes = await drainQueue('sync_events');
    expect(outcomes.every((outcome) => !outcome.startsWith('dead_letter:'))).toBe(true);
    const { data: depth } = await svc.rpc('keel_worker_queue_depth', { p_queue: 'sync_events' });
    expect(Number(depth)).toBe(0);

    const { data: canonical, error: canonicalError } = await svc
      .from('canonical_transactions')
      .select('id, account_id, status, description')
      .eq('economic_event_key', ECONOMIC_KEY);
    if (canonicalError) throw new Error(canonicalError.message);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ status: 'posted', description: 'Dinner Place' });

    const { count: restartPages, error: restartPageError } = await svc
      .from('raw_provider_events')
      .select('*', { count: 'exact', head: true })
      .eq('connection_id', SEED.connections.plaidC5b.id)
      .eq('body->>error_code', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    if (restartPageError) throw new Error(restartPageError.message);
    expect(restartPages).toBeGreaterThanOrEqual(1);

    const { data: archivedFinal, error: archivedFinalError } = await svc
      .from('raw_provider_events')
      .select('body_text')
      .eq('connection_id', SEED.connections.plaidC5b.id)
      .eq('body->>request_id', 'req-after-restart-2')
      .order('received_at', { ascending: false })
      .limit(1)
      .single();
    if (archivedFinalError) throw new Error(archivedFinalError.message);
    expect(archivedFinal.body_text).toBe(finalInjectedBodyText);

    const { count: abandoned, error: abandonedError } = await svc
      .from('sync_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('connection_id', SEED.connections.plaidC5b.id)
      .eq('state', 'abandoned');
    if (abandonedError) throw new Error(abandonedError.message);
    expect(abandoned).toBeGreaterThanOrEqual(1);
    const { count: completed, error: completedError } = await svc
      .from('sync_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('connection_id', SEED.connections.plaidC5b.id)
      .eq('state', 'completed')
      .not('promoted_at', 'is', null);
    if (completedError) throw new Error(completedError.message);
    expect(completed).toBeGreaterThanOrEqual(1);

    const { data: checkpoint } = await svc
      .from('sync_checkpoints')
      .select('cursor')
      .eq('connection_id', SEED.connections.plaidC5b.id)
      .single();
    expect(checkpoint?.cursor).toBe('promotion-complete');

    const { data: account, error: accountError } = await svc
      .from('accounts')
      .select('ledger_account_id')
      .eq('id', canonical[0]!.account_id)
      .single();
    if (accountError) throw new Error(accountError.message);
    const { data: batches, error: batchError } = await svc
      .from('journal_batches')
      .select('id')
      .eq('canonical_transaction_id', canonical[0]!.id);
    if (batchError) throw new Error(batchError.message);
    const { data: accountPostings, error: postingError } = await svc
      .from('journal_postings')
      .select('amount_minor')
      .in(
        'batch_id',
        batches.map((row) => row.id),
      )
      .eq('ledger_account_id', account.ledger_account_id);
    if (postingError) throw new Error(postingError.message);
    const accountSum = accountPostings.reduce(
      (sum, posting) => sum + BigInt(posting.amount_minor),
      0n,
    );
    expect(accountSum).toBe(-5218n);

    const beforeReplay = await economicCounts();
    await recordNotification('second');
    const replayOutcomes = await drainQueue('sync_events');
    expect(replayOutcomes.every((outcome) => !outcome.startsWith('dead_letter:'))).toBe(true);
    // The authoritative no-op proof: economic counts are unchanged.
    expect(await economicCounts()).toEqual(beforeReplay);
    const { data: replayDepth } = await svc.rpc('keel_worker_queue_depth', {
      p_queue: 'sync_events',
    });
    expect(Number(replayDepth)).toBe(0);
  });

  it('C5c completes an uninjected disabled sync as a no-op without freshness or dead-letter', async () => {
    const svc = serviceClient();
    const { data: before, error: beforeError } = await svc
      .from('connections')
      .select('last_successful_sync_at')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    if (beforeError) throw new Error(beforeError.message);
    const { data: checkpointBefore, error: checkpointBeforeError } = await svc
      .from('sync_checkpoints')
      .select('cursor')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .maybeSingle();
    if (checkpointBeforeError) throw new Error(checkpointBeforeError.message);

    await recordDisabledNotification();
    const outcomes = await drainQueue('sync_events');
    expect(outcomes.every((outcome) => !outcome.startsWith('dead_letter:'))).toBe(true);

    const { data: after, error: afterError } = await svc
      .from('connections')
      .select('last_successful_sync_at, sync_lease_owner, sync_leased_until')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    if (afterError) throw new Error(afterError.message);
    expect(after.last_successful_sync_at).toBe(before.last_successful_sync_at);
    expect(after.sync_lease_owner).toBeNull();
    expect(after.sync_leased_until).toBeNull();

    const { data: checkpointAfter, error: checkpointAfterError } = await svc
      .from('sync_checkpoints')
      .select('cursor')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .maybeSingle();
    if (checkpointAfterError) throw new Error(checkpointAfterError.message);
    expect(checkpointAfter?.cursor ?? '').toBe(checkpointBefore?.cursor ?? '');

    const { count: completedNoops, error: attemptError } = await svc
      .from('sync_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .eq('state', 'completed')
      .not('promoted_at', 'is', null);
    if (attemptError) throw new Error(attemptError.message);
    expect(completedNoops).toBeGreaterThanOrEqual(1);
  });
});
