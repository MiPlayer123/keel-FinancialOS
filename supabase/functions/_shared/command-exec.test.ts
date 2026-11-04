import { executeCommand, type CommandContract } from './command-exec.ts';
import { isThirdPartyClientToken } from './connected-app.ts';

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const SERIES = '33333333-3333-4333-8333-333333333333';

const envelope = (command: string, payload: Record<string, unknown>) => ({
  commandId: 'c1',
  command,
  economicEventKey: `${command}:test-key`,
  actor: { kind: 'user', userId: 'u1' },
  householdId: HOUSEHOLD,
  payload,
});

const contract = (overrides: Partial<CommandContract> = {}): CommandContract => ({
  parseEnvelope: (body) => ({ success: true, data: body as never }),
  parsePayload: (_command, payload) => payload,
  authorize: () => ({ allowed: true }),
  isEntityId: () => false,
  isAccountId: (v) => v === ACCOUNT,
  toSnakeKeys: (v) => v,
  ...overrides,
});

const client = (recurringRows: unknown[] = []) => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: (proc: string, args: Record<string, unknown>) => {
      calls.push({ proc, args });
      if (proc === 'keel_list_recurring') return Promise.resolve({ data: { rows: recurringRows }, error: null });
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
};

Deno.test('a valid command runs its proc with the envelope fields', async () => {
  const supabase = client();
  const out = await executeCommand(contract(), supabase, () => Promise.resolve({}), envelope('transactions.manual_void', { transactionId: 't1', reason: 'dup' }));
  assertEquals(out, { ok: true, data: { ok: true } });
  assertEquals(supabase.calls.map((c) => c.proc), ['keel_cmd_manual_void']);
  assertEquals(supabase.calls[0]!.args['p_household_id'], HOUSEHOLD);
  assertEquals(supabase.calls[0]!.args['p_economic_event_key'], 'transactions.manual_void:test-key');
});

Deno.test('unknown commands and bad payloads never reach the database', async () => {
  const supabase = client();
  const unknown = await executeCommand(contract(), supabase, () => Promise.resolve({}), envelope('admin.drop_everything', {}));
  assertEquals((unknown as { code: string }).code, 'invalid_command');
  const bad = await executeCommand(
    contract({ parsePayload: () => { throw new Error('nope'); } }),
    supabase,
    () => Promise.resolve({}),
    envelope('transactions.manual_void', {}),
  );
  assertEquals((bad as { status: number }).status, 400);
  assertEquals(supabase.calls.length, 0);
});

Deno.test('authz: cross-household is not_found, role denial is not_authorized', async () => {
  const scope = await executeCommand(
    contract({ authorize: () => ({ allowed: false, code: 'household_scope_violation', reason: 'x' }) }),
    client(),
    () => Promise.resolve({}),
    envelope('transactions.manual_void', { transactionId: 't1', reason: 'r' }),
  );
  assertEquals((scope as { status: number }).status, 404);
  const role = await executeCommand(
    contract({ authorize: () => ({ allowed: false, code: 'not_authorized', reason: 'viewer' }) }),
    client(),
    () => Promise.resolve({}),
    envelope('transactions.manual_void', { transactionId: 't1', reason: 'r' }),
  );
  assertEquals((role as { status: number }).status, 403);
});

Deno.test('recurring commands authorize against the series account', async () => {
  let resource: Record<string, unknown> = {};
  const supabase = client([{ seriesId: SERIES, accountId: ACCOUNT }]);
  await executeCommand(
    contract({ authorize: (_c, _a, r) => { resource = r; return { allowed: true }; } }),
    supabase,
    () => Promise.resolve({}),
    envelope('recurring.pause', { seriesId: SERIES }),
  );
  assertEquals(resource['kind'], 'recurring_series');
  assertEquals(resource['accountId'], ACCOUNT);
  const missing = await executeCommand(contract(), client([]), () => Promise.resolve({}), envelope('recurring.pause', { seriesId: SERIES }));
  assertEquals((missing as { status: number }).status, 404);
});

Deno.test('connected-app tokens are told apart by client_id alone', () => {
  assertEquals(isThirdPartyClientToken({ sub: 'u', client_id: 'c' }), true);
  assertEquals(isThirdPartyClientToken({ sub: 'u' }), false);
  assertEquals(isThirdPartyClientToken({ sub: 'u', client_id: '' }), false);
  assertEquals(isThirdPartyClientToken(null), false);
});
