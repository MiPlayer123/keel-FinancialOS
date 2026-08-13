'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Wallet,
  Receipt,
  ReceiptText,
  Repeat,
  PiggyBank,
  Target,
  BarChart3,
  TrendingUp,
  Banknote,
  ArrowLeftRight,
  FileCheck2,
  BadgeCheck,
  Settings,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  ChevronDown,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { getSupabaseBrowserClient } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { KeelLogo, KeelMark } from '@/components/keel/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { useHousehold } from '@/components/keel/household-context';
import { EntityLensSwitcher } from '@/components/keel/entity-lens-switcher';
import { useEntityLens } from '@/components/keel/entity-lens-context';
import {
  fetchAccounts,
  fetchConnections,
  fetchLedgerKinds,
  fetchInvestmentsOverview,
  keelQuery,
  type AccountRow,
  type ConnectionRow,
  type EntityRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { looksLikeInvestmentAccount } from '@/lib/investment-subtype';
import { relativeSyncLabel } from '@/lib/relative-date';
import { Money } from '@/components/keel/money';
import { ReauthLink } from '@/components/keel/reauth-link';
import { QuickNav } from '@/components/keel/quick-nav';
import { ReviewBadge } from '@/components/keel/review-badge';
import { QueryTimingPanel } from '@/components/keel/query-timing-panel';
import { BottomTabBar } from '@/components/keel/bottom-tab-bar';

type NavItem = { label: string; href: string; icon: LucideIcon };

const PRIMARY_NAV: NavItem[] = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Accounts', href: '/dashboard/accounts', icon: Wallet },
  { label: 'Transactions', href: '/dashboard/ledger', icon: ReceiptText },
  { label: 'Investments', href: '/dashboard/investments', icon: TrendingUp },
  { label: 'Recurring', href: '/dashboard/recurring', icon: Repeat },
  { label: 'Budgets', href: '/dashboard/budgets', icon: PiggyBank },
  { label: 'Goals', href: '/dashboard/goals', icon: Target },
  { label: 'Reports', href: '/dashboard/reports', icon: BarChart3 },
  { label: 'Review', href: '/dashboard/review', icon: BadgeCheck },
];

const SECONDARY_NAV: NavItem[] = [
  { label: 'Paychecks', href: '/dashboard/paychecks', icon: Banknote },
  { label: 'Reimbursements', href: '/dashboard/reimbursements', icon: ArrowLeftRight },
  { label: 'Statements', href: '/dashboard/statements', icon: FileCheck2 },
  { label: 'Receipts', href: '/dashboard/receipts', icon: Receipt },
  { label: 'Assistant', href: '/dashboard/assistant', icon: Sparkles },
];

const SETTINGS_NAV: NavItem = {
  label: 'Settings',
  href: '/dashboard/settings',
  icon: Settings,
};

const COLLAPSE_KEY = 'keel-sidebar-collapsed';

