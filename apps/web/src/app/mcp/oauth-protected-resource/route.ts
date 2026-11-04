/**
 * Protected-resource metadata for `<site>/mcp`, served at
 * `/.well-known/oauth-protected-resource/mcp` (and the bare well-known path)
 * through rewrites in next.config.ts. Restates the function's own metadata with
 * this domain's URL, so there is one source for the sign-in server and scopes.
 */
import { metadataForSite, upstreamMcpUrl } from '@/lib/mcp-proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return Response.json({ error: 'not_configured' }, { status: 503 });
  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamMcpUrl(supabaseUrl)}/.well-known/oauth-protected-resource`, { cache: 'no-store' });
  } catch {
    return Response.json({ error: 'temporarily_unavailable' }, { status: 502 });
  }
  if (!upstream.ok) return Response.json({ error: 'temporarily_unavailable' }, { status: 502 });
  const body = metadataForSite((await upstream.json()) as Record<string, unknown>, new URL(req.url).origin);
  return Response.json(body, {
    headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
  });
}
