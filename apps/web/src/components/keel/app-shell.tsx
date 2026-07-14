'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Wallet,
  ReceiptText,
  Repeat,
  PiggyBank,
  Target,
  BarChart3,
  Banknote,
  ArrowLeftRight,
  FileCheck2,
  BadgeCheck,
  Link2,
  Settings,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KeelLogo, KeelMark } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { useHousehold } from '@/components/keel/household-context';
import { fetchAccounts, fetchLedgerKinds, type AccountRow } from '@/lib/keel-api';
import { QuickNav } from '@/components/keel/quick-nav';
import { ReviewBadge } from '@/components/keel/review-badge';

type NavItem = { label: string; href: string; icon: LucideIcon };

const NAV: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Accounts', href: '/dashboard/accounts', icon: Wallet },
  { label: 'Ledger', href: '/dashboard/ledger', icon: ReceiptText },
  { label: 'Recurring', href: '/dashboard/recurring', icon: Repeat },
  { label: 'Budgets', href: '/dashboard/budgets', icon: PiggyBank },
  { label: 'Goals', href: '/dashboard/goals', icon: Target },
  { label: 'Reports', href: '/dashboard/reports', icon: BarChart3 },
  { label: 'Paychecks', href: '/dashboard/paychecks', icon: Banknote },
  { label: 'Reimbursements', href: '/dashboard/reimbursements', icon: ArrowLeftRight },
  { label: 'Statements', href: '/dashboard/statements', icon: FileCheck2 },
  { label: 'Review', href: '/dashboard/review', icon: BadgeCheck },
  { label: 'Connections', href: '/dashboard/connections', icon: Link2 },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

const COLLAPSE_KEY = 'keel-sidebar-collapsed';

function NavLinks({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ label, href, icon: Icon }) => {
        const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
        const link = (
          <Link
            key={href}
            href={href}
            onClick={() => onNavigate?.()}
            className={cn(
              'flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors',
              collapsed ? 'justify-center px-0' : 'px-3',
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {collapsed ? null : label}
            {!collapsed && href === '/dashboard/review' ? <ReviewBadge /> : null}
          </Link>
        );
        const withSubnav =
          !collapsed && href === '/dashboard/accounts' ? (
            <div key={href}>
              {link}
              <SidebarAccounts pathname={pathname} onNavigate={onNavigate} />
            </div>
          ) : null;
        if (!collapsed) return withSubnav ?? link;
        return (
          <Tooltip key={href}>
            <TooltipTrigger render={link} />
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/**
 * Accounts inline in the nav, grouped assets / liabilities — the Quicken
 * left rail. Names only (balances stay on the pages); caps keep the rail calm.
 */
function SidebarAccounts({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const { householdId } = useHousehold();
  // Queried under the shared 'keel-query' cache-key prefix (see
  // use-keel-query.ts) purely so this list is swept up by every existing
  // refetch()/invalidateQueries call in the app (rename, add account, link a
  // new Plaid item, ...) without those call sites needing to know the sidebar
  // exists. Now that AppShell is a persistent layout (not remounted per
  // navigation — 2026-07-14), this component no longer refetches on its own;
  // without a shared cache key it would show a stale account name/list until
  // the household changed (Codex review, PR #9).
  const { data } = useQuery({
    queryKey: ['keel-query', 'sidebar-accounts', householdId],
    queryFn: async () => {
      if (!householdId) throw new Error('sidebar-accounts: disabled (no household)');
      const [a, k] = await Promise.all([fetchAccounts(householdId), fetchLedgerKinds(householdId)]);
      return { accounts: a, kinds: k };
    },
    enabled: householdId !== null,
  });
  const accounts = data?.accounts ?? [];
  const kinds = data?.kinds ?? new Map<string, string>();

  if (accounts.length === 0) return null;
  const assets = accounts.filter((a) => kinds.get(a.ledgerAccountId) !== 'liability');
  const liabilities = accounts.filter((a) => kinds.get(a.ledgerAccountId) === 'liability');
  const CAP = 6;

  const group = (title: string, rows: AccountRow[]) => {
    if (rows.length === 0) return null;
    return (
      <div className="mt-1">
        <p className="px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {title}
        </p>
        {rows.slice(0, CAP).map((a) => {
          const href = `/dashboard/accounts/${a.id}`;
          const active = pathname === href;
          return (
            <Link
              key={a.id}
              href={href}
              onClick={() => onNavigate?.()}
              className={cn(
                'block truncate rounded-md py-1 pl-6 pr-3 text-xs transition-colors',
                active
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
              title={a.name}
            >
              {a.name}
            </Link>
          );
        })}
        {rows.length > CAP ? (
          <Link
            href="/dashboard/accounts"
            onClick={() => onNavigate?.()}
            className="block rounded-md py-1 pl-6 pr-3 text-xs text-muted-foreground/70 hover:text-foreground"
          >
            +{String(rows.length - CAP)} more
          </Link>
        ) : null}
      </div>
    );
  };

  return (
    <div className="mb-1">
      {group('Assets', assets)}
      {group('Liabilities', liabilities)}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      return next;
    });
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await getSupabaseBrowserClient().auth.getSession();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flag flips in cleanup
      if (!active) return;
      if (!data.session) {
        router.replace('/login');
        return;
      }
      setEmail(data.session.user.email ?? 'Account');
      setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [router]);

  async function signOut() {
    await getSupabaseBrowserClient().auth.signOut();
    router.replace('/login');
  }

  function sidebarInner(isCollapsed: boolean, showCollapseToggle: boolean) {
    return (
      <div className="flex h-full flex-col">
        <div
          className={cn(
            'flex items-center py-5',
            isCollapsed ? 'flex-col gap-3 px-0' : 'justify-between px-4',
          )}
        >
          {isCollapsed ? <KeelMark className="size-6" /> : <KeelLogo />}
          {showCollapseToggle ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={toggleCollapsed}
            >
              {isCollapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          ) : null}
        </div>

        <div className={cn('flex-1', isCollapsed ? 'px-2' : 'px-3')}>
          <NavLinks
            collapsed={isCollapsed}
            onNavigate={() => {
              setMobileOpen(false);
            }}
          />
        </div>

        <div className={cn('border-t border-border', isCollapsed ? 'p-2' : 'p-3')}>
          {isCollapsed ? (
            <div className="flex flex-col items-center gap-1">
              <ThemeToggle />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Sign out"
                      onClick={() => {
                        void signOut();
                      }}
                    >
                      <LogOut className="size-4" />
                    </Button>
                  }
                />
                <TooltipContent side="right">Sign out</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 px-1">
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={email ?? undefined}
                >
                  {email ?? '—'}
                </span>
                <ThemeToggle />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full justify-start"
                onClick={() => {
                  void signOut();
                }}
              >
                <LogOut className="size-4" />
                Sign out
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="w-full max-w-3xl space-y-4 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar — pinned to the viewport, fixed height, scrolls
          internally so a tall page never stretches the nav. */}
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 self-start overflow-y-auto border-r border-border bg-sidebar transition-[width] duration-200 lg:block',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        {sidebarInner(collapsed, true)}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center justify-between border-b border-border px-4 py-3 lg:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              aria-label="Open menu"
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
            >
              <Menu className="size-5" />
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              {sidebarInner(false, false)}
            </SheetContent>
          </Sheet>
          <KeelLogo />
          <div className="w-9" />
        </header>

        <main className="min-w-0 flex-1">
          <QuickNav />
          {children}
        </main>
      </div>
    </div>
  );
}
