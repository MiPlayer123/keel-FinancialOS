/**
 * KEEL MCP HTTP layer — turns a Request into a Response for the `mcp` Edge
 * Function. Pure orchestration with every capability injected (token
 * verification, database access, clock, logger), so the whole request path —
 * discovery, 401 challenge, token rules, household pinning, protocol — is
 * unit-tested without Deno or Supabase.
 *
 * Endpoints (paths relative to the function root `/mcp`):
 *   GET  /.well-known/oauth-protected-resource  RFC 9728 metadata (public)
 *   POST /                                      MCP JSON-RPC (bearer token)
 *   GET|DELETE /                                405 — no SSE stream, no sessions
 */
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  checkMcpTokenClaims,
  isAllowedOrigin,
  pickHousehold,
  PRM_PATH,
  type McpPublicUrls,
  type McpTokenPolicy,
} from './mcp-auth.ts';
import { handleMcpMessage, isAcceptableProtocolHeader, type McpServerInfo, type McpTool, type McpToolResult } from './mcp-protocol.ts';
import { makeMcpToolbox, mcpToolsFor, type McpCapability } from './mcp-tools.ts';
import type { AuthorizeFn } from './agent.ts';

/** A caller whose bearer token passed signature + expiry verification. */
export interface VerifiedCaller {
  readonly claims: Record<string, unknown>;
  /** Calls a proc through the CALLER's client (auth.uid() reaches the DB). */
  readonly rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** Loads the authz context rows (memberships etc.) through the caller's client. */
  readonly loadAuthz: () => Promise<{
    readonly ctx: unknown;
    readonly memberships: readonly { readonly householdId: string; readonly role: string }[];
  }>;
}

export interface McpHttpDeps {
  readonly enabled: boolean;
  readonly urls: McpPublicUrls;
  readonly tokenPolicy: McpTokenPolicy;
  readonly allowedOrigins: readonly string[];
  readonly documentationUrl?: string;
  readonly serverInfo: McpServerInfo;
  readonly instructions: string;
  readonly authorize: AuthorizeFn;
  readonly queryToProc: Readonly<Record<string, string>>;
  /** Signature/expiry check of the bearer token; null when invalid. */
  readonly verify: (token: string, req: Request) => Promise<VerifiedCaller | null>;
  /** Capabilities this user granted this client. */
  readonly capabilitiesFor: (input: { readonly userId: string; readonly clientId: string | null }) => Promise<ReadonlySet<McpCapability>>;
  /** Household the user pinned for this client, if any. */
  readonly pinnedHouseholdFor: (input: { readonly userId: string; readonly clientId: string | null }) => Promise<string | null>;
  readonly now: () => Date;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 256 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json' };

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name',
        'access-control-expose-headers': 'www-authenticate',
        vary: 'origin',
      }
    : {};

const respond = (
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? extraHeaders : { ...JSON_HEADERS, ...extraHeaders },
  });

/** Strip the function-name prefix the Edge runtime leaves on the path. */
export const routePath = (pathname: string): string => {
  const stripped = pathname.replace(/^\/(?:functions\/v1\/)?mcp/, '');
  return stripped === '' ? '/' : stripped;
};

const bearerToken = (req: Request): string | null => {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
};

/** Tool calls when no household can be pinned: explain, never guess (Law 9). */
const householdErrorResult = (reason: string): McpToolResult => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        error: reason,
        detail:
          reason === 'ambiguous_household'
            ? 'This KEEL account belongs to more than one household. Pick one for this app in KEEL → Settings → Connected apps.'
            : 'This KEEL account has no household yet. Finish onboarding in the KEEL app first.',
      }),
    },
  ],
  isError: true,
});

