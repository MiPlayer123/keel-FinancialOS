'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  LazyMotion,
  domAnimation,
  m,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'motion/react';

/**
 * Gentle pointer-follow tilt (max ±3°) with spring settle. The wrapper tree
 * is identical whether tilt is active or not — only the handlers attach —
 * so enabling it never remounts the (expensive) children. Inert on touch
 * devices and under prefers-reduced-motion.
 */
export function Tilt({ children, max = 3 }: { children: ReactNode; max?: number }) {
  const [active, setActive] = useState(false);
  const reduced = useReducedMotion();
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const srx = useSpring(rx, { stiffness: 140, damping: 18 });
  const sry = useSpring(ry, { stiffness: 140, damping: 18 });

  useEffect(() => {
    setActive(window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  }, []);

  const enabled = active && !reduced;

  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        style={{ rotateX: srx, rotateY: sry, transformPerspective: 1100 }}
        onPointerMove={
          enabled
            ? (e) => {
                const box = e.currentTarget.getBoundingClientRect();
                const px = (e.clientX - box.left) / box.width - 0.5;
                const py = (e.clientY - box.top) / box.height - 0.5;
                ry.set(px * max * 2);
                rx.set(-py * max * 2);
              }
            : undefined
        }
        onPointerLeave={
          enabled
            ? () => {
                rx.set(0);
                ry.set(0);
              }
            : undefined
        }
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}
