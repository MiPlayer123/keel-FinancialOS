import { describe, it, vi } from 'vitest';
import type { LiveSyncOptions, LiveSyncResult } from '../../_shared/plaid-sync.ts';

vi.stubGlobal('Deno', { env: { get: (_name: string): string | undefined => undefined } });
const { processSyncNotification } = await import('../index.ts');

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};

const syncMessage = (economicEventKey: string) => ({
  msg_id: 1,
  read_ct: 1,
  message: {
    jobType: 'sync_notification',
    economicEventKey,
    refs: { connectionId: 'connection-live' },
  },
});

const pageBody = (
  nextCursor: string,
  hasMore: boolean,
  transactions: Array<{ id: string; amount: string }> = [],
): string => JSON.stringify({
  added: transactions.map((transaction) => ({
    transaction_id: transaction.id,
    account_id: 'account-external',
    amount: transaction.amount,
    iso_currency_code: 'USD',
    date: '2026-07-11',
    name: `Transaction ${transaction.id}`,
    pending: false,
    pending_transaction_id: null,
  })),
  modified: [],
  removed: [],
  next_cursor: nextCursor,
  has_more: hasMore,
  request_id: `request-${nextCursor}`,
});

const queryFor = (
  table: string,
  connectionGeneration: () => { committed: number; desired: number } = () => ({
    committed: 0,
    desired: 0,
  }),
) => {
  const query = {
    select: () => query,
    eq: () => query,
    single: async () => {
      if (table === 'connections') {
        const generation = connectionGeneration();
        return {
          data: {
            external_ref: 'plaid-item-live',
            provider: 'plaid',
            sync_committed_generation: generation.committed,
            sync_desired_generation: generation.desired,
          },
          error: null,
        };
      }
      if (table === 'accounts') return { data: { id: 'account-id' }, error: null };
      throw new Error(`unexpected single query for ${table}`);
    },
  };
  return query;
};

