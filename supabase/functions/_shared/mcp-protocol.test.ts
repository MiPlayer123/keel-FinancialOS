import {
  handleMcpMessage,
  isAcceptableProtocolHeader,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  RPC_ERROR,
  type McpHandlerDeps,
  type McpTool,
} from './mcp-protocol.ts';

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

const TOOL: McpTool = {
  name: 'get_net_worth',
  description: 'Net worth as of a date.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

const deps = (overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps => ({
  serverInfo: { name: 'keel', title: 'KEEL', version: 'test' },
  instructions: 'test instructions',
  listTools: () => [TOOL],
  callTool: (name) =>
    Promise.resolve(
      name === TOOL.name ? { content: [{ type: 'text' as const, text: '{"ok":true}' }] } : null,
    ),
  ...overrides,
});

const body = (outcome: Awaited<ReturnType<typeof handleMcpMessage>>): Record<string, unknown> => {
  assert('body' in outcome, `expected a body, got status ${String(outcome.status)}`);
  return outcome.body;
};

Deno.test('initialize echoes a supported protocol version and advertises tools only', async () => {
  const out = await handleMcpMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    deps(),
  );
  assertEquals(out.status, 200);
  const result = body(out)['result'] as Record<string, unknown>;
  assertEquals(result['protocolVersion'], '2025-06-18');
  assertEquals(result['capabilities'], { tools: { listChanged: false } });
  assertEquals((result['serverInfo'] as Record<string, unknown>)['name'], 'keel');
  assertEquals(result['instructions'], 'test instructions');
});

Deno.test('initialize with an unknown version answers with the latest supported', () => {
  assertEquals(negotiateProtocolVersion('1999-01-01'), LATEST_PROTOCOL_VERSION);
  assertEquals(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
});

Deno.test('protocol header: absent ok, known ok, unknown rejected', () => {
  assert(isAcceptableProtocolHeader(null));
  assert(isAcceptableProtocolHeader('2025-11-25'));
  assert(!isAcceptableProtocolHeader('2024-01-01'));
});

Deno.test('notifications and client responses are acknowledged with 202 and no body', async () => {
  const note = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps());
  assertEquals(note.status, 202);
  const response = await handleMcpMessage({ jsonrpc: '2.0', id: 9, result: {} }, deps());
  assertEquals(response.status, 202);
});

Deno.test('batches and non-JSON-RPC bodies are invalid requests', async () => {
  const batch = await handleMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], deps());
  assertEquals(batch.status, 400);
  assertEquals((body(batch)['error'] as Record<string, unknown>)['code'], RPC_ERROR.invalidRequest);
  const wrongVersion = await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, deps());
  assertEquals(wrongVersion.status, 400);
  const badId = await handleMcpMessage({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, deps());
  assertEquals(badId.status, 400);
});

Deno.test('ping and tools/list', async () => {
  assertEquals(body(await handleMcpMessage({ jsonrpc: '2.0', id: 'a', method: 'ping' }, deps()))['result'], {});
  const list = body(await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps()));
  assertEquals((list['result'] as Record<string, unknown>)['tools'], [TOOL]);
});

Deno.test('tools/call returns the tool result; unknown tools are invalid params', async () => {
  const ok = body(
    await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_net_worth', arguments: {} } },
      deps(),
    ),
  );
  assertEquals((ok['result'] as Record<string, unknown>)['content'], [{ type: 'text', text: '{"ok":true}' }]);

  const unknown = body(
    await handleMcpMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_budget_total' } },
      deps(),
    ),
  );
  assertEquals((unknown['error'] as Record<string, unknown>)['code'], RPC_ERROR.invalidParams);

  const badArgs = body(
    await handleMcpMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_net_worth', arguments: [1] } },
      deps(),
    ),
  );
  assertEquals((badArgs['error'] as Record<string, unknown>)['code'], RPC_ERROR.invalidParams);
});

Deno.test('a throwing tool becomes a generic internal error (no internals leak)', async () => {
  const out = body(
    await handleMcpMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_net_worth' } },
      deps({ callTool: () => Promise.reject(new Error('relation "secret_table" does not exist')) }),
    ),
  );
  const error = out['error'] as Record<string, unknown>;
  assertEquals(error['code'], RPC_ERROR.internalError);
  assert(!String(error['message']).includes('secret_table'), 'db detail leaked');
});

Deno.test('capabilities the server does not declare are method-not-found', async () => {
  for (const method of ['resources/list', 'prompts/list', 'sampling/createMessage']) {
    const out = body(await handleMcpMessage({ jsonrpc: '2.0', id: 7, method }, deps()));
    assertEquals((out['error'] as Record<string, unknown>)['code'], RPC_ERROR.methodNotFound, method);
  }
});
