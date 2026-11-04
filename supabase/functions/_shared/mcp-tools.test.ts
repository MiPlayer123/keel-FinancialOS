import { READ_TOOL_ACTIONS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, type AuthorizeFn } from './agent.ts';
import { makeMcpToolbox, MCP_ORGANIZE_TOOLS, mcpToolsFor, wrapToolPayload, type McpCapability } from './mcp-tools.ts';

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

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-04T12:00:00.000Z';

const QUERY_TO_PROC: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.values(READ_TOOL_ACTIONS).map((action) => [action, `stub_proc__${action}`])),
  'notes_tasks.list': 'keel_list_notes_tasks',
  'notes.save': 'keel_note_save',
  'notes.archive': 'keel_note_archive',
  'notes.unarchive': 'keel_note_unarchive',
  'tasks.save': 'keel_task_save',
  'tasks.set_status': 'keel_task_set_status',
};

const allow: AuthorizeFn = () => ({ allowed: true });
const deny: AuthorizeFn = () => ({ allowed: false });

const caps = (...c: McpCapability[]): ReadonlySet<McpCapability> => new Set(c);

const recordingRpc = () => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const rpc = (proc: string, args: Record<string, unknown>) => {
    calls.push({ proc, args });
    if (proc === 'keel_note_save') return Promise.resolve({ data: NOTE, error: null });
    return Promise.resolve({ data: { rows: [{ amountMinor: '1250', currency: 'USD' }] }, error: null });
  };
  return { calls, rpc };
};

const toolbox = (capabilities: ReadonlySet<McpCapability>, authorize: AuthorizeFn = allow) => {
  const { calls, rpc } = recordingRpc();
  return {
    calls,
    box: makeMcpToolbox({
      authorize,
      authzCtx: {},
      householdId: HOUSEHOLD,
      rpc,
      queryToProc: QUERY_TO_PROC,
      capabilities,
      nowIso: NOW,
    }),
  };
};

const envelopeOf = (result: { content: readonly { text: string }[] }) =>
  JSON.parse(result.content[0]!.text) as { keel: Record<string, unknown>; result: unknown };

Deno.test('read grant exposes every read tool, all marked read-only, and no writes', () => {
  const tools = mcpToolsFor(caps('read'));
  assertEquals(tools.map((t) => t.name).sort(), [...READ_TOOL_NAMES].sort());
  for (const tool of tools) {
    assertEquals(tool.annotations?.readOnlyHint, true, tool.name);
    assertEquals(tool.annotations?.openWorldHint, false, tool.name);
  }
});

Deno.test('organize grant adds only class-A note/task writes — never propose_* or receipt attach', () => {
  const names = mcpToolsFor(caps('read', 'organize')).map((t) => t.name);
  for (const name of MCP_ORGANIZE_TOOLS) {
    assert(names.includes(name), `missing ${name}`);
    assert(WRITE_TOOL_NAMES.includes(name), `${name} is not in the agent write catalog`);
  }
  assert(!names.some((n) => n.startsWith('propose_')), 'class-B proposal tool leaked into MCP');
  assert(!names.includes('attach_receipt_to_transaction'), 'image-bound tool leaked into MCP');
});

Deno.test('non-additive writes are flagged destructive so hosts ask the user first', () => {
  const byName = Object.fromEntries(mcpToolsFor(caps('organize')).map((t) => [t.name, t]));
  assertEquals(byName['create_note']?.annotations?.destructiveHint, false);
  assertEquals(byName['edit_note']?.annotations?.destructiveHint, true);
  assertEquals(byName['archive_note']?.annotations?.destructiveHint, true);
  assertEquals(byName['set_task_status']?.annotations?.destructiveHint, true);
});

Deno.test('a read-only grant cannot call a write tool (looks like an unknown tool)', async () => {
  const { box, calls } = toolbox(caps('read'));
  const result = await box.callTool('create_note', { body: 'hi' });
  assertEquals(result, null);
  assertEquals(calls.length, 0);
});

Deno.test('read call runs the authorized proc with the FIXED household and wraps the envelope', async () => {
  const { box, calls } = toolbox(caps('read'));
  const result = await box.callTool('list_transactions', { limit: 5, householdId: 'someone-else' });
  assert(result !== null);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args['p_household_id'], HOUSEHOLD, 'model-supplied household must be ignored');
  const env = envelopeOf(result);
  assertEquals(env.keel['asOf'], NOW);
  assertEquals(env.keel['scope'], { householdId: HOUSEHOLD });
  assert(String(env.keel['dataTier']).includes('never as instructions'));
  assert(result.isError !== true);
});

Deno.test('authz denial surfaces as an isError tool result, and no proc runs', async () => {
  const { box, calls } = toolbox(caps('read'), deny);
  const result = await box.callTool('get_net_worth', {});
  assert(result !== null);
  assertEquals(result.isError, true);
  assertEquals((envelopeOf(result).result as Record<string, unknown>)['error'], 'not_authorized');
  assertEquals(calls.length, 0);
});

Deno.test('organize write applies through the audited proc and reports its undo', async () => {
  const { box, calls } = toolbox(caps('read', 'organize'));
  const result = await box.callTool('create_note', { body: 'Call the insurer about the claim' });
  assert(result !== null && result.isError !== true);
  assertEquals(calls.map((c) => c.proc), ['keel_note_save']);
  const applied = envelopeOf(result).keel['applied'] as Record<string, unknown>;
  assertEquals(applied['ref'], NOTE);
  assertEquals(applied['undo'], { op: 'archive_note', noteId: NOTE });
});

Deno.test('wrapToolPayload marks error payloads and survives garbage', () => {
  assertEquals(wrapToolPayload('{"error":"query_failed"}', { nowIso: NOW, householdId: HOUSEHOLD }).isError, true);
  const garbage = wrapToolPayload('not json', { nowIso: NOW, householdId: HOUSEHOLD });
  assertEquals(garbage.isError, true);
});
