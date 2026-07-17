'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Scroll-triggered fade-up reveal (landing page only). Pure CSS transition
 * driven by one IntersectionObserver — no animation library. Respects
 * prefers-reduced-motion by showing content immediately.
 */
export function Reveal({
  children,
  className,
  delayMs = 0,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  as?: 'div' | 'section';
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // A fast scroll can coalesce enter+exit into one non-intersecting
        // callback — also reveal anything already scrolled past (top < 0).
        const passed = entries.some((e) => e.isIntersecting || e.boundingClientRect.top < 0);
        if (passed) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <Tag
      // data-reveal: a global <noscript> rule forces these visible without JS
      data-reveal
      ref={ref as React.Ref<HTMLDivElement>}
      style={delayMs ? { transitionDelay: `${String(delayMs)}ms` } : undefined}
      className={cn(
        'transition-[opacity,transform] duration-700 ease-out will-change-transform',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
