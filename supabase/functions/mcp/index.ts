/**
 * KEEL `mcp` — the remote MCP server AI apps connect to (Claude, Codex,
 * ChatGPT). One URL for every user; each request runs as the signed-in user
 * through their own token, pinned to the household they chose when they
 * connected the app. See README.md in this folder.
 *
 * Request path:
 *   1. Discovery: GET /.well-known/oauth-protected-resource (public).
 *   2. No/invalid bearer → 401 + WWW-Authenticate resource_metadata, which
 *      is what starts sign-in in MCP clients. verify_jwt is off at the
 *      gateway so this function, not the platform, answers.
 *   3. Token: signature + expiry against the project JWKS (@supabase/server),
 *      then KEEL's rules (issuer, authenticated, client_id present).
 *   4. Grant: the user's live KEEL grant for this app (household + read or
 *      write), read with the app's own token through the gateway header.
 *   5. MCP: the official SDK serves the tools that grant allows.
 *
 * Nothing works until Supabase Auth's OAuth server is enabled (⚑ dashboard
 * step): without it no app token can exist. KEEL_MCP_ENABLED=off is the
 * emergency kill switch. The service key is used for exactly one thing:
 * reading the gateway key from the vault (keel_mcp_gateway_key()); every
 * tool runs through the caller's own token.
 */
import { createMcpHandler } from 'npm:@modelcontextprotocol/server@2.4.0';
import { createAdminClient, createContextClient, verifyAuth } from 'npm:@supabase/server@1.3.0/core';
import {
  authorize,
  CommandEnvelopeSchema,
  EntityIdSchema,
  AccountIdSchema,
  parseCommandPayload,
} from '../_shared/vendor/keel-domain.mjs';
import { loadAuthzContextRows } from '../_shared/authz-context.ts';
import { executeCommand, type CommandContract } from '../_shared/command-exec.ts';
import { toSnakeKeys } from '../_shared/http.ts';
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  checkMcpTokenClaims,
  isAllowedOrigin,
  PRM_PATH,
  resolveMcpUrls,
} from './auth.ts';
import type { Access, ToolContext, UserClient } from './context.ts';
import { dbError, err } from './lib.ts';
import { buildServer } from './server.ts';

const env = (name: string): string => Deno.env.get(name) ?? '';
const list = (name: string): string[] => env(name).split(',').map((s) => s.trim()).filter(Boolean);

const SUPABASE_URL = env('SUPABASE_URL');
const ENABLED = env('KEEL_MCP_ENABLED') !== 'off' && SUPABASE_URL !== '';

/**
 * The gateway key that lets this function's requests past keel_pre_request.
 * Generated inside the database by the migration and read once per isolate
 * with the platform's secret key; KEEL_MCP_GATEWAY_KEY overrides (local runs).
 */
let gatewayKey: Promise<string | null> | null = null;
const loadGatewayKey = (): Promise<string | null> =>
  (gatewayKey ??= (async () => {
    if (env('KEEL_MCP_GATEWAY_KEY')) return env('KEEL_MCP_GATEWAY_KEY');
    const admin: UserClient = createAdminClient();
    const { data, error } = await admin.rpc('keel_mcp_gateway_key');
    if (error || typeof data !== 'string' || data.length === 0) {
      console.error('mcp_gateway_key_unavailable', error?.code ?? 'missing');
      gatewayKey = null; // retry on the next request
      return null;
    }
    return data;
  })());
const URLS = resolveMcpUrls(SUPABASE_URL, env('KEEL_MCP_PUBLIC_URL') || null);
const TOKEN_POLICY = {
  expectedIssuer: URLS.authorizationServer,
  allowedClientIds: list('KEEL_MCP_ALLOWED_CLIENT_IDS'),
};
const ALLOWED_ORIGINS = list('KEEL_MCP_ALLOWED_ORIGINS');
const MAX_BODY_BYTES = 256 * 1024;

const COMMAND_CONTRACT: CommandContract = {
  parseEnvelope: (body) => CommandEnvelopeSchema.safeParse(body) as ReturnType<CommandContract['parseEnvelope']>,
  parsePayload: (command, payload) => parseCommandPayload(command as never, payload),
  authorize: (ctx, action, resource) =>
    authorize(ctx as never, action as never, resource as never) as ReturnType<CommandContract['authorize']>,
  isEntityId: (v) => EntityIdSchema.safeParse(v).success,
  isAccountId: (v) => AccountIdSchema.safeParse(v).success,
  toSnakeKeys,
};

const mcp = createMcpHandler(
  ({ authInfo }) => buildServer((authInfo?.extra as { ctx: ToolContext }).ctx),
  { responseMode: 'json', onerror: (e) => console.error('mcp_transport_error', e.name) },
);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const cors = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id',
        'access-control-expose-headers': 'www-authenticate, mcp-session-id',
        vary: 'origin',
      }
    : {};

const challenge = (origin: string | null, error?: 'invalid_token', description?: string) =>
  json(401, { error: error ?? 'unauthorized', ...(description ? { error_description: description } : {}) }, {
    'www-authenticate': buildWwwAuthenticate({
      resourceMetadata: URLS.resourceMetadata,
      ...(error ? { error } : {}),
      ...(description ? { errorDescription: description } : {}),
    }),
    ...cors(origin),
  });

