'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { BadgeCheck, Command } from 'lucide-react';

import { ReviewBadge } from '@/components/keel/review-badge';
import { Button, buttonVariants } from '@/components/ui/button';

function openQuickNav() {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
    }),
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Open quick navigation"
          onClick={openQuickNav}
        >
          <Command data-icon="inline-start" />
          <span aria-hidden="true">⌘K</span>
        </Button>
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
