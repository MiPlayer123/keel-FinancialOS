/**
 * OAuth 2.1 resource-server plumbing for the `mcp` function: discovery
 * metadata, the 401 challenge, and KEEL's token rules. Pure (no Deno, no
 * network) so every rule is unit-tested.
 *
 * Roles (MCP Authorization spec):
 *   - Authorization server: Supabase Auth's OAuth 2.1 server at
 *     `${SUPABASE_URL}/auth/v1` — DCR, PKCE, the token endpoint, and the
 *     consent redirect to KEEL's own /oauth/consent page.
 *   - Resource server: this function. It never issues tokens; it verifies
 *     them (signature + expiry via JWKS in @supabase/server), then applies
 *     the KEEL-specific rules below.
 *
 * Supabase serves everything for a function under `/functions/v1/<name>`, so
 * the RFC 9728 well-known URL at the domain root is out of our reach. The
 * 401 challenge therefore always carries `resource_metadata=` pointing at a
 * path INSIDE the function — that is the discovery hook MCP clients follow.
 */

/** Public URLs this resource server advertises. */
export interface McpPublicUrls {
  /** Canonical resource identifier (what users paste into Claude/Codex). */
  readonly resource: string;
  /** Where the Protected Resource Metadata document is served. */
  readonly resourceMetadata: string;
  /** The OAuth authorization server issuer. */
  readonly authorizationServer: string;
}

export const MCP_FUNCTION_NAME = 'mcp';
export const PRM_PATH = '/.well-known/oauth-protected-resource';

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * Derive the public URLs. `publicResourceUrl` lets a custom domain front the
 * function (e.g. https://keel.example/mcp via a rewrite) without changing the
 * issuer, which stays Supabase Auth.
 */
export const resolveMcpUrls = (supabaseUrl: string, publicResourceUrl?: string | null): McpPublicUrls => {
  const base = stripTrailingSlash(supabaseUrl);
  const resource = stripTrailingSlash(
    publicResourceUrl && publicResourceUrl.length > 0
      ? publicResourceUrl
      : `${base}/functions/v1/${MCP_FUNCTION_NAME}`,
  );
  return {
    resource,
    resourceMetadata: `${resource}${PRM_PATH}`,
    authorizationServer: `${base}/auth/v1`,
  };
};

/**
 * Scopes advertised to clients — the minimal OIDC set (MCP spec: keep
 * `scopes_supported` minimal; never list `offline_access`). Supabase's OAuth
 * server has no custom scopes ("scopes control OIDC data, not database
 * access"), so KEEL's capability split (read vs organize) is decided on
 * KEEL's consent screen and enforced here and in the database, not by the AS.
 */
export const MCP_SCOPES_SUPPORTED: readonly string[] = ['openid', 'email'];

/** RFC 9728 Protected Resource Metadata. */
export const buildProtectedResourceMetadata = (
  urls: McpPublicUrls,
  extra: { readonly documentationUrl?: string } = {},
): Record<string, unknown> => ({
  resource: urls.resource,
  authorization_servers: [urls.authorizationServer],
  scopes_supported: MCP_SCOPES_SUPPORTED,
  bearer_methods_supported: ['header'],
  resource_name: 'KEEL',
  ...(extra.documentationUrl ? { resource_documentation: extra.documentationUrl } : {}),
});

const quote = (s: string): string => `"${s.replace(/["\\]/g, '')}"`;

/**
 * The `WWW-Authenticate` challenge for 401/403 (RFC 6750 + RFC 9728 §5.1).
 * `error` is omitted when no token was sent (spec: the client simply has not
 * authenticated yet).
 */
export const buildWwwAuthenticate = (input: {
  readonly resourceMetadata: string;
  readonly error?: 'invalid_token' | 'insufficient_scope';
  readonly errorDescription?: string;
  readonly scope?: string;
}): string => {
  const parts = [`resource_metadata=${quote(input.resourceMetadata)}`];
  if (input.scope) parts.push(`scope=${quote(input.scope)}`);
  if (input.error) parts.push(`error=${quote(input.error)}`);
  if (input.errorDescription) parts.push(`error_description=${quote(input.errorDescription)}`);
  return `Bearer ${parts.join(', ')}`;
};

export interface McpTokenPolicy {
  /** Expected `iss`: `${SUPABASE_URL}/auth/v1`. */
  readonly expectedIssuer: string;
  /** Optional allowlist of OAuth client ids (empty = any client the user consented to). */
  readonly allowedClientIds: readonly string[];
  /**
   * Optional audience the token must carry (RFC 8707). Supabase accepts the
   * `resource` parameter but always mints `aud: "authenticated"`, so this
   * stays unset until an access-token hook (or a future AS) binds it. Until
   * then `client_id` is the only claim that distinguishes an AI-client token
   * from a KEEL web session.
   */
  readonly requiredAudience?: string;
}

export type McpTokenDecision =
  | { readonly ok: true; readonly userId: string; readonly clientId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'no_subject'
        | 'not_authenticated_role'
        | 'anonymous_user'
        | 'wrong_issuer'
        | 'wrong_audience'
        | 'not_an_oauth_client_token'
        | 'client_not_allowed';
    };

const audiences = (aud: unknown): string[] =>
  typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === 'string') : [];

/**
 * KEEL's rules on an already signature-verified JWT payload. Signature and
 * `exp` are checked upstream by @supabase/server against the project JWKS.
 */
export const checkMcpTokenClaims = (
  claims: Record<string, unknown>,
  policy: McpTokenPolicy,
): McpTokenDecision => {
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'no_subject' };
  if (claims['role'] !== 'authenticated') return { ok: false, reason: 'not_authenticated_role' };
  if (claims['is_anonymous'] === true) return { ok: false, reason: 'anonymous_user' };
  if (claims['iss'] !== policy.expectedIssuer) return { ok: false, reason: 'wrong_issuer' };
  if (policy.requiredAudience && !audiences(claims['aud']).includes(policy.requiredAudience)) {
    return { ok: false, reason: 'wrong_audience' };
  }

  // Only tokens minted by the OAuth server for a registered app carry
  // client_id; a KEEL web session never does and is refused here.
  const rawClient = claims['client_id'];
  const clientId = typeof rawClient === 'string' && rawClient.length > 0 ? rawClient : null;
  if (clientId === null) return { ok: false, reason: 'not_an_oauth_client_token' };
  if (policy.allowedClientIds.length > 0 && !policy.allowedClientIds.includes(clientId)) {
    return { ok: false, reason: 'client_not_allowed' };
  }
  return { ok: true, userId: sub, clientId };
};
