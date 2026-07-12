import { encryptToken } from './credential-crypto.ts';
import * as PlaidSync from './plaid-sync.ts';

type SyncStatus = 'terminal' | 'partial' | 'noop';
type SyncSource = 'injected' | 'live' | 'disabled';
type SyncResult = {
  source: SyncSource;
  status: SyncStatus;
  pages: Array<{ pageIndex: number; bodyText: string }>;
  hasMore: boolean;
  nextCursor: string;
};
type PlaidPost = (path: string, body: Record<string, unknown>) => Promise<Response>;
type LiveOptions = {
  baseCursor: string;
  externalRef: string;
  maxPages: number;
  plaidPost?: PlaidPost;
  renewLease: () => Promise<void>;
};

const subject = PlaidSync as unknown as {
  fetchSyncPagesLive: (
    admin: unknown,
    connectionId: string,
    opts: LiveOptions,
  ) => Promise<SyncResult>;
  readSyncPages: (
    admin: unknown,
    connectionId: string,
    opts: LiveOptions,
  ) => Promise<SyncResult>;
};

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

const assertRejects = async (
  operation: () => Promise<unknown>,
  check: (error: Error) => void,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error, 'rejection must be an Error');
    check(error);
    return;
  }
  throw new Error('expected operation to reject');
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const randomKek = (): string => toBase64(crypto.getRandomValues(new Uint8Array(32)));

