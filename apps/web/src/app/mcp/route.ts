/**
 * `<site>/mcp`: the KEEL connector URL people paste into Claude, ChatGPT or
 * Codex. Forwards to the `mcp` Supabase function; see lib/mcp-proxy.ts.
 */
import { forwardRequestHeaders, forwardResponseHeaders, upstreamMcpUrl } from '@/lib/mcp-proxy';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024; // same cap as the function

async function forward(req: Request): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return Response.json({ error: 'not_configured' }, { status: 503 });
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  let upstream: Response;
  try {
    upstream = await fetch(upstreamMcpUrl(supabaseUrl), {
      method: req.method,
      headers: forwardRequestHeaders(req.headers),
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ error: 'temporarily_unavailable' }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: forwardResponseHeaders(upstream.headers, new URL(req.url).origin),
  });
}

export { forward as GET, forward as POST, forward as DELETE, forward as OPTIONS };
