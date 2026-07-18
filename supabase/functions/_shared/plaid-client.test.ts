import {
  createPlaidClient,
  PlaidClientError,
  ProviderBudgetExhaustedError,
} from './plaid-client.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

Deno.test('Plaid client preserves diagnostic rate-limit error codes', () => {
  const limitCodes = [
    'ACCOUNTS_LIMIT',
    'ACCOUNTS_BALANCE_GET_LIMIT',
    'ADDITION_LIMIT',
    'AUTH_LIMIT',
    'BALANCE_LIMIT',
    'CREDITS_EXHAUSTED',
    'IDENTITY_LIMIT',
    'INSTITUTIONS_GET_LIMIT',
    'INSTITUTIONS_GET_BY_ID_LIMIT',
    'INSTITUTION_RATE_LIMIT',
    'INVESTMENT_HOLDINGS_GET_LIMIT',
    'INVESTMENT_TRANSACTIONS_LIMIT',
    'ITEM_GET_LIMIT',
    'RATE_LIMIT',
    'TRANSACTIONS_LIMIT',
    'TRANSACTIONS_REFRESH_LIMIT',
    'TRANSACTIONS_SYNC_LIMIT',
    'TRIAL_CONNECTION_LIMIT',
  ];

  for (const errorCode of limitCodes) {
    const error = new PlaidClientError({
      error_code: errorCode,
      error_type: 'RATE_LIMIT_EXCEEDED',
      request_id: null,
    });
    assertEquals(error.errorCode, errorCode);
  }
});

