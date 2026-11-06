'use client';

import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Vercel only sees the page path. Query strings and fragments (search terms,
 * filters, OAuth codes) are dropped and record ids are replaced with ":id",
 * so no financial detail leaves the browser through analytics.
 */
export function scrubAnalyticsUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(UUID, ':id')}`;
  } catch {
    return raw.split(/[?#]/)[0]?.replace(UUID, ':id') ?? raw;
  }
}

/** Cookieless Vercel Web Analytics + Speed Insights, production deploys only. */
export function SiteAnalytics() {
  return (
    <>
      <Analytics beforeSend={(event) => ({ ...event, url: scrubAnalyticsUrl(event.url) })} />
      <SpeedInsights beforeSend={(event) => ({ ...event, url: scrubAnalyticsUrl(event.url) })} />
    </>
  );
}
