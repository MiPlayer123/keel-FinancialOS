import Link from 'next/link';
import {
  ArrowRight,
  BookOpenCheck,
  Building2,
  CalendarClock,
  DownloadCloud,
  Equal,
  Scale,
  ShieldCheck,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { KeelMark } from '@/components/keel/logo';
import { RedirectIfAuthed } from '@/components/keel/redirect-if-authed';
import { HeroMockupLazy } from '@/components/keel/landing/hero-mockup-lazy';
import { LandingNav } from '@/components/keel/landing/landing-nav';
import { Reveal } from '@/components/keel/landing/reveal';
import { cn } from '@/lib/utils';

/* Honest guarantees, benefit-first — no invented social proof. */
const GUARANTEES = [
  {
    icon: Equal,
    claim: 'Never off by a cent',
    detail: 'Every transaction must balance to zero — the database itself enforces it.',
  },
  {
    icon: Undo2,
    claim: 'Nothing is ever lost',
    detail: 'History is append-only. Every change is audited, and every one is undoable.',
  },
  {
    icon: ShieldCheck,
    claim: 'AI never acts alone',
    detail: 'Material changes wait for your approval, with confidence and evidence attached.',
  },
  {
    icon: DownloadCloud,
    claim: 'Leave with everything',
    detail: 'One click exports it all — CSV, JSON, QIF & Beancount. Always.',
  },
];

const FEATURES = [
  {
    icon: Scale,
    title: 'A real ledger',
    body: 'Double-entry postings that always sum to zero. History is append-only: corrections are reversals, never edits, so your numbers can always show their work.',
    wide: true,
  },
  {
    icon: Sparkles,
    title: 'AI that asks first',
    body: 'Suggestions arrive typed — verdict, confidence, evidence — and wait for your approve. Nothing fuzzy ever touches the arithmetic.',
    ladder: true,
    wide: true,
  },
  {
    icon: Building2,
    title: 'Built for entities',
    body: 'Your personal accounts and your LLC on one spine — cleanly scoped, reported separately, never mixed.',
  },
  {
    icon: CalendarClock,
    title: 'Plans that stay honest',
    body: 'Budgets with rollover, recurring detection, goals and cash-flow forecast — all computed from the ledger, all reproducible.',
  },
  {
    icon: BookOpenCheck,
    title: 'Close your books',
    body: 'Statement reconciliation with real period locks. A locked month stays locked unless you reopen it with a reason.',
  },
  {
    icon: DownloadCloud,
    title: 'Leave anytime',
    body: 'The Data Access Guarantee is a feature, not a promise: one click exports everything you own, forever.',
  },
];

const RISK_LADDER = [
  { grade: 'A', label: 'auto + undo' },
  { grade: 'B', label: 'suggest → approve' },
  { grade: 'C', label: 'preview only' },
  { grade: 'D', label: 'disabled' },
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      {/* Without JS the reveal-on-scroll content must simply be visible. */}
      <noscript>
        <style>{`[data-reveal]{opacity:1 !important;transform:none !important}`}</style>
      </noscript>
      <RedirectIfAuthed />
      <LandingNav />

      {/* ————— Hero ————— */}
      <main className="flex-1">
        <section className="relative">
          {/* calm emerald wash behind the hero — never neon */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(60rem_28rem_at_50%_-4rem,color-mix(in_oklab,var(--primary)_9%,transparent),transparent_70%)]"
          />
          <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-32 sm:pb-24 sm:pt-40">
            <div className="mx-auto max-w-3xl text-center">
              <p className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-backwards inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground duration-700">
                <KeelMark className="size-3.5" />
                Personal + entity finance, on one spine
              </p>
              <h1 className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards mt-6 text-balance text-4xl font-semibold tracking-tight delay-100 duration-700 sm:text-6xl">
                Every dollar,{' '}
                <span className="text-primary">accounted for.</span>
              </h1>
              <p className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards mx-auto mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground delay-200 duration-700">
                KEEL is a double-entry system of record for everything you and your
                entities own, owe, earn and spend — with AI that does the tedious
                parts and asks before it acts.
              </p>
              <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards mt-9 flex flex-wrap items-center justify-center gap-3 delay-300 duration-700">
                <Link href="/login#signup" className={buttonVariants({ size: 'lg' })}>
                  Get started
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  href="/login"
                  className={buttonVariants({ size: 'lg', variant: 'outline' })}
                >
                  Sign in
                </Link>
              </div>
              <p className="motion-safe:animate-in motion-safe:fade-in motion-safe:fill-mode-backwards mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground delay-500 duration-700">
                <ShieldCheck aria-hidden className="size-3.5" />
                Bank connections via Plaid · your data exports in full, always
              </p>
            </div>

            <Reveal className="mx-auto mt-14 max-w-5xl sm:mt-20" delayMs={150}>
              <HeroMockupLazy />
            </Reveal>
          </div>
        </section>

        {/* ————— Guarantee strip: honest promises, benefit-first ————— */}
        <section className="border-y border-border bg-muted/30">
          <div className="mx-auto grid w-full max-w-6xl gap-x-10 gap-y-8 px-6 py-10 sm:grid-cols-2 sm:py-12 lg:grid-cols-4">
            {GUARANTEES.map((g, i) => (
              <Reveal key={g.claim} delayMs={i * 90}>
                <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <g.icon aria-hidden className="size-4 text-primary" />
                  {g.claim}
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {g.detail}
                </p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ————— Problem / principles ————— */}
        <section id="principles" className="scroll-mt-24">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                The problem
              </p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
                Most finance apps guess.
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                They round with floating point, silently “fix” your history, bury how a
                number was computed, and hold your data hostage when you want out. You
                stop trusting the numbers — then you stop opening the app.
              </p>
            </Reveal>
            <Reveal delayMs={120}>
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                The KEEL way
              </p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
                Built like an accounting system. Feels like a consumer app.
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                A deterministic double-entry spine does all the arithmetic. AI works only
                the fuzzy edges — categorizing, matching, narrating — and every material
                suggestion carries its confidence and evidence, then waits for your yes.
                Every result answers <em>as of when, from which rows, by which formula</em>.
              </p>
            </Reveal>
          </div>
        </section>

        {/* ————— Features ————— */}
        <section id="features" className="scroll-mt-24 border-t border-border bg-muted/20">
          <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
            <Reveal className="mx-auto max-w-2xl text-center">
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                What you get
              </p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-4xl">
                A system of record, not another dashboard.
              </h2>
            </Reveal>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map((feature, i) => (
                <Reveal
                  key={feature.title}
                  delayMs={(i % 4) * 80}
                  className={cn(feature.wide && 'sm:col-span-2')}
                >
                  <div className="group h-full rounded-lg border border-border bg-card p-6 transition-colors hover:border-primary/40">
                    <feature.icon className="size-5 text-primary" />
                    <h3 className="mt-4 text-base font-semibold tracking-tight">
                      {feature.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {feature.body}
                    </p>
                    {feature.ladder ? (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {RISK_LADDER.map((rung) => (
                          <span
                            key={rung.grade}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] text-secondary-foreground"
                          >
                            <span className="font-mono font-semibold text-primary">
                              {rung.grade}
                            </span>
                            {rung.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ————— Final CTA ————— */}
        <section className="relative overflow-hidden border-t border-border">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[24rem] bg-[radial-gradient(48rem_20rem_at_50%_120%,color-mix(in_oklab,var(--primary)_10%,transparent),transparent_70%)]"
          />
          <div className="mx-auto w-full max-w-6xl px-6 py-24 text-center sm:py-32">
            <Reveal>
              <KeelMark className="mx-auto size-8" />
              <h2 className="mt-6 text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
                Start keeping score.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-balance leading-relaxed text-muted-foreground">
                Connect your accounts in minutes. Approve what the AI suggests. Undo
                anything. Export everything.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Link href="/login#signup" className={buttonVariants({ size: 'lg' })}>
                  Create your ledger
                  <ArrowRight className="size-4" />
                </Link>
                <Link
                  href="/login"
                  className={buttonVariants({ size: 'lg', variant: 'ghost' })}
                >
                  Sign in
                </Link>
              </div>
              <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Undo2 aria-hidden className="size-3.5" />
                Every AI write is suggest → approve. Every mutation is audited.
              </p>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ————— Footer ————— */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-xs text-muted-foreground sm:flex-row">
          <span className="inline-flex items-center gap-1.5">
            <KeelMark className="size-4" />
            <span className="font-semibold lowercase tracking-tight text-foreground">keel</span>
            <span aria-hidden>·</span>
            your financial system of record
          </span>
          <span className="flex items-center gap-5">
            <a
              href="#principles"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Principles
            </a>
            <a
              href="#features"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Features
            </a>
            <Link
              href="/login"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Sign in
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
