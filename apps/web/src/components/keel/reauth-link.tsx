'use client';

import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Compact row-level reauth affordance (teardown C8): when the owning
 * connection is `reauth_required`, the account row deep-links to the
 * Connections page where the fix lives. Neutral tokens only — red stays
 * reserved for negative money (Law 8); the broken-sync state is a status, and
 * it sits adjacent to the row it qualifies, not in a global banner.
 *
 * Rendered as a real link so it works inside "stretched-link" rows: give it
 * `relative z-10` via className to lift it above the row's overlay link.
 */
export function ReauthLink({
  className,
  compact = false,
  onNavigate,
}: {
  className?: string;
  /** Icon-only rendering for tight rails (sidebar). */
  compact?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <Link
      href="/dashboard/connections"
      onClick={() => onNavigate?.()}
      aria-label="Connection needs reauthorization — open Connections to reconnect"
      title="Connection needs reauthorization — reconnect"
      className={cn(
        'inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground',
        compact
          ? 'shrink-0'
          : 'rounded-full border border-border px-2 py-0.5 text-[11px] font-medium',
        className,
      )}
    >
      <TriangleAlert className="size-3 shrink-0" />
      {compact ? null : 'Reconnect'}
    </Link>
  );
}
