import {
  claimActiveSyncs,
  meterCall,
  refundProviderCall,
  reserveProviderCall,
} from './plaid-meter.ts';

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
  message: string,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes(message), `${error.message} does not include ${message}`);
    return;
  }
  throw new Error('expected operation to reject');
};

Deno.test('C6 Plaid metering and operational RPC adapters', async (test) => {
  await test.step('meterCall computes latency and sends only the Law-12 whitelist', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const admin = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
    };
    const originalNow = Date.now;
    Date.now = () => 1_025;
    try {
      await meterCall(admin, {
        provider: 'plaid',
        kind: 'accounts_get',
        householdId: '00000000-0000-4000-8000-00000000a001',
        start: 1_000,
        ok: true,
        errorCode: null,
        requestId: 'request_C6-1',
        itemRef: '97000000-0000-4000-8000-000000000001',
        quantity: 1,
      });
    } finally {
      Date.now = originalNow;
    }
    assertEquals(calls, [{
      name: 'keel_meter_provider_call',
      args: {
        p_provider: 'plaid',
        p_kind: 'accounts_get',
        p_household_id: '00000000-0000-4000-8000-00000000a001',
        p_latency_ms: 25,
        p_ok: true,
        p_error_code: null,
        p_request_id: 'request_C6-1',
        p_item_ref: '97000000-0000-4000-8000-000000000001',
        p_quantity: 1,
      },
    }]);
  });

  await test.step('meterCall rejects extra fields before they reach RPC', async () => {
    let calls = 0;
    const admin = {
      rpc: () => {
        calls += 1;
        return Promise.resolve({ data: null, error: null });
      },
    };
    await assertRejects(
      () => meterCall(admin, {
        provider: 'plaid',
        kind: 'accounts_get',
        start: Date.now(),
        ok: true,
        token: 'must-never-cross-the-meter-boundary',
      } as never),
      'unexpected metering field',
    );
    assertEquals(calls, 0);
  });

  await test.step('reserve, refund, and claim use typed atomic RPCs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const results = [
      { data: true, error: null },
      { data: false, error: null },
      { data: null, error: null },
      { data: 3, error: null },
    ];
    const admin = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve(results.shift()!);
      },
    };
    assertEquals(await reserveProviderCall(admin, 'plaid', 10), true);
    assertEquals(await reserveProviderCall(admin, 'plaid', 10), false);
    await refundProviderCall(admin, 'plaid');
    assertEquals(await claimActiveSyncs(admin, 900), 3);
    assertEquals(calls, [
      {
        name: 'keel_provider_budget_reserve',
        args: { p_provider: 'plaid', p_daily_limit: 10 },
      },
      {
        name: 'keel_provider_budget_reserve',
        args: { p_provider: 'plaid', p_daily_limit: 10 },
      },
      { name: 'keel_provider_budget_refund', args: { p_provider: 'plaid' } },
      {
        name: 'keel_cron_enqueue_active_syncs',
        args: { p_min_interval_seconds: 900 },
      },
    ]);
  });
});