export const makeMcpHttpHandler = (deps: McpHttpDeps) => async (req: Request): Promise<Response> => {
  const startedAt = deps.now().getTime();
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // Kill switch: the surface is dark until a human turns it on (⚑ CLAUDE.md).
  if (!deps.enabled) return respond(404, { error: 'not_found' });

  if (!isAllowedOrigin(origin, deps.allowedOrigins)) {
    return respond(403, { error: 'origin_not_allowed' });
  }
  if (req.method === 'OPTIONS') return respond(204, null, cors);

  const path = routePath(new URL(req.url).pathname);

  if (path === PRM_PATH) {
    if (req.method !== 'GET') return respond(405, { error: 'method_not_allowed' }, { allow: 'GET', ...cors });
    return respond(
      200,
      buildProtectedResourceMetadata(deps.urls, deps.documentationUrl ? { documentationUrl: deps.documentationUrl } : {}),
      { 'cache-control': 'public, max-age=300', ...cors },
    );
  }

  if (path !== '/') return respond(404, { error: 'not_found' }, cors);
  if (req.method !== 'POST') {
    // No standalone SSE stream and no sessions: GET/DELETE are 405 (spec-allowed).
    return respond(405, { error: 'method_not_allowed' }, { allow: 'POST', ...cors });
  }

  // --- Authentication (401 is the ONLY thing that starts sign-in in Claude) ---
  const challenge = (error?: 'invalid_token', description?: string) =>
    respond(
      401,
      { error: error ?? 'unauthorized', ...(description ? { error_description: description } : {}) },
      {
        'www-authenticate': buildWwwAuthenticate({
          resourceMetadata: deps.urls.resourceMetadata,
          ...(error ? { error } : {}),
          ...(description ? { errorDescription: description } : {}),
        }),
        ...cors,
      },
    );

  const token = bearerToken(req);
  if (token === null) return challenge();
  const caller = await deps.verify(token, req);
  if (caller === null) return challenge('invalid_token', 'The access token is invalid or expired.');
  const decision = checkMcpTokenClaims(caller.claims, deps.tokenPolicy);
  if (!decision.ok) {
    deps.log('mcp_token_rejected', { reason: decision.reason });
    return challenge('invalid_token', 'This token was not issued to a connected app for KEEL.');
  }

  // --- Transport checks ---
  if (!isAcceptableProtocolHeader(req.headers.get('mcp-protocol-version'))) {
    return respond(400, { error: 'unsupported_protocol_version' }, cors);
  }
  const accept = req.headers.get('accept');
  if (accept && !/application\/json|\*\/\*/i.test(accept)) {
    return respond(406, { error: 'not_acceptable' }, cors);
  }
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return respond(413, { error: 'payload_too_large' }, cors);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return respond(413, { error: 'payload_too_large' }, cors);
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }, cors);
  }

  // --- Per-request tool surface (stateless: rebuilt every call) ---
  const who = { userId: decision.userId, clientId: decision.clientId };
  const method = typeof (message as Record<string, unknown> | null)?.['method'] === 'string'
    ? ((message as Record<string, unknown>)['method'] as string)
    : null;

  // tools/list depends only on what the user granted this client — no
  // database round trip, and the list never silently empties.
  let listTools: () => readonly McpTool[] = () => [];
  let callTool: (n: string, a: Record<string, unknown>) => Promise<McpToolResult | null> = () =>
    Promise.resolve(null);
  if (method === 'tools/list' || method === 'tools/call') {
    const capabilities = await deps.capabilitiesFor(who);
    const tools = mcpToolsFor(capabilities);
    listTools = () => tools;
    if (method === 'tools/call') {
      const [pinned, authz] = await Promise.all([deps.pinnedHouseholdFor(who), caller.loadAuthz()]);
      const household = pickHousehold(authz.memberships, pinned);
      if (household.ok) {
        callTool = makeMcpToolbox({
          authorize: deps.authorize,
          authzCtx: authz.ctx,
          householdId: household.householdId,
          rpc: caller.rpc,
          queryToProc: deps.queryToProc,
          capabilities,
          nowIso: deps.now().toISOString(),
        }).callTool;
      } else {
        const granted = new Set(tools.map((t) => t.name));
        callTool = (name) => Promise.resolve(granted.has(name) ? householdErrorResult(household.reason) : null);
      }
    }
  }

  const outcome = await handleMcpMessage(message, {
    serverInfo: deps.serverInfo,
    instructions: deps.instructions,
    listTools,
    callTool,
  });

  // Audit-friendly, PII-free: who (opaque ids), what (method/tool), outcome.
  const params = (message as Record<string, unknown> | null)?.['params'] as Record<string, unknown> | undefined;
  deps.log('mcp_request', {
    method,
    tool: method === 'tools/call' && typeof params?.['name'] === 'string' ? params['name'] : undefined,
    clientId: decision.clientId,
    status: outcome.status,
    isError:
      outcome.status === 200 &&
      ('error' in outcome.body ||
        (outcome.body['result'] as Record<string, unknown> | undefined)?.['isError'] === true),
    latencyMs: deps.now().getTime() - startedAt,
  });

  return outcome.status === 202 ? respond(202, null, cors) : respond(outcome.status, outcome.body, cors);
};
