import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';

/** Allow all crawlers (search + LLM) on public pages; the app itself is auth-gated noise. */
export default function robots(): MetadataRoute.Robots {
  const site = getSiteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/login', '/reset-password'],
      },
    ],
    sitemap: new URL('/sitemap.xml', site).toString(),
  };
}
