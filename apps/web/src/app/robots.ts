import type { MetadataRoute } from 'next';

/** Allow all crawlers (search + LLM) on public pages; the app itself is auth-gated noise. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard'],
      },
    ],
    sitemap: 'https://keel.mikulsaravanan.com/sitemap.xml',
  };
}
