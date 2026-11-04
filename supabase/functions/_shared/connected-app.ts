/**
 * Tokens minted by Supabase Auth's OAuth 2.1 server for a connected AI app
 * (Claude, Codex, ChatGPT) carry a `client_id` claim. Supabase cannot bind an
 * audience — every token says `aud: "authenticated"` — so this claim is the
 * only thing separating "an app the user connected" from "the user's own KEEL
 * session". Connected-app tokens are for the `mcp` surface only.
 */
export const isThirdPartyClientToken = (claims: Record<string, unknown> | null | undefined): boolean =>
  claims !== null &&
  claims !== undefined &&
  typeof claims['client_id'] === 'string' &&
  (claims['client_id'] as string).length > 0;
