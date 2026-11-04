import { READ_TOOL_ACTIONS, type AuthorizeFn } from './agent.ts';
import { resolveMcpUrls } from './mcp-auth.ts';
import { makeMcpHttpHandler, routePath, type McpHttpDeps, type VerifiedCaller } from './mcp-http.ts';
import type { McpCapability } from './mcp-tools.ts';

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

const SUPABASE_URL = 'https://example-ref.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`;
const USER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const GOOD_TOKEN = 'good.oauth.token';
const SESSION_TOKEN = 'web.session.token';

const QUERY_TO_PROC = Object.fromEntries(
  Object.values(READ_TOOL_ACTIONS).map((action) => [action, `stub_proc__${action}`]),
);

const allow: AuthorizeFn = () => ({ allowed: true });

interface Harness {
  readonly handler: (req: Request) => Promise<Response>;
  readonly rpcCalls: string[];
  readonly logs: { event: string; fields: Record<string, unknown> }[];
}

const harness = (
  overrides: Partial<McpHttpDeps> = {},
  opts: { memberships?: { householdId: string; role: string }[]; caps?: McpCapability[] } = {},
): Harness => {
  const rpcCalls: string[] = [];
  const logs: Harness['logs'] = [];
  const memberships = opts.memberships ?? [{ householdId: HOUSEHOLD, role: 'owner' }];
  const callerFor = (claims: Record<string, unknown>): VerifiedCaller => ({
    claims,
    rpc: (proc) => {
      rpcCalls.push(proc);
      return Promise.resolve({ data: { rows: [] }, error: null });
    },
    loadAuthz: () => Promise.resolve({ ctx: {}, memberships }),
  });
  const base = { sub: USER, role: 'authenticated', aud: 'authenticated', iss: ISSUER };
  const deps: McpHttpDeps = {
    enabled: true,
    urls: resolveMcpUrls(SUPABASE_URL),
    tokenPolicy: { expectedIssuer: ISSUER, allowFirstPartySessions: false, allowedClientIds: [] },
    allowedOrigins: [],
    serverInfo: { name: 'keel', title: 'KEEL', version: 'test' },
    instructions: 'test',
    authorize: allow,
    queryToProc: QUERY_TO_PROC,
    verify: (token) =>
      Promise.resolve(
        token === GOOD_TOKEN
          ? callerFor({ ...base, client_id: CLIENT })
          : token === SESSION_TOKEN
            ? callerFor(base)
            : null,
      ),
    capabilitiesFor: () => Promise.resolve(new Set<McpCapability>(opts.caps ?? ['read'])),
    pinnedHouseholdFor: () => Promise.resolve(null),
    now: () => new Date('2026-11-04T12:00:00.000Z'),
    log: (event, fields) => logs.push({ event, fields }),
    ...overrides,
  };
  return { handler: makeMcpHttpHandler(deps), rpcCalls, logs };
};

