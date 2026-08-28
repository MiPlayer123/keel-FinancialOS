'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

/** Floating pill nav: a centered rounded island that lifts slightly on scroll. */
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <header className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        className={cn(
          'flex items-center gap-1 rounded-full border border-border/80 bg-background/85 py-1.5 pl-4 pr-1.5 backdrop-blur-md transition-shadow duration-300',
          scrolled ? 'shadow-lg shadow-stone-900/10 dark:shadow-black/30' : 'shadow-sm',
        )}
      >
        <Link href="/" aria-label="KEEL home" className="mr-1">
          <KeelLogo />
        </Link>
        <nav className="hidden items-center text-sm text-muted-foreground sm:flex">
          <a
            href="#principles"
            className="rounded-full px-3 py-1.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Principles
          </a>
          <a
            href="#features"
            className="rounded-full px-3 py-1.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Features
          </a>
          <a
            href="#open-source"
            className="rounded-full px-3 py-1.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open source
          </a>
        </nav>
        <ThemeToggle />
        <Link
          href="/login"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'hidden rounded-full sm:inline-flex',
          )}
        >
          Sign in
        </Link>
        <Link
          href="/login#signup"
          className={cn(buttonVariants({ size: 'sm' }), 'rounded-full')}
        >
          Get started
        </Link>
      </div>
    </header>
  );
}
