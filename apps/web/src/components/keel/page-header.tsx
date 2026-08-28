'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertCircle, BadgeCheck, Search } from 'lucide-react';

import { ReviewBadge } from '@/components/keel/review-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function openQuickNav() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
    }),
  );
}

/**
 * The palette trigger. Desktop shows a muted search-bar affordance (icon +
 * "Search…" + a ⌘K hint chip) à la Linear/Monarch; mobile — where there is no
 * keyboard shortcut and less room — collapses to a single search icon button.
 * Both open the same command palette (via the synthetic ⌘K the global
 * QuickNav listens for). The ⌘K glyph is desktop-only: it is meaningless on a
 * phone.
 */
function QuickNavTrigger() {
  return (
    <>
      {/* Desktop: search-bar affordance */}
      <button
        type="button"
        aria-label="Search or jump to…"
        onClick={openQuickNav}
        className={cn(
          'hidden h-8 w-56 items-center gap-2 rounded-lg border border-input/60 bg-input/30 px-2.5',
          'text-sm text-muted-foreground shadow-none transition-colors',
          'hover:bg-input/50 hover:text-foreground',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          'sm:flex',
        )}
      >
        <Search className="size-4 shrink-0 opacity-60" />
        <span className="flex-1 text-left">Search…</span>
        <kbd
          aria-hidden="true"
          className="pointer-events-none inline-flex h-5 shrink-0 select-none items-center gap-0.5 rounded border border-border bg-background px-1.5 font-sans text-[0.7rem] font-medium text-muted-foreground"
        >
          ⌘K
        </kbd>
      </button>
      {/* Mobile: compact icon button */}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Search or jump to…"
        onClick={openQuickNav}
        className="sm:hidden"
      >
        <Search />
      </Button>
    </>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Link
          href="/dashboard/review"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <BadgeCheck data-icon="inline-start" />
          Review
          <ReviewBadge />
        </Link>
        <QuickNavTrigger />
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function QueryErrorState({
  description,
  onRetry,
}: {
  description: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      icon={<AlertCircle className="size-6" />}
      title="We couldn't load this data"
      description={description}
      action={
        onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