Deno.test('C6 Plaid client meters and reserves at the network boundary', async (test) => {
  await test.step('construction rejects every env outside sandbox|production', () => {
    for (const env of ['development', '', 'SANDBOX', 'PRODUCTION', 'prod']) {
      try {
        createPlaidClient({ rpc: () => Promise.resolve({ data: null, error: null }) }, { env });
        throw new Error('expected env allowlist construction failure');
      } catch (error) {
        assert(error instanceof Error);
        assertEquals(error.message, 'Plaid client env must be sandbox or production');
      }
    }
  });

  await test.step('injected provider calls meter but never reserve', async () => {
    const names: string[] = [];
    const admin = {
      rpc: (name: string) => {
        names.push(name);
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: '{"request_id":"injected_C6"}', error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    const client = createPlaidClient(admin, { env: 'sandbox' });
    await client.linkTokenCreate(crypto.randomUUID(), {});
    assertEquals(names, [
      'keel_consume_plaid_test_response',
      'keel_meter_provider_call',
    ]);
  });

  await test.step('integration fetch-deny rechecks injection visibility without networking', async () => {
    const priorDeny = Deno.env.get('KEEL_PLAID_FETCH_DENY');
    let consumeCalls = 0;
    let fetchCalls = 0;
    const admin = {
      rpc: (name: string) => {
        if (name === 'keel_consume_plaid_test_response') {
          consumeCalls += 1;
          return Promise.resolve({
            data: consumeCalls === 1 ? null : '{"request_id":"visible_second_read"}',
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    Deno.env.set('KEEL_PLAID_FETCH_DENY', 'true');
    try {
      const client = createPlaidClient(admin, {
        env: 'sandbox',
        clientId: 'must-not-fetch',
        secret: 'must-not-fetch',
        fetchImpl: () => {
          fetchCalls += 1;
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      });
      await client.linkTokenCreate(crypto.randomUUID(), {});
    } finally {
      if (priorDeny === undefined) Deno.env.delete('KEEL_PLAID_FETCH_DENY');
      else Deno.env.set('KEEL_PLAID_FETCH_DENY', priorDeny);
    }
    assertEquals(consumeCalls, 2);
    assertEquals(fetchCalls, 0);
  });

  await test.step('integration fetch-deny refunds a reservation and fails closed before networking', async () => {
    const priorDeny = Deno.env.get('KEEL_PLAID_FETCH_DENY');
    const names: string[] = [];
    let fetchCalls = 0;
    const admin = {
      rpc: (name: string) => {
        names.push(name);
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'keel_provider_budget_reserve') {
          return Promise.resolve({ data: true, error: null });
        }
        if (name === 'keel_provider_budget_refund') {
          return Promise.resolve({ data: null, error: null });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    Deno.env.set('KEEL_PLAID_FETCH_DENY', 'true');
    try {
      const client = createPlaidClient(admin, {
        env: 'sandbox',
        clientId: 'must-not-fetch',
        secret: 'must-not-fetch',
        fetchImpl: () => {
          fetchCalls += 1;
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      });
      try {
        await client.linkTokenCreate(crypto.randomUUID(), {});
        throw new Error('expected integration fetch denial');
      } catch (error) {
        assert(error instanceof Error);
        assertEquals(error.message, 'Plaid fetch disabled in integration');
      }
    } finally {
      if (priorDeny === undefined) Deno.env.delete('KEEL_PLAID_FETCH_DENY');
      else Deno.env.set('KEEL_PLAID_FETCH_DENY', priorDeny);
    }
    assertEquals(fetchCalls, 0);
    assertEquals(names, [
      'keel_consume_plaid_test_response',
      'keel_consume_plaid_test_response',
      'keel_provider_budget_reserve',
      'keel_provider_budget_refund',
    ]);
  });

  await test.step('invalid injected response is metered once as a failure', async () => {
    const meters: Array<Record<string, unknown>> = [];
    const admin = {
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: '{}', error: null });
        }
        if (name === 'keel_meter_provider_call') meters.push(args);
        return Promise.resolve({ data: null, error: null });
      },
    };
    const client = createPlaidClient(admin, { env: 'sandbox' });
    try {
      await client.publicTokenExchange(crypto.randomUUID(), { public_token: 'in-memory-only' });
      throw new Error('expected invalid response');
    } catch (error) {
      assert(error instanceof Error);
      assertEquals(error.message, 'Plaid response is invalid');
    }
    assertEquals(meters.length, 1);
    assertEquals(meters[0]?.p_ok, false);
    assertEquals(meters[0]?.p_kind, 'item_public_token_exchange');
  });

  await test.step('live provider calls reserve immediately before fetch and meter success', async () => {
    const names: string[] = [];
    let fetchCalls = 0;
    let fetchUrl = '';
    const admin = {
      rpc: (name: string) => {
        names.push(name);
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'keel_provider_budget_reserve') {
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    const client = createPlaidClient(admin, {
      env: 'sandbox',
      clientId: 'client',
      secret: 'secret',
      dailyLimit: 7,
      fetchImpl: (input) => {
        fetchCalls += 1;
        fetchUrl = String(input);
        return Promise.resolve(new Response('{"request_id":"live_C6"}', { status: 200 }));
      },
    });
    await client.linkTokenCreate(crypto.randomUUID(), {});
    assertEquals(fetchCalls, 1);
    assertEquals(fetchUrl, 'https://sandbox.plaid.com/link/token/create');
    assertEquals(names, [
      'keel_consume_plaid_test_response',
      'keel_provider_budget_reserve',
      'keel_meter_provider_call',
    ]);
  });

  await test.step('post-success meter failure does not discard the provider result', async () => {
    let meterCalls = 0;
    const admin = {
      rpc: (name: string) => {
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'keel_provider_budget_reserve') {
          return Promise.resolve({ data: true, error: null });
        }
        if (name === 'keel_meter_provider_call') {
          meterCalls += 1;
          return Promise.resolve({ data: null, error: { message: 'meter unavailable' } });
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const client = createPlaidClient(admin, {
      env: 'sandbox',
      clientId: 'client',
      secret: 'secret',
      fetchImpl: () => Promise.resolve(new Response(
        '{"request_id":"meter_failure","answer":"preserved"}',
        { status: 200 },
      )),
    });

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    let result: Record<string, unknown>;
    try {
      result = await client.linkTokenCreate(crypto.randomUUID(), {});
    } finally {
      console.warn = originalWarn;
    }
    assertEquals(result['answer'], 'preserved');
    assertEquals(meterCalls, 1);
    assertEquals(warnings, [['KEEL_PROVIDER_METER_UNAVAILABLE']]);
  });

  await test.step('open budget meters refusal and performs zero fetches', async () => {
    const meterKinds: unknown[] = [];
    let fetchCalls = 0;
    const admin = {
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === 'keel_consume_plaid_test_response') {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === 'keel_provider_budget_reserve') {
          return Promise.resolve({ data: false, error: null });
        }
        if (name === 'keel_meter_provider_call') meterKinds.push(args.p_kind);
        return Promise.resolve({ data: null, error: null });
      },
    };
    const client = createPlaidClient(admin, {
      env: 'sandbox',
      clientId: 'client',
      secret: 'secret',
      dailyLimit: 1,
      fetchImpl: () => {
        fetchCalls += 1;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    try {
      await client.linkTokenCreate(crypto.randomUUID(), {});
      throw new Error('expected budget breaker');
    } catch (error) {
      assert(error instanceof ProviderBudgetExhaustedError);
    }
    assertEquals(fetchCalls, 0);
    assertEquals(meterKinds, ['budget_refused']);
  });
});
