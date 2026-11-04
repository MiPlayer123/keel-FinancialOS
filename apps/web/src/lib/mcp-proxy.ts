/**
 * The KEEL connector on the app's own domain: `<site>/mcp` forwards to the
 * `mcp` Supabase function, and `<site>/.well-known/oauth-protected-resource/mcp`
 * says where to sign in. The function still does all the work (token checks,
 * grants, tools); this layer only moves bytes and names the public URL, so an
 * AI app sees one origin it can discover from. Pure helpers, used by the
 * route handlers in app/mcp.
 */

/** Public path of the protected-resource metadata (RFC 9728 location for `/mcp`). */
export const MCP_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

/** Request headers an MCP client may send that the function reads. */
const FORWARD_REQUEST = [
  'authorization',
  'content-type',
  'accept',
  'origin',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
  'last-event-id',
  'access-control-request-method',
  'access-control-request-headers',
];

/** Response headers worth passing back (never length or encoding: the body is re-streamed). */
const FORWARD_RESPONSE = new Set([
  'content-type',
  'cache-control',
  'allow',
  'mcp-session-id',
  'mcp-protocol-version',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]);

export const upstreamMcpUrl = (supabaseUrl: string): string =>
  `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp`;

export const forwardRequestHeaders = (incoming: Headers): Headers => {
  const out = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = incoming.get(name);
    if (value) out.set(name, value);
  }
  return out;
};

/**
 * Response headers for the client. The function's sign-in challenge names its
 * own metadata URL; on this domain it must name ours, or the app would sign in
 * against a different resource than the URL the user entered.
 */
export const forwardResponseHeaders = (upstream: Headers, siteOrigin: string): Headers => {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (FORWARD_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  });
  const challenge = upstream.get('www-authenticate');
  if (challenge) {
    out.set(
      'www-authenticate',
      challenge.replace(/resource_metadata="[^"]*"/, `resource_metadata="${siteOrigin}${MCP_METADATA_PATH}"`),
    );
  }
  return out;
};

/** The function's metadata, restated for this domain's URL (everything else unchanged). */
export const metadataForSite = (upstream: Record<string, unknown>, siteOrigin: string): Record<string, unknown> => ({
  ...upstream,
  resource: `${siteOrigin}/mcp`,
});
