import type { ReactNode } from 'react';
import Link from 'next/link';

import { KeelLogo } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';

export function PublicPageShell({
  title,
  description,
  updated,
  children,
}: {
  title: string;
  description: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" aria-label="KEEL home">
            <KeelLogo />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link href="/login" className="text-sm font-medium hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
        <header className="border-b border-border pb-8">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">{description}</p>
          <p className="mt-3 text-xs text-muted-foreground">Last updated {updated}</p>
        </header>
        <div className="flex flex-col gap-10 py-10 text-sm leading-7 text-muted-foreground">
          {children}
        </div>
      </main>
      <footer className="border-t border-border">
        <nav className="mx-auto flex w-full max-w-4xl flex-wrap gap-x-5 gap-y-2 px-6 py-8 text-sm text-muted-foreground">
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="/security" className="hover:text-foreground">
            Security
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <a
            href="https://github.com/MiPlayer123/keel-FinancialOS"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
      </footer>
    </div>
  );
}

export function PublicSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}