/** Everything a tool needs, scoped to this caller and grant. */
const makeContext = (
  db: UserClient,
  claims: { userId: string; clientId: string },
  grant: { householdId: string; access: Access },
): ToolContext => {
  const now = new Date();
  let authzRows: Promise<unknown> | null = null;
  const loadAuthz = () => (authzRows ??= loadAuthzContextRows(db, claims.userId));
  return {
    userId: claims.userId,
    clientId: claims.clientId,
    householdId: grant.householdId,
    access: grant.access,
    nowIso: now.toISOString(),
    todayIso: now.toISOString().slice(0, 10),
    db,
    rpc: async (proc, args) => {
      const { data, error } = await db.rpc(proc, args);
      return { data, error };
    },
    authorize: async (action, resource = {}) =>
      authorize((await loadAuthz()) as never, action as never, { householdId: grant.householdId, ...resource } as never).allowed,
    command: async (command, payload, idempotencyKey) => {
      if (grant.access !== 'write') return err('read_only', 'This app was connected with read-only access.', 'The user can allow changes in KEEL → Settings → Connected apps.');
      const commandId = crypto.randomUUID();
      // Fresh authz rows per command (as the app loads per request): a tool
      // that creates an account and then books its opening balance must see
      // the new ownership.
      const outcome = await executeCommand(COMMAND_CONTRACT, db, () => loadAuthzContextRows(db, claims.userId), {
        commandId,
        command,
        economicEventKey: `mcp:${claims.clientId}:${command}:${idempotencyKey ?? commandId}`.slice(0, 256),
        actor: { kind: 'user', userId: claims.userId },
        householdId: grant.householdId,
        payload,
      });
      if (outcome.ok) return { ok: true, data: outcome.data };
      if ('dbError' in outcome) return dbError(outcome.dbError);
      return err(outcome.code === 'invalid_command' ? 'invalid_request' : outcome.code, outcome.message);
    },
  };
};

export const handle = async (req: Request): Promise<Response> => {
  if (!ENABLED) return json(404, { error: 'not_found' });
  const origin = req.headers.get('origin');
  if (!isAllowedOrigin(origin, ALLOWED_ORIGINS)) return json(403, { error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

  const path = new URL(req.url).pathname.replace(/^\/(?:functions\/v1\/)?mcp/, '') || '/';
  if (path === PRM_PATH) {
    return req.method === 'GET'
      ? json(200, buildProtectedResourceMetadata(URLS, env('KEEL_MCP_DOCS_URL') ? { documentationUrl: env('KEEL_MCP_DOCS_URL') } : {}), {
          'cache-control': 'public, max-age=300',
          ...cors(origin),
        })
      : json(405, { error: 'method_not_allowed' }, { allow: 'GET', ...cors(origin) });
  }
  if (path !== '/') return json(404, { error: 'not_found' }, cors(origin));
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST', ...cors(origin) });

  // --- Authentication: a 401 is what starts sign-in in MCP clients ---
  if (!/^Bearer\s+\S+$/i.test(req.headers.get('authorization') ?? '')) return challenge(origin);
  const { data: auth, error: authError } = await verifyAuth(req, { auth: 'user' });
  if (authError || !auth?.jwtClaims || !auth.token) return challenge(origin, 'invalid_token', 'The access token is invalid or expired.');
  const decision = checkMcpTokenClaims(auth.jwtClaims as Record<string, unknown>, TOKEN_POLICY);
  if (!decision.ok) {
    console.log('mcp_token_rejected', JSON.stringify({ reason: decision.reason }));
    return challenge(origin, 'invalid_token', 'This token was not issued to a connected app for KEEL.');
  }

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' }, cors(origin));

  // --- Grant: what the user allowed this app (KEEL's consent page) ---
  const key = await loadGatewayKey();
  if (!key) return json(503, { error: 'temporarily_unavailable' }, cors(origin));
  const db: UserClient = createContextClient({
    auth: { token: auth.token },
    supabaseOptions: { global: { headers: { 'x-keel-mcp-gateway': key } } },
  });
  const { data: grant, error: grantError } = await db.rpc('keel_mcp_grant_current');
  if (grantError) {
    console.error('mcp_grant_lookup_failed', grantError.code);
    return json(503, { error: 'temporarily_unavailable' }, cors(origin));
  }
  if (!grant) {
    // Not a 401: the OAuth consent exists, so re-authorizing would loop.
    return json(403, {
      error: 'access_not_granted',
      error_description: 'This app is signed in but has no KEEL access. Open KEEL → Settings → Connected apps to choose its access, or disconnect it and connect again.',
    }, cors(origin));
  }

  const ctx = makeContext(db, decision, grant as { householdId: string; access: Access });
  const res = await mcp.fetch(req, {
    authInfo: { token: auth.token, clientId: decision.clientId, scopes: [], extra: { ctx } },
  });
  if (!origin) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
};

export default { fetch: handle };
