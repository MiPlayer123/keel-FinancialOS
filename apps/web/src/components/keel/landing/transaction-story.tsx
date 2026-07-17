'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { Money } from '@/components/keel/money';
import { cn } from '@/lib/utils';

/**
 * "Life of a transaction": a scroll-scrubbed, pinned story following one
 * paycheck through KEEL. GSAP (ScrollTrigger) is imported dynamically inside
 * the effect so it never touches SSR or the critical bundle. The server, small
 * screens, and prefers-reduced-motion all get the same content as a static
 * stacked sequence, so the story text is always crawlable and accessible.
 *
 * All money is preformatted display strings or minor-unit strings through the
 * real Money component; the animation only ever tweens opacity/transform and
 * an SVG dash offset. No arithmetic on money anywhere (Laws 1/4).
 */

const RAW_MEMO = 'ORIG CO NAME:ACMELABS CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:1234567890';

const BEATS = [
  {
    title: 'A transaction arrives',
    body: 'Your bank sends a raw, machine-formatted memo. Most apps show it to you as-is.',
  },
  {
    title: 'KEEL cleans it up',
    body: 'The name becomes readable. The original is kept forever, one tap away.',
  },
  {
    title: 'Both sides are recorded',
    body: 'Money in and money out are booked together, and they must cancel to exactly zero.',
  },
  {
    title: 'AI suggests, you approve',
    body: 'KEEL proposes a category with its confidence and evidence. Nothing happens until you say yes.',
  },
  {
    title: 'Your picture updates',
    body: 'Net worth, budgets and reports all move at once, and every number can show its work.',
  },
];

