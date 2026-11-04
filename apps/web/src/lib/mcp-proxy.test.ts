import { describe, expect, it } from 'vitest';
import {
  MCP_METADATA_PATH,
  forwardRequestHeaders,
  forwardResponseHeaders,
  metadataForSite,
  upstreamMcpUrl,
} from './mcp-proxy';

const SITE = 'https://keel.example.com';

describe('connector on the site domain', () => {
  it('forwards to the mcp function', () => {
    expect(upstreamMcpUrl('https://ref.supabase.co/')).toBe('https://ref.supabase.co/functions/v1/mcp');
  });

  it('passes the bearer token and MCP headers through, nothing else', () => {
    const out = forwardRequestHeaders(new Headers({
      authorization: 'Bearer t',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      cookie: 'sb-session=secret',
      'x-forwarded-for': '1.2.3.4',
    }));
    expect(out.get('authorization')).toBe('Bearer t');
    expect(out.get('mcp-protocol-version')).toBe('2025-11-25');
    expect(out.get('cookie')).toBeNull();
    expect(out.get('x-forwarded-for')).toBeNull();
  });

  it('points the sign-in challenge at this domain\'s metadata', () => {
    const out = forwardResponseHeaders(new Headers({
      'www-authenticate': 'Bearer resource_metadata="https://ref.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource", error="invalid_token"',
      'content-type': 'application/json',
      'content-length': '24',
      'content-encoding': 'gzip',
    }), SITE);
    expect(out.get('www-authenticate')).toBe(`Bearer resource_metadata="${SITE}${MCP_METADATA_PATH}", error="invalid_token"`);
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('content-length')).toBeNull();
    expect(out.get('content-encoding')).toBeNull();
  });

  it('restates the metadata for the site URL and keeps the sign-in server', () => {
    const body = metadataForSite({
      resource: 'https://ref.supabase.co/functions/v1/mcp',
      authorization_servers: ['https://ref.supabase.co/auth/v1'],
      scopes_supported: ['openid', 'email'],
    }, SITE);
    expect(body).toEqual({
      resource: `${SITE}/mcp`,
      authorization_servers: ['https://ref.supabase.co/auth/v1'],
      scopes_supported: ['openid', 'email'],
    });
  });
});
