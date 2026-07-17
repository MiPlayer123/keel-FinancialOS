import { useEffect, useState } from 'react';

/**
 * Shared master-detail breakpoint (teardown C6 residual): at desktop widths a
 * selected transaction shows in a side panel next to the list; below that,
 * a modal is the only surface (Law 8: must degrade to a usable single column
 * at 390px). Used by both the ledger register and the per-account
 * transaction list so the two never drift on when the panel switches to a
 * modal. Starts `false` (SSR-safe default matching the mobile modal) and
 * stays reactive to live resize so a real browser resize can flip modes
 * without a reload.
 */
export function useIsDesktopDetail(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    setIsDesktop(mql.matches);
    const onChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
    };
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);
  return isDesktop;
}
