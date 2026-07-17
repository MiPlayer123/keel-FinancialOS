'use client';

import dynamic from 'next/dynamic';

/**
 * Code-split wrapper: keeps recharts (~120 KB gz) out of the landing route's
 * critical bundle (Lighthouse ≥95 budget). Placeholder mirrors the mockup's
 * footprint to avoid layout shift.
 */
export const HeroMockupLazy = dynamic(
  () => import('./hero-mockup').then((m) => m.HeroMockup),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden
        className="h-[44rem] rounded-xl border border-border bg-card shadow-2xl md:h-[27rem]"
      />
    ),
  },
);
