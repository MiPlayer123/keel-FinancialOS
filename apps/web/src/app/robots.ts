import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';

/** Let crawlers fetch routes so page-level noindex directives remain observable. */
export default function robots(): MetadataRoute.Robots {
  const site = getSiteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
      },
    ],
    sitemap: new URL('/sitemap.xml', site).toString(),
  };
}
