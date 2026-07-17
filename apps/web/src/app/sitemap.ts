import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://keel.mikulsaravanan.com/',
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: 'https://keel.mikulsaravanan.com/login',
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ];
}
