import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { KeelLogo, KeelMark } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { RedirectIfAuthed } from '@/components/keel/redirect-if-authed';

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <RedirectIfAuthed />
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5">
        <KeelLogo />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Link href="/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-16">
        <section className="max-w-2xl">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            Your financial <span className="text-primary">system of record.</span>
          </h1>
          <p className="mt-6 text-balance text-lg leading-relaxed text-muted-foreground">
            KEEL keeps a precise, double-entry ledger of everything you and your entities own,
            owe, earn and spend — with AI that does the tedious parts and asks before it acts.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href="/login" className={buttonVariants({ size: 'lg' })}>
              Sign in
              <ArrowRight className="size-4" />
            </Link>
            <Link href="/login#signup" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
              Create an account
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-5xl items-center px-6 py-6 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <KeelMark className="size-4" />
          KEEL
        </span>
      </footer>
    </div>
  );
}
