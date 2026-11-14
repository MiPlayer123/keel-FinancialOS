import type { MetadataRoute } from 'next';

// Web app manifest (Addendum §D: desktop-first, phone-capable). Icons are the
// KEEL keel-curve mark on the brand emerald tile; the maskable variant is
// full-bleed with the mark inside the safe zone.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'KEEL',
    short_name: 'KEEL',
    description: 'Personal and entity finance on an exact ledger.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#fafaf9',
    theme_color: '#007a55',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
