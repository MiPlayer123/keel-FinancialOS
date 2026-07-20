import {
  makeExecuteReadTool,
  READ_TOOL_NAMES,
  readToolDefinitions,
  type AuthorizeFn,
} from './agent.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const allow: AuthorizeFn = () => ({ allowed: true });
const deny: AuthorizeFn = () => ({ allowed: false });

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, args });

const stubRpc =
  (data: unknown, error: unknown = null) =>
  (_proc: string, _args: Record<string, unknown>) =>
    Promise.resolve({ data, error });

Deno.test('read tool catalog exposes the broad read surface', () => {
  const defs = readToolDefinitions();
  assert(defs.length >= 15, 'expected a broad read surface');
  // A few anchors the agent relies on.
  for (const name of ['get_account_balances', 'list_transactions', 'list_budgets', 'list_reimbursements']) {
    assert(READ_TOOL_NAMES.includes(name), `missing tool ${name}`);
  }
  // Every definition carries a JSON-schema object.
  for (const d of defs) {
    assert((d.parameters as Record<string, unknown>)['type'] === 'object', `tool ${d.name} bad schema`);
  }
});

Deno.test('unknown tool returns an error payload, never throws', async () => {
  const exec = makeExecuteReadTool({
    authorize: allow,
    authzCtx: {},
    householdId: 'h1',
    rpc: stubRpc({ rows: [] }),
    todayIso: '2026-07-19',
  });
  const out = JSON.parse(await exec(call('does_not_exist')));
  assert(out.error === 'unknown_tool');
});

Deno.test('authz denial returns not_authorized and never calls the proc', async () => {
  let called = false;
  const exec = makeExecuteReadTool({
    authorize: deny,
    authzCtx: {},
    householdId: 'h1',
    rpc: (_p, _a) => {
      called = true;
      return Promise.resolve({ data: null, error: null });
    },
    todayIso: '2026-07-19',
  });
  const out = JSON.parse(await exec(call('get_account_balances')));
  assert(out.error === 'not_authorized');
  assert(called === false, 'proc must not run when authz denies');
});

Deno.test('injects the fixed householdId; the model cannot pass another', async () => {
  let seenArgs: Record<string, unknown> = {};
  const exec = makeExecuteReadTool({
    authorize: allow,
    authzCtx: {},
    householdId: 'h-real',
    rpc: (_p, args) => {
      seenArgs = args;
      return Promise.resolve({ data: { rows: [] }, error: null });
    },
    todayIso: '2026-07-19',
  });
  // Attempt to smuggle a different household via args — it must be ignored.
  await exec(call('get_account_balances', { p_household_id: 'h-evil', householdId: 'h-evil' }));
  assert(seenArgs['p_household_id'] === 'h-real', 'household must be server-injected');
});

Deno.test('invalid arguments are rejected before hitting the proc', async () => {
  let called = false;
  const exec = makeExecuteReadTool({
    authorize: allow,
    authzCtx: {},
    householdId: 'h1',
    rpc: (_p, _a) => {
      called = true;
      return Promise.resolve({ data: null, error: null });
    },
    todayIso: '2026-07-19',
  });
  // search_transactions requires a non-empty search term.
  const out = JSON.parse(await exec(call('search_transactions', {})));
  assert(out.error === 'invalid_arguments');
  assert(called === false);
});

Deno.test('proc errors surface a constant code, never DB internals (Law 12)', async () => {
  const exec = makeExecuteReadTool({
    authorize: allow,
    authzCtx: {},
    householdId: 'h1',
    rpc: stubRpc(null, { message: 'relation secret_table does not exist', code: '42P01' }),
    todayIso: '2026-07-19',
  });
  const raw = await exec(call('get_account_balances'));
  assert(!raw.includes('secret_table'), 'must not leak DB internals');
  assert(JSON.parse(raw).error === 'query_failed');
});

Deno.test('large results are bounded so context cannot be blown', async () => {
  const rows = Array.from({ length: 5000 }, (_v, i) => ({ i, blob: 'x'.repeat(50) }));
  const exec = makeExecuteReadTool({
    authorize: allow,
    authzCtx: {},
    householdId: 'h1',
    rpc: stubRpc({ rows }),
    todayIso: '2026-07-19',
  });
  const raw = await exec(call('list_transactions', { limit: 100 }));
  const parsed = JSON.parse(raw);
  // Either row-capped or truncated, but never the full 5000-row blob.
  assert(raw.length < 200_000, 'result was not bounded');
  assert(parsed.truncated === true || (parsed.rows && parsed.rows.length <= 100));
});