const rpc = (method: string, params: Record<string, unknown> = {}, token: string | null = GOOD_TOKEN) =>
  new Request(`${MCP_URL}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

Deno.test('routePath strips the function prefix in both runtime shapes', () => {
  assertEquals(routePath('/mcp'), '/');
  assertEquals(routePath('/mcp/'), '/');
  assertEquals(routePath('/functions/v1/mcp/.well-known/oauth-protected-resource'), '/.well-known/oauth-protected-resource');
});

Deno.test('kill switch: a disabled surface is a plain 404 everywhere', async () => {
  const { handler } = harness({ enabled: false });
  assertEquals((await handler(rpc('initialize'))).status, 404);
  assertEquals((await handler(new Request(`${MCP_URL}/.well-known/oauth-protected-resource`))).status, 404);
});

Deno.test('protected resource metadata is public and points at Supabase Auth', async () => {
  const { handler } = harness();
  const res = await handler(new Request(`${MCP_URL}/.well-known/oauth-protected-resource`));
  assertEquals(res.status, 200);
  const prm = (await res.json()) as Record<string, unknown>;
  assertEquals(prm['resource'], MCP_URL);
  assertEquals(prm['authorization_servers'], [ISSUER]);
});

Deno.test('no token → 401 with resource_metadata (this is what starts sign-in in Claude)', async () => {
  const { handler, rpcCalls } = harness();
  const res = await handler(rpc('initialize', {}, null));
  assertEquals(res.status, 401);
  const header = res.headers.get('www-authenticate') ?? '';
  assert(header.startsWith('Bearer '), header);
  assert(header.includes(`resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`), header);
  assert(!header.includes('error='), 'no error code before the client has authenticated');
  assertEquals(rpcCalls.length, 0);
});

Deno.test('bad token → 401 invalid_token; a KEEL web-session token is not an AI-client token', async () => {
  const { handler, logs } = harness();
  const bad = await handler(rpc('initialize', {}, 'forged'));
  assertEquals(bad.status, 401);
  assert((bad.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'));
  const session = await handler(rpc('tools/list', {}, SESSION_TOKEN));
  assertEquals(session.status, 401);
  assert(logs.some((l) => l.event === 'mcp_token_rejected' && l.fields['reason'] === 'not_an_oauth_client_token'));
});

Deno.test('GET/DELETE on the endpoint are 405 (stateless, no SSE stream)', async () => {
  const { handler } = harness();
  assertEquals((await handler(new Request(MCP_URL, { method: 'GET' }))).status, 405);
  assertEquals((await handler(new Request(MCP_URL, { method: 'DELETE' }))).status, 405);
});

Deno.test('browser origins must be allowlisted (DNS-rebinding guard)', async () => {
  const { handler } = harness();
  const req = rpc('initialize');
  const withOrigin = new Request(req, { headers: { ...Object.fromEntries(req.headers), origin: 'https://evil.example' } });
  assertEquals((await handler(withOrigin)).status, 403);
});

Deno.test('initialize then tools/list then tools/call, end to end', async () => {
  const { handler, rpcCalls, logs } = harness();
  const init = await handler(rpc('initialize', { protocolVersion: '2025-06-18' }));
  assertEquals(init.status, 200);
  assertEquals(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');

  const list = await handler(rpc('tools/list'));
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools;
  assert(tools.some((t) => t.name === 'get_net_worth'));
  assert(!tools.some((t) => t.name === 'create_note'), 'read grant must not list writes');

  const call = await handler(rpc('tools/call', { name: 'get_net_worth', arguments: {} }));
  assertEquals(call.status, 200);
  const result = ((await call.json()) as { result: { isError?: boolean } }).result;
  assert(result.isError !== true);
  assertEquals(rpcCalls, ['stub_proc__dashboard.net_worth']);
  const entry = logs.find((l) => l.event === 'mcp_request' && l.fields['method'] === 'tools/call');
  assertEquals(entry?.fields['tool'], 'get_net_worth');
  assertEquals(entry?.fields['clientId'], CLIENT);
  assert(!JSON.stringify(logs).includes(USER), 'user id must not be logged');
});

Deno.test('notifications get 202 with no body', async () => {
  const { handler } = harness();
  const req = new Request(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const res = await handler(req);
  assertEquals(res.status, 202);
  assertEquals(await res.text(), '');
});

Deno.test('several households and no pin → tools are listed, calls explain instead of guessing', async () => {
  const { handler, rpcCalls } = harness({}, {
    memberships: [
      { householdId: HOUSEHOLD, role: 'owner' },
      { householdId: '55555555-5555-4555-8555-555555555555', role: 'owner' },
    ],
  });
  const list = (await (await handler(rpc('tools/list'))).json()) as { result: { tools: unknown[] } };
  assert(list.result.tools.length > 0, 'listing must not depend on household resolution');
  const call = (await (await handler(rpc('tools/call', { name: 'get_net_worth' }))).json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assertEquals(call.result.isError, true);
  assert(call.result.content[0]!.text.includes('ambiguous_household'));
  assertEquals(rpcCalls.length, 0);
});

Deno.test('unsupported protocol header, bad JSON and oversized bodies are rejected before any work', async () => {
  const { handler, rpcCalls } = harness();
  const req = rpc('tools/list');
  const badVersion = new Request(req, {
    headers: { ...Object.fromEntries(req.headers), 'mcp-protocol-version': '2024-01-01' },
  });
  assertEquals((await handler(badVersion)).status, 400);

  const badJson = new Request(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assertEquals((await handler(badJson)).status, 400);

  const huge = new Request(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${GOOD_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } }),
  });
  assertEquals((await handler(huge)).status, 413);
  assertEquals(rpcCalls.length, 0);
});
