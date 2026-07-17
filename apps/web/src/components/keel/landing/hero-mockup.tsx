'use client';

import { ArrowLeftRight, Check, Landmark, ListChecks, Sparkles, X } from 'lucide-react';
import { BalanceTrendChart, type BalancePoint } from '@/components/keel/charts';
import { Money } from '@/components/keel/money';
import { Odometer } from '@/components/keel/landing/odometer';
import { Tilt } from '@/components/keel/landing/tilt';
import { cn } from '@/lib/utils';

/**
 * Decorative product mockup for the landing hero. Rendered from the SAME
 * primitives the real app uses (BalanceTrendChart, Money) with fixed demo
 * data — not a screenshot, and not live data. Inert by design.
 */

/** Deterministic integer triangle wave (demo wobble) — no float math on money. */
function triangle(i: number, period: number, amplitudeMinor: number): number {
  const phase = i % period;
  const half = period / 2;
  const t = phase < half ? phase / half : (period - phase) / half;
  return (2 * t - 1) * amplitudeMinor;
}

const DEMO_NET_WORTH: BalancePoint[] = Array.from({ length: 48 }, (_, i) => {
  const base = 9_180_000 + i * 66_500;
  const wobble = triangle(i, 14, 120_000) + triangle(i + 3, 6, 44_000);
  const dip = i >= 18 && i <= 22 ? -210_000 : 0;
  const date = new Date(Date.UTC(2026, 0, 2 + i * 4)).toISOString().slice(0, 10);
  return { date, balanceMinor: String(base + wobble + dip), currency: 'USD' };
});

const DEMO_ROWS: Array<{
  date: string;
  name: string;
  meta: string;
  amountMinor: string;
  badge?: 'transfer' | 'split';
}> = [
  { date: 'Jul 16', name: 'Acme Labs Payroll', meta: 'Checking · Income', amountMinor: '425000' },
  { date: 'Jul 15', name: 'Trader Joe’s', meta: 'Credit card · Groceries', amountMinor: '-8412' },
  { date: 'Jul 15', name: 'Transfer to Savings', meta: 'Checking → Savings', amountMinor: '100000', badge: 'transfer' },
  { date: 'Jul 14', name: 'Costco', meta: 'Credit card · 2 categories', amountMinor: '-21376', badge: 'split' },
  { date: 'Jul 13', name: 'Lyft', meta: 'Credit card · Transport', amountMinor: '-1890' },
];

function DemoBadge({ kind }: { kind: 'transfer' | 'split' }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
      {kind === 'transfer' ? <ArrowLeftRight className="size-2.5" /> : <ListChecks className="size-2.5" />}
      {kind === 'transfer' ? 'Transfer' : 'Split'}
    </span>
  );
}

export function HeroMockup({ className }: { className?: string }) {
  return (
    <div aria-hidden tabIndex={-1} className={cn('select-none', className)}>
      <Tilt>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-stone-900/10 dark:shadow-black/40">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
          <span className="ml-3 text-xs text-muted-foreground">keel · home</span>
        </div>

        <div className="grid gap-px bg-border md:grid-cols-5">
          {/* left: net worth */}
          <div className="bg-card p-5 md:col-span-3">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Net worth
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  <Odometer value="$124,833.90" />
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">+$32,610.44</span> · 6 months
              </p>
            </div>
            <div className="mt-3 -mx-2">
              <BalanceTrendChart points={DEMO_NET_WORTH} height={170} />
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Landmark className="size-3.5" />
                6 accounts · 2 entities
              </p>
              <p className="text-[10px] text-muted-foreground/70">
                as of Jul 17 · net-worth-v2 · demo data
              </p>
            </div>
          </div>

          {/* right: ledger + suggestion */}
          <div className="flex flex-col bg-card md:col-span-2">
            <div className="flex-1 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Latest activity
              </p>
              <ul className="mt-2 divide-y divide-border/70">
                {DEMO_ROWS.map((row) => (
                  <li key={`${row.date}-${row.name}`} className="flex items-center gap-3 py-2">
                    <span className="w-10 shrink-0 text-[10px] text-muted-foreground">{row.date}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{row.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {row.meta}
                      </span>
                    </span>
                    {row.badge ? <DemoBadge kind={row.badge} /> : null}
                    <Money amountMinor={row.amountMinor} className="text-xs" />
                  </li>
                ))}
              </ul>
            </div>

            {/* AI suggest→approve card */}
            <div className="border-t border-border bg-muted/30 p-4">
              <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3 text-primary" />
                Suggestion · confidence 0.94
              </p>
              <p className="mt-1.5 text-xs leading-relaxed">
                Categorize <span className="font-mono text-[11px]">BLUE BOTTLE 0421</span> as{' '}
                <span className="font-medium">Coffee shops</span>. Matched 12 prior transactions.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
                  <Check className="size-3" /> Approve
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                  <X className="size-3" /> Dismiss
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/70">undoable</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      </Tilt>
    </div>
  );
}
