'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Info, X } from 'lucide-react';

/**
 * Calm nudge shown on Home and Reports when transfer SUGGESTIONS are pending.
 * Suggested pairings stay counted in spending until the user approves them
 * (explicit ownership — inference is never silently treated as fact, Law 9),
 * so the copy tells the truth: confirming in Review is what excludes them.
 * The count is suggestion PAIRS (the population Review actually shows), so it
 * drains to zero as the user acts. Dismissible for the session; neutral stone
 * surface, no red (Law 8 — red is negative money only).
 */
export function TransferNudgeBanner({ count }: { count: number }) {
  const [dismissed, setDismissed] = useState(false);
  if (count <= 0 || dismissed) return null;
  const plural = count === 1 ? '' : 's';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
      <Info className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        {count} suggested transfer{plural} {count === 1 ? 'is' : 'are'} still counted in
        spending — confirm{count === 1 ? ' it' : ' them'} to exclude ·{' '}
        <Link
          href="/dashboard/review"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Review
        </Link>
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => {
          setDismissed(true);
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
