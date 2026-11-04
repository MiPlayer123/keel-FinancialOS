import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // NAVLAYOUT-6 / MOBILE-7 / NAVLAYOUT-5: the floating circular "N" seen
  // bottom-left on every screen (overlapping the "Biggest purchase" money card
  // at 390px, the sidebar "Sign out" label, and the pre-auth login shell) is
  // Next.js's dev-mode build indicator, not KEEL chrome. It has no user
  // function, so we remove it rather than reposition it.
  devIndicators: false,
  // The connector at <site>/mcp: AI apps look for its sign-in metadata at the
  // RFC 9728 well-known paths (app/mcp/oauth-protected-resource answers).
  rewrites() {
    return Promise.resolve([
      { source: '/.well-known/oauth-protected-resource/mcp', destination: '/mcp/oauth-protected-resource' },
      { source: '/.well-known/oauth-protected-resource', destination: '/mcp/oauth-protected-resource' },
    ]);
  },
  // The AI-app consent screen must never be framed (clickjacking an "Allow").
  headers() {
    return Promise.resolve([
      {
        source: '/oauth/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ]);
  },
};

export default nextConfig;
