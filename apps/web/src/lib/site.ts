const FALLBACK_SITE_URL = 'https://keel.mikulsaravanan.com';

export function getSiteUrl(): URL {
  const configured = process.env['NEXT_PUBLIC_SITE_URL']?.trim();
  try {
    return new URL(configured || FALLBACK_SITE_URL);
  } catch {
    return new URL(FALLBACK_SITE_URL);
  }
}