describe('C5c worker durable sync orchestration', () => {
  it('partial then terminal pass commits health only at terminal and renews during promotion', async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const enqueued: Array<Record<string, unknown>> = [];
    const completions: Array<Record<string, unknown>> = [];
    let desiredGeneration = 0;
    let committedGeneration = 0;
    let attempt = 0;
    let normalized = 0;
    let lastSuccessfulSyncAt: string | null = null;
    const admin = {
      from: (table: string) => queryFor(table, () => ({
        committed: committedGeneration,
        desired: desiredGeneration,
      })),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'keel_worker_bump_generation') {
          desiredGeneration += 1;
          return { data: null, error: null };
        }
        if (name === 'keel_worker_acquire_sync_lease') {
          return { data: { acquired: true, baseCursor: committedGeneration === 0 ? '' : 'cursor-1' }, error: null };
        }
        if (name === 'keel_worker_open_attempt') {
          attempt += 1;
          return { data: `attempt-${attempt}`, error: null };
        }
        if (name === 'keel_worker_renew_sync_lease') return { data: true, error: null };
        if (name === 'keel_worker_archive_page') return { data: crypto.randomUUID(), error: null };
        if (name === 'keel_worker_lookup_state') return { data: [], error: null };
        if (name === 'keel_worker_create_normalized') {
          normalized += 1;
          return { data: `normalized-${normalized}`, error: null };
        }
        if (name === 'keel_worker_apply_action') return { data: {}, error: null };
        if (name === 'keel_worker_complete_attempt') {
          completions.push(args);
          committedGeneration = desiredGeneration;
          if (args['p_fully_synced'] === true) {
            lastSuccessfulSyncAt = '2026-07-11T12:00:00Z';
          }
          return { data: { completed: true }, error: null };
        }
        if (name === 'keel_enqueue') {
          enqueued.push(args);
          return { data: 42, error: null };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const results: LiveSyncResult[] = [
      {
        source: 'live',
        status: 'partial',
        pages: [{
          pageIndex: 0,
          bodyText: pageBody('cursor-1', true, [
            { id: 'transaction-1', amount: '10.01' },
            { id: 'transaction-2', amount: '20.02' },
          ]),
        }],
        hasMore: true,
        nextCursor: 'cursor-1',
      },
      {
        source: 'live',
        status: 'terminal',
        pages: [{ pageIndex: 0, bodyText: pageBody('cursor-2', false) }],
        hasMore: false,
        nextCursor: 'cursor-2',
      },
    ];
    const readPages = async (
      _admin: unknown,
      _connectionId: string,
      _options: LiveSyncOptions,
    ): Promise<LiveSyncResult> => results.shift()!;

    const partial = await processSyncNotification(admin, syncMessage('notification-first'), readPages);
    assertEquals(partial, { ok: true, detail: 'live sync continuation enqueued' });
    assertEquals(completions[0]?.['p_fully_synced'], false);
    assertEquals(lastSuccessfulSyncAt, null);
    assertEquals(enqueued, [{
      queue_name: 'sync_events',
      message: {
        jobType: 'sync_notification',
        economicEventKey: 'plaid:sync-continuation:attempt-1',
        refs: { connectionId: 'connection-live' },
      },
    }]);

    const promotionRpcs = rpcCalls.map((call) => call.name);
    const createIndexes = promotionRpcs
      .map((name, index) => name === 'keel_worker_create_normalized' ? index : -1)
      .filter((index) => index >= 0);
    assertEquals(createIndexes.length, 2);
    for (const createIndex of createIndexes) {
      assertEquals(promotionRpcs[createIndex - 1], 'keel_worker_renew_sync_lease');
    }
    const firstComplete = promotionRpcs.indexOf('keel_worker_complete_attempt');
    assertEquals(promotionRpcs[firstComplete - 1], 'keel_worker_renew_sync_lease');
    const leaseOwner = rpcCalls.find((call) => call.name === 'keel_worker_acquire_sync_lease')
      ?.args['p_owner'];
    for (const renewal of rpcCalls.filter((call) => call.name === 'keel_worker_renew_sync_lease')) {
      assertEquals(renewal.args['p_owner'], leaseOwner, 'lease renewal must remain owner-fenced');
    }

    const terminal = await processSyncNotification(
      admin,
      syncMessage('plaid:sync-continuation:attempt-1'),
      readPages,
    );
    assertEquals(terminal, { ok: true, detail: 'sync complete' });
    assertEquals(completions[1]?.['p_fully_synced'], true);
    assert(lastSuccessfulSyncAt !== null, 'terminal pass must set sync health');
    assertEquals(enqueued.length, 1, 'terminal pass must not enqueue another notification');
  });

  it('disabled branch failure abandons and releases the owner-fenced attempt', async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = {
      from: (table: string) => queryFor(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'keel_worker_bump_generation') return { data: null, error: null };
        if (name === 'keel_worker_acquire_sync_lease') {
          return { data: { acquired: true, baseCursor: 'disabled-cursor' }, error: null };
        }
        if (name === 'keel_worker_open_attempt') return { data: 'attempt-disabled', error: null };
        if (name === 'keel_worker_lookup_state') {
          return { data: null, error: { message: 'state unavailable' } };
        }
        if (name === 'keel_worker_abandon_and_release') return { data: null, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const readPages = async (): Promise<LiveSyncResult> => ({
      source: 'disabled',
      status: 'noop',
      pages: [],
      hasMore: false,
      nextCursor: 'disabled-cursor',
    });

    const outcome = await processSyncNotification(
      admin,
      syncMessage('notification-disabled'),
      readPages,
    );
    assertEquals(outcome, { ok: false, retry: true, detail: 'state lookup failed: state unavailable' });
    assertEquals(rpcCalls.filter((call) => call.name === 'keel_worker_abandon_and_release'), [{
      name: 'keel_worker_abandon_and_release',
      args: { p_attempt_id: 'attempt-disabled', p_owner: rpcCalls[1]?.args['p_owner'] },
    }]);
  });
});
