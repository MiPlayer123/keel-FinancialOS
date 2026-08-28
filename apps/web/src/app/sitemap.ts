import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl();
  return ['/', '/privacy', '/security', '/terms'].map((path) => ({
    url: new URL(path, site).toString(),
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.4,
  }));
}
