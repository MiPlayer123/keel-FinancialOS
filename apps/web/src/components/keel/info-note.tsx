'use client';

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * How-this-is-calculated note behind a small ⓘ (TLDR first, proof on demand —
 * Law 11). Scope and exclusions stay disclosed (Law 9) without a paragraph
 * under every chart. A popover, not a tooltip, so it opens on tap too.
 */
export function InfoNote({ children, label = 'How this is calculated' }: { children: ReactNode; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-1 p-3 text-xs leading-relaxed text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