function NavItemLink({
  item: { label, href, icon: Icon },
  pathname,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
  const link = (
    <Link
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

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Entity list rides the shared lens context (which reads entities.list once
  // per household) — the rail reuses it rather than opening a second entities
  // read, so its Personal/Business split is the SAME set, order, and names the
  // Accounts page groups by. `entities` is [] until that read resolves; the
  // rail falls back to the flat (single-entity) layout until then.
  const { entities } = useEntityLens();
  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-0.5">
      {PRIMARY_NAV.map((item) =>
        !collapsed && item.href === '/dashboard/accounts' ? (
          <div key={item.href}>
            <NavItemLink
              item={item}
              pathname={pathname}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
            <SidebarAccounts pathname={pathname} onNavigate={onNavigate} entities={entities} />
          </div>
        ) : (
          <NavItemLink
            key={item.href}
            item={item}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ),
      )}

      <Separator className={cn('my-2', collapsed && 'mx-auto w-6')} />
      {collapsed ? null : (
        <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Manage
        </p>
      )}
      {SECONDARY_NAV.map((item) => (
        <NavItemLink
          key={item.href}
          item={item}
          pathname={pathname}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function FooterSettingsLink({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <NavItemLink
      item={SETTINGS_NAV}
      pathname={pathname}
      collapsed={collapsed}
      onNavigate={onNavigate}
    />
  );
}

/** Currency shared by the most accounts in a set (ties → first seen). */
function dominantCurrency(rows: AccountRow[]): string | null {
  const counts = new Map<string, number>();
  for (const a of rows) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [currency, n] of counts) {
    if (n > bestN) {
      best = currency;
      bestN = n;
    }
  }
  return best;
}

/**
 * Σ balances for the dominant currency only — never add across currencies
 * (Law 4). Returns null when no account in the dominant currency has a known
 * balance (so the caller omits rather than shows a misleading 0).
 */
function currencySubtotal(
  rows: AccountRow[],
  byLedger: Map<string, TrialBalanceRow>,
): { minor: string; currency: string } | null {
  const currency = dominantCurrency(rows);
  if (currency === null) return null;
  let sum = 0n;
  let any = false;
  for (const a of rows) {
    if (a.currency !== currency) continue;
    const bal = byLedger.get(a.ledgerAccountId);
    if (!bal) continue;
    sum += BigInt(bal.balanceMinor || '0');
    any = true;
  }
  return any ? { minor: sum.toString(), currency } : null;
}

/**
 * Accounts inline in the nav, grouped assets / liabilities — the Quicken
 * left rail. Each row carries a right-aligned balance, each group header its
 * subtotal, and net worth is pinned at the foot — the same figures the
 * Accounts page shows. Both read `ledger.trial_balance` and then overlay
 * MARKET value (Plaid snapshot total) onto investment accounts, so the rows
 * sum to the headline net worth exactly (keel_net_worth_* value investment
 * accounts at market, not the anchored cash ledger). Every account is listed
 * in its group (no cap) and
 * the rail scrolls with its container (the desktop <aside> is h-dvh
 * overflow-y-auto; the mobile drawer is min-h-0 overflow-y-auto — see
 * AppShell); balances hide when the sidebar is collapsed because the whole
 * subnav is (see NavLinks).
 *
 * Multi-entity households additionally get the Accounts-page Personal /
 * Business split: one collapsible section per entity (in entities.list order,
 * with a trailing "Other entity" for accounts pointing at an entity the list
 * doesn't know), each with its own Assets / Liabilities / Other groups and a
 * per-entity subtotal — mirroring EntityGroupedAccounts on the Accounts page
 * so the rail reads the same way (founder ask 2026-07-20). Single-entity
 * households (entities.length <= 1) keep the flat layout unchanged.
 */
function SidebarAccounts({
  pathname,
  onNavigate,
  entities,
}: {
  pathname: string;
  onNavigate?: (() => void) | undefined;
  entities: EntityRow[];
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
  // Balances (ledger.trial_balance) ride the same query as the account list so
  // they refetch/invalidate together and stay under the shared 'keel-query'
  // cache-key prefix — see the note above and use-keel-query.ts.
  const { data } = useQuery({
    queryKey: ['keel-query', 'sidebar-accounts', householdId],
    queryFn: async () => {
      if (!householdId) throw new Error('sidebar-accounts: disabled (no household)');
      const [a, k, b, c, inv] = await Promise.all([
        fetchAccounts(householdId),
        fetchLedgerKinds(householdId),
        keelQuery<TrialBalanceRow>('ledger.trial_balance', householdId),
        // Per-account freshness + reauth at the row (C8); same member-read
        // the Connections page uses. Best-effort — the rail renders without.
        fetchConnections(householdId).catch((): ConnectionRow[] => []),
        // Per-account MARKET value (Plaid snapshot total incl. securities) for
        // investment accounts, so the rail's balances/subtotals/net-worth foot
        // match the headline net worth (keel_net_worth_* now value investment
        // accounts at market, not the anchored cash ledger). Best-effort.
        fetchInvestmentsOverview(householdId).catch(() => ({ accounts: [] as { accountId: string; currentMinor: string; isManual: boolean }[] })),
      ]);
      return { accounts: a, kinds: k, balances: b.rows, connections: c, investments: inv.accounts };
    },
    enabled: householdId !== null,
  });
  const accounts = data?.accounts ?? [];
  const kinds = data?.kinds ?? new Map<string, string>();
  const byLedger = new Map((data?.balances ?? []).map((r) => [r.ledgerAccountId, r]));
  const connById = new Map((data?.connections ?? []).map((c) => [c.id, c]));

  // Overlay market value onto investment accounts' ledger balances so the rail
  // (per-row, per-group subtotal, and net-worth foot — all read byLedger)
  // reconciles with the headline net worth. Only connected (non-manual)
  // investment accounts get a snapshot; a manual investment account (e.g. a
  // hand-entered Roth 401k) has no snapshot and keeps its ledger balance, which
  // matches the backend's ledger fallback for accounts with no Plaid snapshot.
  const marketByAccount = new Map(
    (data?.investments ?? [])
      .filter((r) => !r.isManual && r.currentMinor !== '')
      .map((r) => [r.accountId, r.currentMinor]),
  );
  for (const a of accounts) {
    if (!looksLikeInvestmentAccount(a.subtype)) continue;
    const market = marketByAccount.get(a.id);
    if (market == null) continue;
    const existing = byLedger.get(a.ledgerAccountId);
    byLedger.set(a.ledgerAccountId, {
      ledgerAccountId: a.ledgerAccountId,
      currency: existing?.currency ?? a.currency,
      balanceMinor: market,
    });
  }

  if (accounts.length === 0) return null;

  // One account row — the stretched-link row shared by the flat layout and
  // every per-entity section, so both render identically.
  const accountRow = (a: AccountRow) => {
    const href = `/dashboard/accounts/${a.id}`;
    const active = pathname === href;
    const bal = byLedger.get(a.ledgerAccountId);
    const conn = a.connectionId ? connById.get(a.connectionId) : undefined;
    // C8 freshness in the rail: hover/tooltip only — the 11px row has no room
    // for visible text without breaking the calm alignment; the Accounts page
    // and detail carry the visible "Updated Nh ago".
    const updated = conn?.lastSuccessfulSyncAt
      ? relativeSyncLabel(conn.lastSuccessfulSyncAt, new Date().toISOString())
      : null;
    return (
      // Stretched-link row so the compact reauth link can sit above the
      // account link (z-10) without nesting anchors.
      <div
        key={a.id}
        className={cn(
          'relative flex items-center justify-between gap-2 rounded-md py-1 pl-6 pr-3 text-xs transition-colors',
          active
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
        )}
        title={updated ? `${a.name} — updated ${updated}` : a.name}
      >
        <Link
          href={href}
          onClick={() => onNavigate?.()}
          className="min-w-0 truncate focus-visible:outline-none"
        >
          <span className="absolute inset-0" aria-hidden="true" />
          {a.name}
        </Link>
        {conn?.status === 'reauth_required' ? (
          <ReauthLink compact className="relative z-10" onNavigate={onNavigate} />
        ) : null}
        {bal ? (
          <Money
            amountMinor={bal.balanceMinor}
            currency={a.currency}
            className="shrink-0 text-[11px]"
          />
        ) : (
          // Missing from the read model — a genuine 0 stays a real balance, so
          // only an absent one shows the em dash.
          <span className="shrink-0 font-mono text-muted-foreground/70">—</span>
        )}
      </div>
    );
  };

  // Mirror the Accounts page's three-way split (asset / liability / other) so
  // each group subtotal reconciles with that page (review finding); folding
  // 'other' kinds into Assets made the per-group subtotals disagree. Takes an
  // arbitrary account set so the same renderer serves the flat layout and each
  // per-entity section.
  const group = (title: string, rows: AccountRow[]) => {
    if (rows.length === 0) return null;
    const subtotal = currencySubtotal(rows, byLedger);
    return (
      <div className="mt-1">
        <div className="flex items-baseline justify-between px-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {title}
          </p>
          {subtotal ? (
            <Money
              amountMinor={subtotal.minor}
              currency={subtotal.currency}
              className="text-[10px] text-muted-foreground/70"
            />
          ) : null}
        </div>
        {rows.map(accountRow)}
      </div>
    );
  };

  // The three-way split over an arbitrary account set (whole household for the
  // flat layout, one entity's accounts for a section).
  const groupsFor = (rows: AccountRow[]) => {
    const assets = rows.filter((a) => kinds.get(a.ledgerAccountId) === 'asset');
    const liabilities = rows.filter((a) => kinds.get(a.ledgerAccountId) === 'liability');
    const other = rows.filter((a) => {
      const kind = kinds.get(a.ledgerAccountId);
      return kind !== 'asset' && kind !== 'liability';
    });
    return (
      <>
        {group('Assets', assets)}
        {group('Liabilities', liabilities)}
        {group('Other', other)}
      </>
    );
  };

  // Net worth across every account in the dominant currency. Equals the
  // Accounts-page net worth for single-currency households (the common case);
  // for mixed-currency households the rail deliberately shows the dominant
  // currency only rather than mis-summing across currencies (Law 4).
  const netWorth = currencySubtotal(accounts, byLedger);

  const netWorthFoot = (
    <div className="mt-1.5 flex items-baseline justify-between border-t border-border/60 px-3 pt-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Net worth
      </span>
      {netWorth ? (
        <Money
          amountMinor={netWorth.minor}
          currency={netWorth.currency}
          className="text-[11px] font-medium"
          muteZero={false}
        />
      ) : (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">—</span>
      )}
    </div>
  );

  // Single-entity household (or entities not yet loaded): the flat layout,
  // unchanged. The Accounts page gates its per-entity view on the same
  // entities.length > 1, so the rail and the page agree on when to split.
  if (entities.length <= 1) {
    return (
      <div className="mb-1">
        {groupsFor(accounts)}
        {netWorthFoot}
      </div>
    );
  }

  // Multi-entity: the Accounts-page Personal / Business split. Bucket accounts
  // by entity, then render one section per entity in entities.list order (the
  // same deterministic order the Accounts page uses), with a trailing "Other
  // entity" section for accounts pointing at an entity the list doesn't know
  // (an archived entity still owning live accounts) rather than dropping them
  // from the household total.
  const byEntity = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    const list = byEntity.get(a.entityId) ?? [];
    list.push(a);
    byEntity.set(a.entityId, list);
  }
  const known = new Set(entities.map((e) => e.entityId));
  const orphanIds = [...byEntity.keys()].filter((id) => !known.has(id)).sort();
  const sections = [
    ...entities.map((e) => ({ entityId: e.entityId, name: e.name })),
    ...orphanIds.map((id) => ({ entityId: id, name: 'Other entity' })),
  ]
    .map((s) => ({ ...s, rows: byEntity.get(s.entityId) ?? [] }))
    .filter((s) => s.rows.length > 0);

  return (
    <div className="mb-1">
      {sections.map((s) => (
        <SidebarEntitySection
          key={s.entityId}
          name={s.name}
          subtotal={currencySubtotal(s.rows, byLedger)}
        >
          {groupsFor(s.rows)}
        </SidebarEntitySection>
      ))}
      {netWorthFoot}
    </div>
  );
}

/**
 * One collapsible entity section in the rail: an entity name header carrying
 * the entity's net subtotal and a disclosure chevron, over its Assets /
 * Liabilities / Other groups. Default-open (the founder wants the breakdown
 * visible, not hidden behind a click) but collapsible so a household with
 * several entities can fold the ones it isn't looking at and keep the rail
 * short. Purely presentational — every balance is computed by the caller from
 * the shared ledger.trial_balance read.
 */
function SidebarEntitySection({
  name,
  subtotal,
  children,
}: {
  name: string;
  subtotal: { minor: string; currency: string } | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-1.5 first:mt-1">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-1 text-left transition-colors hover:bg-secondary/60"
      >
        <span className="flex min-w-0 items-center gap-1">
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground/70 transition-transform',
              open ? '' : '-rotate-90',
            )}
          />
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-foreground/80">
            {name}
          </span>
        </span>
        {subtotal ? (
          <Money
            amountMinor={subtotal.minor}
            currency={subtotal.currency}
            className="shrink-0 text-[11px] font-medium"
            muteZero={false}
          />
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">—</span>
        )}
      </button>
      {open ? children : null}
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
    // The mobile drawer is the only caller with showCollapseToggle=false; on
    // desktop the <aside> (h-dvh overflow-y-auto) is the scroll region, but the
    // Sheet popup is a plain flex column, so the nav list must scroll itself or
    // its lower items sit past the viewport unreachable (X-007).
    const isMobileDrawer = !showCollapseToggle;
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

        {/* Global entity lens (persona theme #2). Renders itself only for a
            multi-entity household; in the collapsed rail there's no room for a
            labelled control, so it's shown at full width only when expanded —
            single-entity households and the collapsed rail see nothing. */}
        {isCollapsed ? null : (
          <div className="px-3 pb-3">
            <EntityLensSwitcher className="w-full" />
          </div>
        )}

        <div
          className={cn(
            'flex-1',
            isCollapsed ? 'px-2' : 'px-3',
            // Constrain + scroll the nav region inside the mobile drawer so
            // every item is reachable; overscroll-contain keeps the gesture
            // from chaining to the page, and the safe-area padding clears the
            // bottom tab bar. Desktop is untouched (the <aside> still scrolls).
            isMobileDrawer &&
              'min-h-0 overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom))]',
          )}
        >
          <NavLinks
            collapsed={isCollapsed}
            onNavigate={() => {
              setMobileOpen(false);
            }}
          />
        </div>

        <div className={cn('border-t border-border', isCollapsed ? 'p-2' : 'p-3')}>
          <div className="mb-2">
            <FooterSettingsLink
              collapsed={isCollapsed}
              onNavigate={() => {
                setMobileOpen(false);
              }}
            />
          </div>
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
              {/* NAVLAYOUT-5: single account row (avatar · email · theme
                  control); Sign out stacked below so nothing overlaps it. */}
              <div className="flex items-center gap-2 px-1">
                <Avatar size="sm">
                  <AvatarFallback>{(email ?? '?').charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
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
          {/* Entity lens on phones. The switcher self-hides for single-entity
              households; the min-w-9 wrapper preserves the right-side spacer so
              the logo stays centered whether or not the control renders. */}
          <div className="flex min-w-9 justify-end">
            <EntityLensSwitcher className="h-9 max-w-[9rem]" />
          </div>
        </header>

        {/* C17: bottom padding reserves room for the fixed phone-width tab
            bar so the last row of any page is never hidden beneath it. The
            bar's own height grows by env(safe-area-inset-bottom) on phones
            with a home indicator (bottom-tab-bar.tsx), so this padding must
            include that same inset — a flat pb-16 alone left content under
            the inset area hidden behind the bar on those devices (review
            finding). 0 at lg+ where the tab bar itself is hidden. */}
        <main className="min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
          <QuickNav />
          {children}
        </main>
        <QueryTimingPanel />
        <BottomTabBar />
      </div>
    </div>
  );
}
