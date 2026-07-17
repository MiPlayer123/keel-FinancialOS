'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ReceiptText, BadgeCheck, Wallet, PiggyBank } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ReviewBadge } from '@/components/keel/review-badge';

type TabItem = { label: string; href: string; icon: LucideIcon };

/**
 * C17 residual (teardown ledger): a phone-only bottom tab bar. Five
 * destinations, not the full 13-item desktop nav — the small set a phone
 * user actually reaches for one-handed (Home, Ledger, Review, Accounts,
 * Budgets), same icons the desktop sidebar already uses for each so the
 * mapping is instantly familiar (`app-shell.tsx`'s NAV list).
 *
 * Desktop-first per Law 8: this is a pure ADDITION at phone widths, not a
 * new desktop nav. It shares the same `lg` breakpoint the existing mobile
 * top bar/sheet menu already uses (AppShell), so it appears exactly when
 * that mobile chrome does and never overlaps the desktop sidebar.
 */
const TABS: TabItem[] = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Ledger', href: '/dashboard/ledger', icon: ReceiptText },
  { label: 'Review', href: '/dashboard/review', icon: BadgeCheck },
  { label: 'Accounts', href: '/dashboard/accounts', icon: Wallet },
  { label: 'Budgets', href: '/dashboard/budgets', icon: PiggyBank },
];

export function BottomTabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background lg:hidden',
        // Safe-area inset for phones with a home indicator; padding-bottom
        // becomes 0 on devices without one (env() falls back to 0).
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="grid grid-cols-5">
        {TABS.map(({ label, href, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="relative">
                  <Icon className="size-5" />
                  {href === '/dashboard/review' ? <ReviewBadge variant="dot" /> : null}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
