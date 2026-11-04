import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  checkMcpTokenClaims,
  isAllowedOrigin,
  isThirdPartyClientToken,
  MCP_SCOPES_SUPPORTED,
  pickHousehold,
  resolveMcpUrls,
  type McpTokenPolicy,
} from './mcp-auth.ts';

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
const USER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

const policy = (overrides: Partial<McpTokenPolicy> = {}): McpTokenPolicy => ({
  expectedIssuer: ISSUER,
  allowFirstPartySessions: false,
  allowedClientIds: [],
  ...overrides,
});

/** Claims shaped like a Supabase OAuth-server access token. */
const oauthClaims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: USER,
  role: 'authenticated',
  aud: 'authenticated',
  iss: ISSUER,
  client_id: CLIENT,
  scope: 'openid email',
  is_anonymous: false,
  ...overrides,
});

Deno.test('URLs: resource is the function URL; PRM lives inside the function; issuer is Supabase Auth', () => {
  const urls = resolveMcpUrls(`${SUPABASE_URL}/`);
  assertEquals(urls.resource, `${SUPABASE_URL}/functions/v1/mcp`);
  assertEquals(urls.resourceMetadata, `${SUPABASE_URL}/functions/v1/mcp/.well-known/oauth-protected-resource`);
  assertEquals(urls.authorizationServer, ISSUER);
});

Deno.test('URLs: a custom public URL changes the resource but never the issuer', () => {
  const urls = resolveMcpUrls(SUPABASE_URL, 'https://keel.example/mcp/');
  assertEquals(urls.resource, 'https://keel.example/mcp');
  assertEquals(urls.resourceMetadata, 'https://keel.example/mcp/.well-known/oauth-protected-resource');
  assertEquals(urls.authorizationServer, ISSUER);
});

Deno.test('PRM document carries the RFC 9728 fields MCP clients need, and no offline_access', () => {
  const prm = buildProtectedResourceMetadata(resolveMcpUrls(SUPABASE_URL));
  assertEquals(prm['resource'], `${SUPABASE_URL}/functions/v1/mcp`);
  assertEquals(prm['authorization_servers'], [ISSUER]);
  assertEquals(prm['bearer_methods_supported'], ['header']);
  assert(!MCP_SCOPES_SUPPORTED.includes('offline_access'), 'MCP spec: do not advertise offline_access');
});

Deno.test('WWW-Authenticate: bare challenge without a token, invalid_token with one', () => {
  const md = `${SUPABASE_URL}/functions/v1/mcp/.well-known/oauth-protected-resource`;
  assertEquals(buildWwwAuthenticate({ resourceMetadata: md }), `Bearer resource_metadata="${md}"`);
  assertEquals(
    buildWwwAuthenticate({ resourceMetadata: md, error: 'invalid_token', errorDescription: 'Expired "token"' }),
    `Bearer resource_metadata="${md}", error="invalid_token", error_description="Expired token"`,
  );
});

Deno.test('an OAuth-server token for a consented client is accepted', () => {
  assertEquals(checkMcpTokenClaims(oauthClaims(), policy()), { ok: true, userId: USER, clientId: CLIENT });
});

Deno.test('a first-party KEEL web session token is refused unless explicitly allowed (local dev)', () => {
  const session = oauthClaims({ client_id: undefined });
  assertEquals(checkMcpTokenClaims(session, policy()), { ok: false, reason: 'not_an_oauth_client_token' });
  assertEquals(checkMcpTokenClaims(session, policy({ allowFirstPartySessions: true })), {
    ok: true,
    userId: USER,
    clientId: null,
  });
});

Deno.test('wrong issuer, anonymous users, service roles and missing subjects are refused', () => {
  assertEquals(checkMcpTokenClaims(oauthClaims({ iss: 'https://evil.example/auth/v1' }), policy()), {
    ok: false,
    reason: 'wrong_issuer',
  });
  assertEquals(checkMcpTokenClaims(oauthClaims({ is_anonymous: true }), policy()), {
    ok: false,
    reason: 'anonymous_user',
  });
  assertEquals(checkMcpTokenClaims(oauthClaims({ role: 'service_role' }), policy()), {
    ok: false,
    reason: 'not_authenticated_role',
  });
  assertEquals(checkMcpTokenClaims(oauthClaims({ sub: '' }), policy()), { ok: false, reason: 'no_subject' });
});

Deno.test('optional client allowlist and audience binding', () => {
  assertEquals(checkMcpTokenClaims(oauthClaims(), policy({ allowedClientIds: ['someone-else'] })), {
    ok: false,
    reason: 'client_not_allowed',
  });
  const aud = `${SUPABASE_URL}/functions/v1/mcp`;
  assertEquals(checkMcpTokenClaims(oauthClaims(), policy({ requiredAudience: aud })), {
    ok: false,
    reason: 'wrong_audience',
  });
  assert(checkMcpTokenClaims(oauthClaims({ aud: ['authenticated', aud] }), policy({ requiredAudience: aud })).ok);
});

Deno.test('isThirdPartyClientToken separates AI-client tokens from web sessions', () => {
  assert(isThirdPartyClientToken(oauthClaims()));
  assert(!isThirdPartyClientToken(oauthClaims({ client_id: undefined })));
  assert(!isThirdPartyClientToken(oauthClaims({ client_id: '' })));
  assert(!isThirdPartyClientToken(null));
});

Deno.test('household pinning: one membership is automatic; several need an explicit pin', () => {
  const one = [{ householdId: 'h1', role: 'owner' }];
  const two = [...one, { householdId: 'h2', role: 'viewer' }];
  assertEquals(pickHousehold(one), { ok: true, householdId: 'h1' });
  assertEquals(pickHousehold(two), { ok: false, reason: 'ambiguous_household' });
  assertEquals(pickHousehold(two, 'h2'), { ok: true, householdId: 'h2' });
  assertEquals(pickHousehold(two, 'not-mine'), { ok: false, reason: 'no_household' });
  assertEquals(pickHousehold([]), { ok: false, reason: 'no_household' });
});

Deno.test('origin guard: absent origin (server-to-server) ok, unknown browser origin refused', () => {
  assert(isAllowedOrigin(null, []));
  assert(isAllowedOrigin('https://inspector.example', ['https://inspector.example']));
  assert(!isAllowedOrigin('https://evil.example', ['https://inspector.example']));
});
