'use client';

import { useEffect, useRef, useState } from 'react';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Rolling-digit money display for the landing mockup. Takes a PREFORMATTED
 * display string (Law 4: no arithmetic here, ever) and rolls each digit
 * column into place when scrolled into view. Non-digits render as-is.
 */

const COLUMN = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function DigitColumn({ digit, animate, delay }: { digit: number; animate: boolean; delay: number }) {
  return (
    <span className="inline-block h-[1em] overflow-hidden align-baseline">
      <m.span
        className="flex flex-col leading-none"
        initial={{ y: 0 }}
        animate={animate ? { y: `-${String(digit)}em` } : { y: 0 }}
        transition={{ type: 'spring', stiffness: 90, damping: 18, delay }}
      >
        {COLUMN.map((d) => (
          <span key={d} className="h-[1em]">
            {d}
          </span>
        ))}
      </m.span>
    </span>
  );
}

export function Odometer({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [on, setOn] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOn(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  if (reduced) {
    return (
      <span className={cn('font-mono tabular-nums', className)}>{value}</span>
    );
  }

  return (
    <LazyMotion features={domAnimation} strict>
      <span ref={ref} className={cn('font-mono tabular-nums', className)}>
        <span className="sr-only">{value}</span>
        <span aria-hidden>
          {value.split('').map((ch, i) =>
            /\d/.test(ch) ? (
              <DigitColumn key={`${String(i)}-${ch}`} digit={Number(ch)} animate={on} delay={i * 0.05} />
            ) : (
              <span key={`${String(i)}-${ch}`}>{ch}</span>
            ),
          )}
        </span>
      </span>
    </LazyMotion>
  );
}
