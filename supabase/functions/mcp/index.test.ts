/**
 * The HTTP entry's sign-in discovery: whatever an AI app sends first, an
 * unauthenticated request must get the 401 that points at the metadata,
 * because that is the only way the app finds KEEL's sign-in server.
 */
const SUPABASE_URL = 'https://example-ref.supabase.co';
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.delete('KEEL_MCP_PUBLIC_URL');
Deno.env.delete('KEEL_MCP_ENABLED');
const { handle } = await import('./index.ts');

const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`;
const PRM_URL = `${MCP_URL}/.well-known/oauth-protected-resource`;

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message ?? 'not equal'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const initialize = (headers: Record<string, string> = {}) =>
  new Request(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });

const assertChallenge = async (res: Response, label: string) => {
  assertEquals(res.status, 401, `${label} status`);
  assertEquals(res.headers.get('www-authenticate'), `Bearer resource_metadata="${PRM_URL}"`, `${label} challenge`);
  await res.body?.cancel();
};

Deno.test('unauthenticated requests get the sign-in challenge, whatever their Origin', async () => {
  await assertChallenge(await handle(initialize()), 'no origin');
  // Hosted clients may send their own Origin; refusing it hid the challenge.
  await assertChallenge(await handle(initialize({ origin: 'https://claude.ai' })), 'claude.ai origin');
  await assertChallenge(await handle(initialize({ origin: 'https://chatgpt.com' })), 'chatgpt.com origin');
});

Deno.test('a GET probe without a token also gets the challenge', async () => {
  await assertChallenge(await handle(new Request(MCP_URL, { headers: { accept: 'text/event-stream' } })), 'GET');
});

Deno.test('protected-resource metadata is public and names the MCP URL', async () => {
  const res = await handle(new Request(PRM_URL, { headers: { origin: 'https://claude.ai' } }));
  assertEquals(res.status, 200, 'status');
  const body = await res.json();
  assertEquals(body.resource, MCP_URL, 'resource');
  assertEquals(body.authorization_servers, [`${SUPABASE_URL}/auth/v1`], 'authorization servers');
});

Deno.test('CORS preflight is answered for browser-based clients', async () => {
  const res = await handle(new Request(MCP_URL, { method: 'OPTIONS', headers: { origin: 'https://inspector.example' } }));
  assertEquals(res.status, 204, 'status');
  assertEquals(res.headers.get('access-control-allow-origin'), 'https://inspector.example', 'allow origin');
});
