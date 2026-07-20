import {
  agentToolDefinitions,
  makeExecuteAgentTool,
  makeExecuteReadTool,
  READ_TOOL_NAMES,
  readToolDefinitions,
  WRITE_TOOL_NAMES,
  type AppliedAction,
  type AuthorizeFn,
  type ProposedAction,
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

// ---------------------------------------------------------------------------
// Write tools (Class A notes)
// ---------------------------------------------------------------------------

const NOTE_ID = '11111111-1111-1111-1111-111111111111';

/** Route rpc by proc name; records every call for assertions. */
const noteRpc = (opts: { calls: { proc: string; args: Record<string, unknown> }[]; listRows?: unknown[] }) =>
  (proc: string, args: Record<string, unknown>) => {
    opts.calls.push({ proc, args });
    if (proc === 'keel_note_save') return Promise.resolve({ data: NOTE_ID, error: null });
    if (proc === 'keel_list_notes_tasks') return Promise.resolve({ data: { rows: opts.listRows ?? [] }, error: null });
    return Promise.resolve({ data: null, error: null });
  };

const agentDeps = (
  authorize: AuthorizeFn,
  rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  applied: AppliedAction[],
  proposed: ProposedAction[] = [],
) => ({
  authorize,
  authzCtx: {},
  householdId: 'h1',
  rpc,
  todayIso: '2026-07-19',
  onApplied: (a: AppliedAction) => applied.push(a),
  onProposed: (p: ProposedAction) => proposed.push(p),
});

Deno.test('agent tool catalog includes the note write tools', () => {
  const names = agentToolDefinitions().map((d) => d.name);
  for (const w of ['create_note', 'edit_note', 'archive_note', 'restore_note']) {
    assert(WRITE_TOOL_NAMES.includes(w), `missing write tool ${w}`);
    assert(names.includes(w), `catalog missing ${w}`);
  }
  // Reads are still present in the combined catalog.
  assert(names.includes('get_account_balances'));
});

Deno.test('create_note applies immediately and records an archive-undo', async () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const applied: AppliedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls }), applied));
  const out = JSON.parse(await exec(call('create_note', { body: 'Pay the water bill' })));
  assert(out.ok === true && out.noteId === NOTE_ID);
  assert(applied.length === 1);
  assert(applied[0]!.kind === 'notes.create');
  assert(applied[0]!.undo?.op === 'archive_note');
  assert(applied[0]!.undo?.noteId === NOTE_ID);
  // Created via the fixed household, note id null (insert path).
  const save = calls.find((c) => c.proc === 'keel_note_save')!;
  assert(save.args['p_household_id'] === 'h1');
  assert(save.args['p_note_id'] === null);
});

Deno.test('edit_note captures the prior body for an edit-undo', async () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const applied: AppliedAction[] = [];
  const listRows = [{ type: 'note', id: NOTE_ID, body: 'old body', pinned: false }];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls, listRows }), applied));
  await exec(call('edit_note', { noteId: NOTE_ID, body: 'new body' }));
  assert(applied.length === 1);
  assert(applied[0]!.kind === 'notes.update');
  assert(applied[0]!.undo?.op === 'edit_note');
  assert(applied[0]!.undo?.body === 'old body', 'prior body must be captured for undo');
});

Deno.test('archive_note and restore_note carry inverse undos', async () => {
  const applied: AppliedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls: [] }), applied));
  await exec(call('archive_note', { noteId: NOTE_ID }));
  await exec(call('restore_note', { noteId: NOTE_ID }));
  assert(applied[0]!.undo?.op === 'unarchive_note');
  assert(applied[1]!.undo?.op === 'archive_note');
});

Deno.test('a denied write authorizes-off, never runs the proc or applies', async () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const applied: AppliedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(deny, noteRpc({ calls }), applied));
  const out = JSON.parse(await exec(call('create_note', { body: 'x' })));
  assert(out.error === 'not_authorized');
  assert(calls.length === 0, 'no proc call on denied write');
  assert(applied.length === 0, 'nothing applied on denied write');
});

