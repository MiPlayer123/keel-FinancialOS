import { describe, it, vi } from 'vitest';
import {
  PlaidSyncTransientError,
  type LiveSyncOptions,
  type LiveSyncResult,
} from '../../_shared/plaid-sync.ts';

vi.stubGlobal('Deno', { env: { get: (_name: string): string | undefined => undefined } });
const { orderQueueMessages, processSyncNotification } = await import('../index.ts');

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

const leaseRefusalAdmin = (reason: string) => ({
  from: (table: string) => queryFor(table),
  rpc: async (name: string) => {
    if (name === 'keel_worker_bump_generation') return { data: null, error: null };
    if (name === 'keel_worker_acquire_sync_lease') {
      return { data: { acquired: false, reason }, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  },
});

describe('worker queue ordering', () => {
  it('dispatches a claimed batch in monotonic pgmq message order', () => {
    const message = (msgId: number) => ({ ...syncMessage(`message-${msgId}`), msg_id: msgId });
    assertEquals(
      orderQueueMessages([message(30), message(10), message(20)]).map((item) => item.msg_id),
      [10, 20, 30],
    );
  });
});

const pageBody = (
  nextCursor: string,
  hasMore: boolean,
  transactions: Array<{ id: string; amount: string }> = [],
): string =>
  JSON.stringify({
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
            household_id: 'household-live',
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
  it('archives disconnected notifications and bounds other terminal lease refusals', async () => {
    const readPages = async (): Promise<LiveSyncResult> => {
      throw new Error('lease refusal must not read Plaid pages');
    };
    assertEquals(
      await processSyncNotification(
        leaseRefusalAdmin('disconnected'),
        syncMessage('notification-disconnected'),
        readPages,
      ),
      { ok: true, detail: 'connection disconnected; notification dropped' },
    );
    for (const reason of ['reauth_required', 'disconnecting']) {
      assertEquals(
        await processSyncNotification(
          leaseRefusalAdmin(reason),
          syncMessage(`notification-${reason}`),
          readPages,
        ),
        { ok: false, detail: `sync lease unavailable: ${reason}` },
      );
    }
  });

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
      from: (table: string) =>
        queryFor(table, () => ({
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
          return {
            data: { acquired: true, baseCursor: committedGeneration === 0 ? '' : 'cursor-1' },
            error: null,
          };
        }
        if (name === 'keel_worker_open_attempt') {
          attempt += 1;
          return { data: `attempt-${attempt}`, error: null };
        }
        if (name === 'keel_worker_renew_sync_lease') return { data: true, error: null };
        if (name === 'keel_worker_archive_page') {
          return { data: `00000000-0000-4000-8000-00000000000${attempt}`, error: null };
        }
        if (name === 'keel_worker_lookup_state') return { data: [], error: null };
        if (name === 'keel_worker_create_normalized') {
          normalized += 1;
          return { data: `normalized-${normalized}`, error: null };
        }
        if (name === 'keel_worker_apply_action') return { data: {}, error: null };
        if (name === 'keel_reconcile_regular_core_sweeps') {
          return {
            data: { suppressed: 0, candidatesConsidered: 0, ambiguousSkipped: 0, allowlisted: false },
            error: null,
          };
        }
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
        pages: [
          {
            pageIndex: 0,
            bodyText: pageBody('cursor-1', true, [
              { id: 'transaction-1', amount: '10.01' },
              { id: 'transaction-2', amount: '20.02' },
            ]),
          },
        ],
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

    const partial = await processSyncNotification(
      admin,
      syncMessage('notification-first'),
      readPages,
    );
    assertEquals(partial, { ok: true, detail: 'live sync continuation enqueued' });
    assertEquals(completions[0]?.['p_fully_synced'], false);
    assertEquals(lastSuccessfulSyncAt, null);
    assertEquals(enqueued, [
      {
        queue_name: 'sync_events',
        message: {
          jobType: 'sync_notification',
          economicEventKey: 'plaid:sync-continuation:attempt-1',
          refs: { connectionId: 'connection-live' },
        },
      },
    ]);

    const promotionRpcs = rpcCalls.map((call) => call.name);
    const createIndexes = promotionRpcs
      .map((name, index) => (name === 'keel_worker_create_normalized' ? index : -1))
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
    const normalizedCalls = rpcCalls.filter(
      (call) => call.name === 'keel_worker_create_normalized',
    );
    assertEquals(
      normalizedCalls.map((call) => call.args['p_pending']),
      [false, false],
    );
    assertEquals(
      normalizedCalls.map((call) => call.args['p_raw_event_id']),
      ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
    );

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
    assertEquals(outcome, {
      ok: false,
      retry: true,
      detail: 'state lookup failed: state unavailable',
    });
    assertEquals(
      rpcCalls.filter((call) => call.name === 'keel_worker_abandon_and_release'),
      [
        {
          name: 'keel_worker_abandon_and_release',
          args: { p_attempt_id: 'attempt-disabled', p_owner: rpcCalls[1]?.args['p_owner'] },
        },
      ],
    );
  });

  it('abandons a live login failure before setting reauth and does not retry it as transient', async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = {
      from: (table: string) => queryFor(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'keel_worker_bump_generation') return { data: null, error: null };
        if (name === 'keel_worker_acquire_sync_lease') {
          return { data: { acquired: true, baseCursor: 'reauth-cursor' }, error: null };
        }
        if (name === 'keel_worker_open_attempt') return { data: 'attempt-reauth', error: null };
        if (name === 'keel_worker_abandon_and_release') return { data: null, error: null };
        if (name === 'keel_set_connection_reauth') return { data: null, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const failure = Object.assign(new PlaidSyncTransientError('http'), {
      errorCode: 'ITEM_LOGIN_REQUIRED',
      reauthCode: 'ITEM_LOGIN_REQUIRED',
    });
    const readPages = async (): Promise<LiveSyncResult> => {
      throw failure;
    };

    const outcome = await processSyncNotification(
      admin,
      syncMessage('notification-reauth'),
      readPages,
    );

    assertEquals(outcome, {
      ok: false,
      detail: 'Plaid sync requires reauthentication (ITEM_LOGIN_REQUIRED)',
    });
    const cleanupIndex = rpcCalls.findIndex((call) => call.name === 'keel_worker_abandon_and_release');
    const reauthIndex = rpcCalls.findIndex((call) => call.name === 'keel_set_connection_reauth');
    assert(cleanupIndex >= 0, 'reauth failure must abandon the attempt');
    assert(reauthIndex > cleanupIndex, 'attempt cleanup must precede reauth transition');
    assertEquals(rpcCalls[reauthIndex]?.args, {
      p_connection_id: 'connection-live',
      p_event_type: 'ITEM_LOGIN_REQUIRED',
      p_required: true,
    });
    assertEquals(
      rpcCalls.filter((call) =>
        call.name === 'keel_worker_complete_attempt' || call.name === 'keel_worker_apply_action'
      ).length,
      0,
    );
  });

  it('abandons an ordinary live transient without setting reauth', async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = {
      from: (table: string) => queryFor(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'keel_worker_bump_generation') return { data: null, error: null };
        if (name === 'keel_worker_acquire_sync_lease') {
          return { data: { acquired: true, baseCursor: 'transient-cursor' }, error: null };
        }
        if (name === 'keel_worker_open_attempt') return { data: 'attempt-transient', error: null };
        if (name === 'keel_worker_abandon_and_release') return { data: null, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const readPages = async (): Promise<LiveSyncResult> => {
      throw new PlaidSyncTransientError('network');
    };

    assertEquals(
      await processSyncNotification(admin, syncMessage('notification-transient'), readPages),
      { ok: false, retry: true, detail: 'Plaid sync request failed (network)' },
    );
    assertEquals(
      rpcCalls.filter((call) => call.name === 'keel_set_connection_reauth').length,
      0,
    );
  });

  it('durably records a CAD skip against its exact raw page without normalization', async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let desiredGeneration = 0;
    const rawPageId = '00000000-0000-4000-8000-00000000cad1';
    const admin = {
      from: (table: string) =>
        queryFor(table, () => ({
          committed: 0,
          desired: desiredGeneration,
        })),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'keel_worker_bump_generation') {
          desiredGeneration = 1;
          return { data: null, error: null };
        }
        if (name === 'keel_worker_acquire_sync_lease') {
          return { data: { acquired: true, baseCursor: '' }, error: null };
        }
        if (name === 'keel_worker_open_attempt') return { data: 'attempt-cad', error: null };
        if (name === 'keel_worker_renew_sync_lease') return { data: true, error: null };
        if (name === 'keel_worker_archive_page') return { data: rawPageId, error: null };
        if (name === 'keel_worker_record_ingestion_skip') return { data: null, error: null };
        if (name === 'keel_worker_lookup_state') return { data: [], error: null };
        if (name === 'keel_reconcile_regular_core_sweeps') {
          return {
            data: { suppressed: 0, candidatesConsidered: 0, ambiguousSkipped: 0, allowlisted: false },
            error: null,
          };
        }
        if (name === 'keel_worker_complete_attempt') return { data: {}, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const readPages = async (): Promise<LiveSyncResult> => ({
      source: 'live',
      status: 'terminal',
      pages: [
        {
          pageIndex: 0,
          bodyText: JSON.stringify({
            added: [
              {
                transaction_id: 'transaction-cad',
                account_id: 'account-external',
                amount: '12.34',
                iso_currency_code: 'CAD',
                date: '2026-07-11',
                name: 'Canadian purchase',
                pending: false,
                pending_transaction_id: null,
              },
            ],
            modified: [],
            removed: [],
            next_cursor: 'cursor-cad',
            has_more: false,
            request_id: 'request-cad',
          }),
        },
      ],
      hasMore: false,
      nextCursor: 'cursor-cad',
    });

    assertEquals(await processSyncNotification(admin, syncMessage('notification-cad'), readPages), {
      ok: true,
      detail: 'sync complete',
    });
    assertEquals(
      rpcCalls.filter((call) => call.name === 'keel_worker_record_ingestion_skip'),
      [
        {
          name: 'keel_worker_record_ingestion_skip',
          args: {
            p_raw_event_id: rawPageId,
            p_provider_transaction_id: 'transaction-cad',
            p_currency: 'CAD',
            p_reason: 'non_usd',
          },
        },
      ],
    );
    assertEquals(
      rpcCalls.filter((call) => call.name === 'keel_worker_create_normalized').length,
      0,
    );
  });
});