/** Static fallback: the same story as a plain vertical sequence. */
function StaticBeatCard({ index }: { index: number }) {
  const beat = BEATS[index];
  if (!beat) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-xs font-medium text-primary">Step {index + 1}</p>
      <h3 className="mt-1 text-base font-semibold tracking-tight">{beat.title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{beat.body}</p>
      {index === 0 ? (
        <p className="mt-3 break-all rounded-md bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">
          {RAW_MEMO}
        </p>
      ) : null}
      {index === 2 ? (
        <div className="mt-3 space-y-1 text-xs">
          <p className="flex justify-between">
            <span>Checking</span>
            <Money amountMinor="425000" signed className="text-xs" />
          </p>
          <p className="flex justify-between text-muted-foreground">
            <span>Income · Salary</span>
            <Money amountMinor="-425000" signed className="text-xs" />
          </p>
          <p className="flex justify-between border-t border-border pt-1 font-medium">
            <span>Together</span>
            <span className="font-mono tabular-nums">$0.00 ✓</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function TransactionStory() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wide = window.matchMedia('(min-width: 768px)').matches;
    if (motionOK && wide) setPinned(true);
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const root = rootRef.current;
    if (!root) return;
    // Object flag: the cleanup below flips it concurrently, which plain
    // `let` narrowing would (wrongly) flag as an impossible condition.
    const flags = { killed: false };
    let cleanup: (() => void) | null = null;

    void (async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([
        import('gsap'),
        import('gsap/ScrollTrigger'),
      ]);
      if (flags.killed) return;
      gsap.registerPlugin(ScrollTrigger);

      const q = gsap.utils.selector(root);
      const stage = root.querySelector<HTMLElement>('[data-stage]');
      const card = root.querySelector<HTMLElement>('[data-suggest]');
      const slot = root.querySelector<HTMLElement>('[data-rowslot]');
      const path = root.querySelector<SVGPathElement>('[data-chartpath]');
      if (!stage || !card || !slot || !path) return;

      // Manual FLIP for the approve morph: both live in the same static stage,
      // so one measurement at init gives a stable delta to bake into the tween.
      const cardBox = card.getBoundingClientRect();
      const slotBox = slot.getBoundingClientRect();
      const dx = slotBox.left - cardBox.left;
      const dy = slotBox.top - cardBox.top;
      const scale = slotBox.height / cardBox.height;

      // Non-uniform preserveAspectRatio scaling leaves a sliver at full
      // offset, so the path also stays invisible until its beat.
      const len = path.getTotalLength();
      gsap.set(path, { strokeDasharray: len, strokeDashoffset: len, autoAlpha: 0 });

      const rail = q('[data-rail-item]');
      const setActive = (i: number, tl: gsap.core.Timeline, at: string) => {
        rail.forEach((el, j) => {
          tl.to(el, { opacity: j === i ? 1 : 0.35, x: j === i ? 4 : 0, duration: 0.2 }, at);
        });
      };

      const tl = gsap.timeline({
        defaults: { ease: 'power2.out', duration: 0.5 },
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: '+=2800',
          pin: true,
          scrub: 0.6,
        },
      });

      // Beat 1 — raw memo arrives
      tl.addLabel('memo');
      setActive(0, tl, 'memo');
      tl.fromTo(q('[data-memo]'), { opacity: 0, y: 24, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)' }, 'memo');

      // Beat 2 — normalize
      tl.addLabel('clean', '+=0.4');
      setActive(1, tl, 'clean');
      tl.to(q('[data-memo]'), { opacity: 0.3, scale: 0.85, y: -4, transformOrigin: 'top left' }, 'clean');
      tl.fromTo(q('[data-clean]'), { opacity: 0, y: 16 }, { opacity: 1, y: 0 }, 'clean+=0.15');

      // Beat 3 — postings, Σ = 0
      tl.addLabel('postings', '+=0.4');
      setActive(2, tl, 'postings');
      tl.fromTo(q('[data-post-a]'), { opacity: 0, x: -24 }, { opacity: 1, x: 0 }, 'postings');
      tl.fromTo(q('[data-post-b]'), { opacity: 0, x: 24 }, { opacity: 1, x: 0 }, 'postings+=0.2');
      tl.fromTo(q('[data-sigma]'), { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, ease: 'back.out(2)' }, 'postings+=0.45');

      // Beat 4 — suggest → approve (FLIP morph into the ledger row)
      tl.addLabel('suggest', '+=0.4');
      setActive(3, tl, 'suggest');
      tl.fromTo(card, { opacity: 0, y: 20 }, { opacity: 1, y: 0 }, 'suggest');
      tl.addLabel('approve', '+=0.5');
      tl.to(card, { x: dx, y: dy, scale, transformOrigin: 'top left', opacity: 0, ease: 'power2.inOut', duration: 0.6 }, 'approve');
      tl.fromTo(slot, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 'approve+=0.35');

      // Beat 5 — chart draws
      tl.addLabel('chart', '+=0.3');
      setActive(4, tl, 'chart');
      tl.to(path, { autoAlpha: 1, duration: 0.05 }, 'chart');
      tl.to(path, { strokeDashoffset: 0, ease: 'none', duration: 1 }, 'chart');
      tl.fromTo(q('[data-networth]'), { opacity: 0, y: 10 }, { opacity: 1, y: 0 }, 'chart+=0.5');
      tl.to({}, { duration: 0.4 }); // settle room at the end of the pin

      cleanup = () => {
        tl.scrollTrigger?.kill();
        tl.kill();
      };
    })();

    return () => {
      flags.killed = true;
      cleanup?.();
    };
  }, [pinned]);

  return (
    <section id="story" className="scroll-mt-24 border-t border-border bg-muted/20">
      <div ref={rootRef} className={cn(!pinned && 'py-20 sm:py-24', pinned && 'flex min-h-screen flex-col justify-center py-10')}>
        <div className="mx-auto w-full max-w-6xl px-6">
          <div className="max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              How it works
            </p>
            <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight sm:text-4xl">
              Follow one paycheck through KEEL.
            </h2>
          </div>

          {pinned ? (
            <div className="mt-10 grid gap-10 md:grid-cols-5">
              {/* rail */}
              <ol className="space-y-5 md:col-span-2">
                {BEATS.map((beat, i) => (
                  <li key={beat.title} data-rail-item style={{ opacity: i === 0 ? 1 : 0.35 }}>
                    <p className="text-xs font-medium text-primary">Step {i + 1}</p>
                    <h3 className="mt-0.5 text-base font-semibold tracking-tight">{beat.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{beat.body}</p>
                  </li>
                ))}
              </ol>

              {/* stage */}
              <div
                data-stage
                className="relative h-[430px] overflow-hidden rounded-xl border border-border bg-card p-6 md:col-span-3"
              >
                <p data-memo className="break-all pr-24 font-mono text-xs leading-relaxed text-muted-foreground opacity-0">
                  {RAW_MEMO}
                </p>

                <div data-clean className="absolute left-6 top-[88px] opacity-0">
                  <p className="text-lg font-semibold tracking-tight">Acme Labs Payroll</p>
                  <p className="text-xs text-muted-foreground">Checking · Jul 16</p>
                </div>
                <p className="absolute right-6 top-[88px] font-mono text-lg tabular-nums">$4,250.00</p>

                <div className="absolute inset-x-6 top-[168px] space-y-2 text-sm">
                  <div data-post-a className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 opacity-0">
                    <span>Checking</span>
                    <Money amountMinor="425000" signed className="text-sm" />
                  </div>
                  <div data-post-b className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-muted-foreground opacity-0">
                    <span>Income · Salary</span>
                    <Money amountMinor="-425000" signed className="text-sm" />
                  </div>
                  <p data-sigma className="flex items-center justify-end gap-1.5 text-xs font-medium text-primary opacity-0">
                    <Check className="size-3.5" />
                    Balances to exactly $0.00
                  </p>
                </div>

                {/* suggestion card (FLIP source) */}
                <div data-suggest className="absolute inset-x-6 top-[300px] rounded-lg border border-border bg-muted/40 p-3 opacity-0">
                  <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <Sparkles className="size-3 text-primary" />
                    Suggestion · confidence 0.96
                  </p>
                  <p className="mt-1 text-xs">
                    Categorize as <span className="font-medium">Salary</span>. Matched 11 prior paychecks.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                      <Check className="size-3" /> Approve
                    </span>
                    <span className="text-[10px] text-muted-foreground">undoable</span>
                  </div>
                </div>

                {/* approved ledger row (FLIP target) */}
                <div data-rowslot className="absolute inset-x-6 top-[310px] flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2 opacity-0">
                  <span className="text-[10px] text-muted-foreground">Jul 16</span>
                  <span className="flex-1 text-xs font-medium">Acme Labs Payroll</span>
                  <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px]">Salary</span>
                  <Money amountMinor="425000" className="text-xs" />
                  <Check className="size-3.5 text-primary" />
                </div>

                {/* chart */}
                <svg className="absolute inset-x-0 bottom-0 h-16 w-full" viewBox="0 0 600 64" fill="none" preserveAspectRatio="none" aria-hidden>
                  <path
                    data-chartpath
                    d="M0 56 L80 50 L160 52 L240 42 L320 44 L400 32 L480 34 L560 18 L600 12"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <p data-networth className="absolute bottom-4 right-6 text-xs text-muted-foreground opacity-0">
                  Net worth <span className="font-mono font-medium tabular-nums text-foreground">$124,833.90</span>
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {BEATS.map((beat, i) => (
                <StaticBeatCard key={beat.title} index={i} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
