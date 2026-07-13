'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Shared stale time for every `useKeelQuery`/`useKeelQuerySilent` read (see
 * `@/lib/use-keel-query`). 45s: long enough that repeat navigation across
 * dashboard pages (Home -> Accounts -> Home) shows cached data instantly
 * instead of a full loading skeleton, short enough that an edit the user
 * just made (categorize, budget, goal contribution, ...) reliably shows up
 * next time that data is viewed within the same short session.
 */
export const KEEL_QUERY_STALE_TIME_MS = 45_000;

export function QueryProvider({ children }: { children: ReactNode }) {
  // Created once per browser session (lazy useState initializer), not on
  // every render — a fresh QueryClient per render would defeat caching.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: KEEL_QUERY_STALE_TIME_MS,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