const response = (
  nextCursor: string,
  hasMore: boolean,
  requestId: string,
  raw?: string,
): Response =>
  new Response(
    raw ?? JSON.stringify({
      added: [],
      modified: [],
      removed: [],
      next_cursor: nextCursor,
      has_more: hasMore,
      request_id: requestId,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const liveOptions = (
  plaidPost?: PlaidPost,
  overrides: Partial<LiveOptions> = {},
): LiveOptions => ({
  baseCursor: '',
  externalRef: 'sandbox-item-test',
  maxPages: 5,
  plaidPost,
  renewLease: async () => {},
  ...overrides,
});

const configureLiveEnv = (kek: string): void => {
  Deno.env.set('KEEL_LIVE_SYNC_ENABLED', 'true');
  Deno.env.set('PLAID_ENV', 'sandbox');
  Deno.env.set('PLAID_CLIENT_ID', 'client-id-test');
  Deno.env.set('PLAID_SECRET', 'secret-test');
  Deno.env.set('KEEL_CREDENTIAL_KEK_VERSION', '1');
  Deno.env.set('KEEL_CREDENTIAL_KEK', kek);
};

const clearLiveEnv = (): void => {
  for (const name of [
    'KEEL_LIVE_SYNC_ENABLED',
    'PLAID_ENV',
    'PLAID_CLIENT_ID',
    'PLAID_SECRET',
    'KEEL_CREDENTIAL_KEK_VERSION',
    'KEEL_CREDENTIAL_KEK',
  ]) {
    Deno.env.delete(name);
  }
};

const encryptedEnvelope = async (token = 'access-sandbox-live-token') => {
  const credentialId = crypto.randomUUID();
  const householdId = crypto.randomUUID();
  const kek = randomKek();
  configureLiveEnv(kek);
  const encrypted = await encryptToken(token, credentialId, householdId, 'plaid', kek, 1);
  return {
    token,
    envelope: { ...encrypted, credentialId, householdId, provider: 'plaid' },
  };
};

const rpcAdmin = (result: { data: unknown; error: unknown }) => ({
  rpc: async (name: string) => {
    assertEquals(name, 'keel_get_connection_credential_envelope');
    return result;
  },
});

Deno.test('C5c live Plaid sync source contract', async (test) => {
  await test.step('flag unset is a disabled no-op with zero RPC and fetch calls', async () => {
    clearLiveEnv();
    Deno.env.set('PLAID_ENV', 'sandbox');
    Deno.env.set('PLAID_CLIENT_ID', 'configured-client');
    Deno.env.set('PLAID_SECRET', 'configured-secret');
    let rpcCalls = 0;
    let fetchCalls = 0;
    const result = await subject.fetchSyncPagesLive(
      { rpc: async () => { rpcCalls += 1; return { data: null, error: null }; } },
      crypto.randomUUID(),
      liveOptions(async () => { fetchCalls += 1; return response('never', false, 'never'); }, {
        baseCursor: 'base-disabled',
      }),
    );
    assertEquals(result, {
      source: 'disabled',
      status: 'noop',
      pages: [],
      hasMore: false,
      nextCursor: 'base-disabled',
    });
    assertEquals({ rpcCalls, fetchCalls }, { rpcCalls: 0, fetchCalls: 0 });
    clearLiveEnv();
  });

  await test.step('injected rows win even when the live gate is enabled', async () => {
    configureLiveEnv(randomKek());
    let rpcCalls = 0;
    let fetchCalls = 0;
    const bodyText = '{ "added":[], "modified":[], "removed":[], "next_cursor":"i1", "has_more":false }';
    const admin = {
      from: (table: string) => {
        assertEquals(table, 'sync_test_pages');
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [{ page_index: 0, body_text: bodyText }],
                error: null,
              }),
            }),
          }),
        };
      },
      rpc: async () => { rpcCalls += 1; return { data: null, error: null }; },
    };
    const result = await subject.readSyncPages(
      admin,
      crypto.randomUUID(),
      liveOptions(async () => { fetchCalls += 1; return response('never', false, 'never'); }, {
        baseCursor: 'injected-base',
      }),
    );
    assertEquals(result, {
      source: 'injected',
      status: 'terminal',
      pages: [{ pageIndex: 0, bodyText }],
      hasMore: false,
      nextCursor: 'injected-base',
    });
    assertEquals({ rpcCalls, fetchCalls }, { rpcCalls: 1, fetchCalls: 0 });
    clearLiveEnv();
  });

  await test.step('null credential envelope is a no-op without a fetch', async () => {
    configureLiveEnv(randomKek());
    let fetchCalls = 0;
    const result = await subject.fetchSyncPagesLive(
      rpcAdmin({ data: null, error: null }),
      crypto.randomUUID(),
      liveOptions(async () => { fetchCalls += 1; return response('never', false, 'never'); }, {
        baseCursor: 'base-null-envelope',
      }),
    );
    assertEquals(result.status, 'noop');
    assertEquals(result.source, 'disabled');
    assertEquals(result.nextCursor, 'base-null-envelope');
    assertEquals(fetchCalls, 0);
    clearLiveEnv();
  });

  await test.step('open live-call budget is transient and performs zero fetches', async () => {
    const { envelope } = await encryptedEnvelope();
    const calls: string[] = [];
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      fetchCalls += 1;
      return Promise.resolve(response('never', false, 'never'));
    };
    try {
      await assertRejects(
        () => subject.fetchSyncPagesLive(
          {
            rpc: (name: string) => {
              calls.push(name);
              if (name === 'keel_get_connection_credential_envelope') {
                return Promise.resolve({ data: envelope, error: null });
              }
              if (name === 'keel_provider_budget_reserve') {
                return Promise.resolve({ data: false, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          },
          crypto.randomUUID(),
          liveOptions(),
        ),
        (error) => {
          assert(error instanceof PlaidSync.PlaidSyncTransientError);
          assertEquals((error as PlaidSync.PlaidSyncTransientError).kind, 'budget');
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearLiveEnv();
    }
    assertEquals(fetchCalls, 0);
    assertEquals(calls, [
      'keel_get_connection_credential_envelope',
      'keel_provider_budget_reserve',
      'keel_meter_provider_call',
    ]);
  });

  await test.step('credential RPC errors are transient failures', async () => {
    configureLiveEnv(randomKek());
    await assertRejects(
      () => subject.fetchSyncPagesLive(
        rpcAdmin({ data: null, error: { message: 'database detail must not escape' } }),
        crypto.randomUUID(),
        liveOptions(async () => response('never', false, 'never')),
      ),
      (error) => {
        assertEquals(error.name, 'PlaidSyncTransientError');
        assert(!error.message.includes('database detail'));
      },
    );
    clearLiveEnv();
  });

  await test.step('decrypts with plaid AAD, paginates raw bytes, and renews before each page', async () => {
    const { token, envelope } = await encryptedEnvelope();
    const order: string[] = [];
    const cursors: unknown[] = [];
    const rawFirst = '{\n  "added": [], "modified": [], "removed": [],\n  "next_cursor": "cursor-1", "has_more": true, "request_id": "raw-1"\n}';
    let call = 0;
    const result = await subject.fetchSyncPagesLive(
      rpcAdmin({ data: envelope, error: null }),
      crypto.randomUUID(),
      liveOptions(async (path, body) => {
        order.push('fetch');
        assertEquals(path, '/transactions/sync');
        assertEquals(body['access_token'], token);
        assertEquals(body['count'], 100);
        cursors.push(body['cursor']);
        call += 1;
        return call === 1 ? response('cursor-1', true, 'raw-1', rawFirst) : response('cursor-2', false, 'raw-2');
      }, {
        renewLease: async () => { order.push('renew'); },
      }),
    );
    assertEquals(order, ['renew', 'fetch', 'renew', 'fetch']);
    assertEquals(cursors, [undefined, 'cursor-1']);
    assertEquals(result.source, 'live');
    assertEquals(result.status, 'terminal');
    assertEquals(result.hasMore, false);
    assertEquals(result.nextCursor, 'cursor-2');
    assertEquals(result.pages[0]?.bodyText, rawFirst, 'response bytes must remain verbatim');
    assertEquals(result.pages.map((page) => page.pageIndex), [0, 1]);
    clearLiveEnv();
  });

  await test.step('control parsing never parses raw numeric amount tokens', async () => {
    const { envelope } = await encryptedEnvelope();
    const raw =
      '{"added":[{"amount":9007199254740993.99}],"modified":[],"removed":[],"next_cursor":"lossless-control","has_more":false,"request_id":"lossless"}';
    const originalParse = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (text === raw) throw new Error('raw Plaid body passed to JSON.parse');
      return originalParse(text, reviver);
    }) as typeof JSON.parse;
    try {
      const result = await subject.fetchSyncPagesLive(
        rpcAdmin({ data: envelope, error: null }),
        crypto.randomUUID(),
        liveOptions(async () => new Response(raw, { status: 200 })),
      );
      assertEquals(result.nextCursor, 'lossless-control');
      assertEquals(result.pages[0]?.bodyText, raw);
    } finally {
      JSON.parse = originalParse;
      clearLiveEnv();
    }
  });

  await test.step('has_more at maxPages returns a durable partial cursor', async () => {
    const { envelope } = await encryptedEnvelope();
    let call = 0;
    const result = await subject.fetchSyncPagesLive(
      rpcAdmin({ data: envelope, error: null }),
      crypto.randomUUID(),
      liveOptions(async () => {
        call += 1;
        return response(`cursor-${call}`, true, `partial-${call}`);
      }, { maxPages: 2 }),
    );
    assertEquals(result.status, 'partial');
    assertEquals(result.hasMore, true);
    assertEquals(result.nextCursor, 'cursor-2');
    assertEquals(result.pages.length, 2);
    clearLiveEnv();
  });

  await test.step('mutation restart discards dirty pages and keeps only the clean run', async () => {
    const { envelope } = await encryptedEnvelope();
    const requestedCursors: unknown[] = [];
    let call = 0;
    const result = await subject.fetchSyncPagesLive(
      rpcAdmin({ data: envelope, error: null }),
      crypto.randomUUID(),
      liveOptions(async (_path, body) => {
        requestedCursors.push(body['cursor']);
        call += 1;
        if (call === 1) return response('dirty-cursor', true, 'dirty');
        if (call === 2) {
          return new Response(JSON.stringify({
            error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
            error_type: 'INVALID_REQUEST',
            request_id: 'mutation',
          }), { status: 400 });
        }
        return response('clean-cursor', false, 'clean');
      }),
    );
    assertEquals(requestedCursors, [undefined, 'dirty-cursor', undefined]);
    assertEquals(result.pages.length, 1);
    assert(result.pages[0]?.bodyText.includes('clean'));
    assertEquals(result.nextCursor, 'clean-cursor');
    clearLiveEnv();
  });

  await test.step('mutation restart is bounded', async () => {
    const { token, envelope } = await encryptedEnvelope();
    let calls = 0;
    await assertRejects(
      () => subject.fetchSyncPagesLive(
        rpcAdmin({ data: envelope, error: null }),
        crypto.randomUUID(),
        liveOptions(async () => {
          calls += 1;
          return new Response(JSON.stringify({
            error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
            token_canary: token,
          }), { status: 400 });
        }),
      ),
      (error) => {
        assertEquals(error.name, 'PlaidSyncTransientError');
        assert(!error.message.includes(token));
      },
    );
    assertEquals(calls, 4);
    clearLiveEnv();
  });

  await test.step('non-2xx and network timeout throw typed sanitized errors', async () => {
    const { token, envelope } = await encryptedEnvelope();
    await assertRejects(
      () => subject.fetchSyncPagesLive(
        rpcAdmin({ data: envelope, error: null }),
        crypto.randomUUID(),
        liveOptions(async () => new Response(JSON.stringify({
          error_code: 'INTERNAL_SERVER_ERROR',
          leaked: token,
        }), { status: 503 })),
      ),
      (error) => {
        assertEquals(error.name, 'PlaidSyncTransientError');
        assertEquals(
          (error as PlaidSync.PlaidSyncTransientError & { reauthCode?: string | null })
            .reauthCode,
          null,
        );
        assert(!error.message.includes(token));
        assert(!error.message.includes('leaked'));
      },
    );
    await assertRejects(
      () => subject.fetchSyncPagesLive(
        rpcAdmin({ data: envelope, error: null }),
        crypto.randomUUID(),
        liveOptions(async () => { throw new DOMException(token, 'TimeoutError'); }),
      ),
      (error) => {
        assertEquals(error.name, 'PlaidSyncTransientError');
        assert(!error.message.includes(token));
      },
    );
    clearLiveEnv();
  });

  await test.step('recognized ITEM reauth failures expose only normalized reauth codes', async () => {
    const { token, envelope } = await encryptedEnvelope();
    for (const errorCode of ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION']) {
      await assertRejects(
        () => subject.fetchSyncPagesLive(
          rpcAdmin({ data: envelope, error: null }),
          crypto.randomUUID(),
          liveOptions(async () => new Response(JSON.stringify({
            error_type: 'ITEM_ERROR',
            error_code: errorCode,
            error_message: token,
            request_id: 'reauth-required-request',
          }), { status: 400 })),
        ),
        (error) => {
          assert(error instanceof PlaidSync.PlaidSyncTransientError);
          const typed = error as PlaidSync.PlaidSyncTransientError & {
            reauthCode?: string | null;
          };
          assertEquals(typed.kind, 'http');
          assertEquals(typed.errorCode, errorCode);
          assertEquals(typed.reauthCode, errorCode);
          assert(!typed.message.includes(token));
        },
      );
    }
    clearLiveEnv();
  });

  await test.step('has_more requires a non-empty advancing cursor', async () => {
    const { envelope } = await encryptedEnvelope();
    for (const nextCursor of ['', 'base-cursor']) {
      await assertRejects(
        () => subject.fetchSyncPagesLive(
          rpcAdmin({ data: envelope, error: null }),
          crypto.randomUUID(),
          liveOptions(async () => response(nextCursor, true, 'stalled'), {
            baseCursor: 'base-cursor',
          }),
        ),
        (error) => assertEquals(error.name, 'PlaidSyncTransientError'),
      );
    }
    clearLiveEnv();
  });

  await test.step('integration deny hook counts an attempted default fetch without networking', async () => {
    const { envelope } = await encryptedEnvelope();
    Deno.env.set('KEEL_PLAID_FETCH_DENY', 'true');
    Deno.env.set('KEEL_PLAID_FETCH_SPY', 'true');
    const captured: unknown[][] = [];
    let fetchCalls = 0;
    const originalWarn = console.warn;
    const originalFetch = globalThis.fetch;
    console.warn = (...args: unknown[]) => captured.push(args);
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('global fetch must be denied');
    }) as typeof fetch;
    try {
      await assertRejects(
        () => subject.fetchSyncPagesLive(
          {
            rpc: (name: string) => {
              if (name === 'keel_get_connection_credential_envelope') {
                return Promise.resolve({ data: envelope, error: null });
              }
              if (name === 'keel_provider_budget_reserve') {
                return Promise.resolve({ data: true, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          },
          crypto.randomUUID(),
          liveOptions(undefined),
        ),
        (error) => assertEquals(error.name, 'PlaidSyncTransientError'),
      );
      assertEquals(fetchCalls, 0);
      assert(JSON.stringify(captured).includes('KEEL_PLAID_SYNC_FETCH_ATTEMPT'));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      Deno.env.delete('KEEL_PLAID_FETCH_DENY');
      Deno.env.delete('KEEL_PLAID_FETCH_SPY');
      clearLiveEnv();
    }
  });

  await test.step('token is not returned or logged', async () => {
    const { token, envelope } = await encryptedEnvelope();
    const captured: unknown[][] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => captured.push(args);
    console.warn = (...args: unknown[]) => captured.push(args);
    console.error = (...args: unknown[]) => captured.push(args);
    try {
      const result = await subject.fetchSyncPagesLive(
        rpcAdmin({ data: envelope, error: null }),
        crypto.randomUUID(),
        liveOptions(async () => response('terminal', false, 'terminal')),
      );
      assert(!JSON.stringify(result).includes(token));
      assert(!JSON.stringify(captured).includes(token));
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      clearLiveEnv();
    }
  });
});
