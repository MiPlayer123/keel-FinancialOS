'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ReceiptText,
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
import { HouseholdProvider } from '@/components/keel/household-context';

type NavItem = { label: string; href: string; icon: LucideIcon };

const NAV: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Ledger', href: '/dashboard/ledger', icon: ReceiptText },
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
          </Link>
        );
        if (!collapsed) return link;
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
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden shrink-0 border-r border-border bg-sidebar transition-[width] duration-200 lg:block',
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
          <HouseholdProvider>{children}</HouseholdProvider>
        </main>
      </div>
    </div>
  );
}
