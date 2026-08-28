import Link from 'next/link';
import {
  ArrowRight,
  BookOpenCheck,
  Building2,
  CalendarClock,
  Code2,
  DownloadCloud,
  HandCoins,
  ReceiptText,
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
import { TransactionStory } from '@/components/keel/landing/transaction-story';
import { getSiteUrl } from '@/lib/site';
import { cn } from '@/lib/utils';

const FEATURES = [
  {
    icon: Scale,
    title: 'Numbers you can trace',
    body: 'Every transaction lands in a balanced double-entry ledger. Corrections create a visible revision instead of silently rewriting history.',
    wide: true,
  },
  {
    icon: Sparkles,
    title: 'Automation around the math',
    body: 'KEEL can suggest categories, recurring activity, transfers, and receipt matches. The ledger—not a language model—does every calculation.',
    ladder: true,
    wide: true,
  },
  {
    icon: Building2,
    title: 'Personal and entity views',
    body: 'Keep personal accounts and small-business books in one household, with entity filters on the dashboard, accounts, ledger, and budgets.',
  },
  {
    icon: CalendarClock,
    title: 'Budgets, bills, and goals',
    body: 'Plan category budgets, review recurring income and bills, track savings or debt goals, and preview cash flow from recorded activity.',
  },
  {
    icon: BookOpenCheck,
    title: 'Statements and reconciliation',
    body: 'Import statements, compare them with recorded activity, resolve differences, and lock a reconciled period with an explicit reopen trail.',
  },
  {
    icon: ReceiptText,
    title: 'Receipts with a review step',
    body: 'Upload receipt images or PDFs, inspect extracted details, and approve a suggested transaction match before it is attached.',
  },
  {
    icon: HandCoins,
    title: 'Paychecks and reimbursements',
    body: 'Break down deposits, track money others owe you, and keep settlements from inflating income.',
  },
  {
    icon: DownloadCloud,
    title: 'Portable records',
    body: 'Download structured records, audit history, and document metadata as CSV or JSON, with compatible financial records in QIF and Beancount.',
  },
];

const RISK_LADDER = [
  { grade: 'A', label: 'auto + undo' },
  { grade: 'B', label: 'suggest → approve' },
  { grade: 'C', label: 'preview only' },
  { grade: 'D', label: 'disabled' },
];

/** Structured data for search + LLM crawlers (GEO): what KEEL is, in one record. */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'KEEL',
  url: getSiteUrl().toString(),
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  isAccessibleForFree: true,
  sameAs: ['https://github.com/MiPlayer123/keel-FinancialOS'],
  license: 'https://www.gnu.org/licenses/agpl-3.0.html',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  description:
    'KEEL is an open-source personal and entity finance application built on a deterministic double-entry ledger, with review-first automation, reconciliation, and portable exports.',
  featureList: [
    'Double-entry ledger with balanced postings',
    'Review-first categorization, transfer, recurring, and receipt suggestions',
    'Personal and small-business entity views',
    'Budgets, recurring detection, goals and cash-flow forecast',
    'Statement reconciliation with period locks',
    'CSV, JSON, QIF and Beancount financial-record exports',
  ],
};

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Without JS the reveal-on-scroll content must simply be visible. */}
      <noscript>
        <style>{`[data-reveal]{opacity:1 !important;transform:none !important}`}</style>
      </noscript>
      <RedirectIfAuthed />
      <LandingNav />

      {/* ————— Hero ————— */}
      <main className="flex-1">
        <section className="relative">
          {/* calm emerald wash behind the hero, never neon */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(60rem_28rem_at_50%_-4rem,color-mix(in_oklab,var(--primary)_9%,transparent),transparent_70%)]"
          />
          <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-32 sm:pb-24 sm:pt-40">
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards text-balance text-4xl font-semibold tracking-tight duration-700 sm:text-6xl">
                Personal finances and business books,{' '}
                <span className="text-primary">finally in agreement.</span>
              </h1>
              <p className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards mx-auto mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground delay-100 duration-700">
                KEEL combines accounts, transactions, budgets, receipts, and entity books
                in one exact ledger—so every total can show where it came from.
              </p>
              <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-backwards mt-9 flex flex-wrap items-center justify-center gap-3 delay-200 duration-700">
                <Link href="/login#signup" className={buttonVariants({ size: 'lg' })}>
                  Create an account
                  <ArrowRight data-icon="inline-end" />
                </Link>
                <Link
                  href="/login"
                  className={buttonVariants({ size: 'lg', variant: 'outline' })}
                >
                  Sign in
                </Link>
              </div>
              <p className="motion-safe:animate-in motion-safe:fade-in motion-safe:fill-mode-backwards mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground delay-300 duration-700">
                <ShieldCheck aria-hidden className="size-3.5" />
                Free and open source under AGPL-3.0. Bank connections are Sandbox-only
                during this pre-release.
              </p>
            </div>

            <Reveal className="mx-auto mt-14 max-w-5xl sm:mt-20" delayMs={150}>
              <HeroMockupLazy />
            </Reveal>
          </div>
        </section>

        {/* ————— How it works: scroll-scrubbed transaction story ————— */}
        <TransactionStory />

        {/* ————— Problem / principles ————— */}
        <section id="principles" className="scroll-mt-24 border-t border-border">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                The problem
              </p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
                A dashboard is not a source of truth.
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                When balances, categories, reports, and corrections follow different
                rules, even a polished chart becomes hard to trust.
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
                A deterministic double-entry ledger does the arithmetic. Automation works
                around the fuzzy edges—categorizing, matching, detecting, and explaining—
                while review steps protect material changes.
              </p>
            </Reveal>
          </div>
        </section>

        <section id="open-source" className="scroll-mt-24 border-t border-border">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 sm:py-28 lg:grid-cols-[1fr_auto] lg:items-center">
            <Reveal>
              <div className="flex items-center gap-2 text-primary">
                <Code2 className="size-5" aria-hidden />
                <p className="text-xs font-medium uppercase tracking-widest">Open source</p>
              </div>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-4xl">
                Inspect the rules behind your numbers.
              </h2>
              <p className="mt-4 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
                KEEL&apos;s application code, ledger contracts, migrations, and tests are
                available on GitHub under AGPL-3.0. You can review the implementation, open
                issues, or run your own instance.
              </p>
            </Reveal>
            <Reveal delayMs={100}>
              <Link
                href="https://github.com/MiPlayer123/keel-FinancialOS"
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: 'lg', variant: 'outline' })}
              >
                View source on GitHub
                <ArrowRight data-icon="inline-end" />
              </Link>
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
                Build a record you can verify.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-balance leading-relaxed text-muted-foreground">
                Start with manual accounts or explore the Sandbox connection flow. Review
                suggestions, trace totals, and export your financial records.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <Link href="/login#signup" className={buttonVariants({ size: 'lg' })}>
                  Create an account
                  <ArrowRight data-icon="inline-end" />
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
                Pre-release software. Use fictional data while evaluating the hosted demo.
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
          <span className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
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
            <a
              href="#open-source"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Open source
            </a>
            <a
              href="https://github.com/MiPlayer123/keel-FinancialOS"
              target="_blank"
              rel="noreferrer"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              GitHub
            </a>
            <Link
              href="/privacy"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Privacy
            </Link>
            <Link
              href="/security"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Security
            </Link>
            <Link
              href="/terms"
              className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Terms
            </Link>
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