Deno.test('invalid write args are rejected before the proc and nothing is applied', async () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const applied: AppliedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls }), applied));
  const empty = JSON.parse(await exec(call('create_note', { body: '   ' })));
  assert(empty.error === 'invalid_arguments');
  const badId = JSON.parse(await exec(call('archive_note', { noteId: 'not-a-uuid' })));
  assert(badId.error === 'invalid_arguments');
  assert(calls.length === 0);
  assert(applied.length === 0);
});

Deno.test('the combined executor still serves reads and unknown tools', async () => {
  const applied: AppliedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls: [] }), applied));
  const unknown = JSON.parse(await exec(call('does_not_exist')));
  assert(unknown.error === 'unknown_tool');
  assert(applied.length === 0);
});

// ---------------------------------------------------------------------------
// Budget proposals (Class B — suggest→approve, never applied by the agent)
// ---------------------------------------------------------------------------

const CAT_ID = '22222222-2222-2222-2222-222222222222';

Deno.test('budget proposal tools are in the catalog', () => {
  const names = agentToolDefinitions().map((d) => d.name);
  for (const p of ['propose_budget_target', 'propose_budget_total', 'propose_expected_income', 'propose_remove_budget_target']) {
    assert(names.includes(p), `catalog missing ${p}`);
  }
});

Deno.test('propose_budget_target stages an exact command payload, never applies', async () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const applied: AppliedAction[] = [];
  const proposed: ProposedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls }), applied, proposed));
  const out = JSON.parse(
    await exec(call('propose_budget_target', { categoryLedgerAccountId: CAT_ID, amountMinor: '60000', categoryName: 'Groceries' })),
  );
  assert(out.proposed === true);
  assert(applied.length === 0, 'a proposal must never apply');
  assert(calls.length === 0, 'a proposal must not call any proc');
  assert(proposed.length === 1);
  const p = proposed[0]!;
  assert(p.command === 'budgets.set_target');
  assert(p.payload.categoryLedgerAccountId === CAT_ID);
  assert(p.payload.kind === 'amount');
  assert(p.payload.amountMinor === '60000');
  assert(typeof p.payload.month === 'string' && (p.payload.month as string).endsWith('-01'));
});

Deno.test('propose_budget_target requires exactly one of amountMinor / percentBp', async () => {
  const proposed: ProposedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls: [] }), [], proposed));
  const both = JSON.parse(await exec(call('propose_budget_target', { categoryLedgerAccountId: CAT_ID, amountMinor: '100', percentBp: 5000 })));
  assert(both.error === 'invalid_arguments');
  const neither = JSON.parse(await exec(call('propose_budget_target', { categoryLedgerAccountId: CAT_ID })));
  assert(neither.error === 'invalid_arguments');
  assert(proposed.length === 0);
});

Deno.test('a denied budget proposal authorizes-off and stages nothing', async () => {
  const proposed: ProposedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(deny, noteRpc({ calls: [] }), [], proposed));
  const out = JSON.parse(await exec(call('propose_budget_total', { amountMinor: '500000' })));
  assert(out.error === 'not_authorized');
  assert(proposed.length === 0);
});

Deno.test('propose_budget_total builds a discriminated basis payload', async () => {
  const proposed: ProposedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls: [] }), [], proposed));
  await exec(call('propose_budget_total', { percentBp: 8000 }));
  assert(proposed[0]!.payload.basis === 'percent_of_income');
  assert(proposed[0]!.payload.percentBp === 8000);
});

Deno.test('non-digit amountMinor is rejected (Law 4: no floats)', async () => {
  const proposed: ProposedAction[] = [];
  const exec = makeExecuteAgentTool(agentDeps(allow, noteRpc({ calls: [] }), [], proposed));
  const out = JSON.parse(await exec(call('propose_expected_income', { amountMinor: '600.50' })));
  assert(out.error === 'invalid_arguments');
  assert(proposed.length === 0);
});
