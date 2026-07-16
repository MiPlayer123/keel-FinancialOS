'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Info, X } from 'lucide-react';

/**
 * Calm nudge shown on Home and Reports when some rows read as money-movement
 * (suggested transfers, credit-card / loan payoffs) but aren't confirmed
 * transfers yet — so the analytics that exclude them can shift once the user
 * confirms (Law 9: numbers carry their exclusions honestly). Dismissible for
 * the session; neutral stone surface, no red (Law 8 — red is negative money
 * only).
 */
export function TransferNudgeBanner({ count }: { count: number }) {
  const [dismissed, setDismissed] = useState(false);
  if (count <= 0 || dismissed) return null;
  const plural = count === 1 ? '' : 's';
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm">
      <Info className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-muted-foreground">
        {count} possible transfer{plural} {count === 1 ? "isn't" : "aren't"} confirmed yet —
        numbers may shift ·{' '}
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
