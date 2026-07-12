import Link from 'next/link';
import { ArrowRight, ShieldCheck, Scale, Sparkles, Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { KeelLogo, KeelMark } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';

const principles = [
  {
    icon: Scale,
    title: 'Deterministic ledger',
    body: 'Real double-entry. Every transaction balances to zero, in exact minor units. No floats, no fudging.',
  },
  {
    icon: Sparkles,
    title: 'AI suggests, never acts',
    body: 'Categorization, transfers, recurring — proposed for your approval. Nothing touches money on its own.',
  },
  {
    icon: ShieldCheck,
    title: 'Auditable & reversible',
    body: 'Every change is recorded and undoable. Corrections are revisions, not deletions.',
  },
  {
    icon: Download,
    title: 'Your data, always',
    body: 'Full export to CSV, JSON, QIF and beancount — any time. The exit door is a feature.',
  },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
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
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            AI-first personal &amp; entity finance
          </div>
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
            <Link href="/login" className={buttonVariants({ size: 'lg', variant: 'outline' })}>
              Create an account
            </Link>
          </div>
        </section>

        <section className="mt-20 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {principles.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex flex-col gap-3 bg-card p-5">
              <Icon className="size-5 text-primary" />
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <KeelMark className="size-4" />
          KEEL
        </span>
        <span>Deterministic spine · calibrated AI · full export</span>
      </footer>
    </div>
  );
}
