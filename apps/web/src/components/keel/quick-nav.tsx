'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Wallet,
  ReceiptText,
  Repeat,
  PiggyBank,
  BarChart3,
  Banknote,
  ArrowLeftRight,
  FileCheck2,
  BadgeCheck,
  Link2,
  Settings,
  Plus,
  Tags,
} from 'lucide-react';

import { useHousehold } from '@/components/keel/household-context';
import { fetchAccounts, fetchCategories, type AccountRow, type CategoryRow } from '@/lib/keel-api';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';

const PAGES = [
  { label: 'Home', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Accounts', href: '/dashboard/accounts', icon: Wallet },
  { label: 'Ledger', href: '/dashboard/ledger', icon: ReceiptText },
  { label: 'Recurring', href: '/dashboard/recurring', icon: Repeat },
  { label: 'Budgets', href: '/dashboard/budgets', icon: PiggyBank },
  { label: 'Reports', href: '/dashboard/reports', icon: BarChart3 },
  { label: 'Paychecks', href: '/dashboard/paychecks', icon: Banknote },
  { label: 'Reimbursements', href: '/dashboard/reimbursements', icon: ArrowLeftRight },
  { label: 'Statements', href: '/dashboard/statements', icon: FileCheck2 },
  { label: 'Review', href: '/dashboard/review', icon: BadgeCheck },
  { label: 'Connections', href: '/dashboard/connections', icon: Link2 },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
];

/**
 * ⌘K / Ctrl-K everywhere: pages, accounts, categories, and the two most
 * common actions. Data loads lazily on first open — the palette costs
 * nothing until summoned.
 */
export function QuickNav() {
  const router = useRouter();
  const { householdId } = useHousehold();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (!open || !householdId || accounts !== null) return;
    let active = true;
    void Promise.all([fetchAccounts(householdId), fetchCategories(householdId)])
      .then(([a, c]) => {
        if (!active) return;
        setAccounts(a);
        setCategories(c);
      })
      .catch(() => {
        if (!active) return;
        setAccounts([]);
        setCategories([]);
      });
    return () => {
      active = false;
    };
  }, [open, householdId, accounts]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Quick navigation">
      <CommandInput placeholder="Jump to a page, account, or category…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              go('/dashboard/ledger?add=1');
            }}
          >
            <Plus className="size-4" />
            Add transaction
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Pages">
          {PAGES.map(({ label, href, icon: Icon }) => (
            <CommandItem
              key={href}
              onSelect={() => {
                go(href);
              }}
            >
              <Icon className="size-4" />
              {label}
            </CommandItem>
          ))}
        </CommandGroup>
        {accounts && accounts.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Accounts">
              {accounts.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`account ${a.name}`}
                  onSelect={() => {
                    go(`/dashboard/accounts/${a.id}`);
                  }}
                >
                  <Wallet className="size-4" />
                  {a.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
        {categories && categories.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Categories">
              {categories.map((c) => (
                <CommandItem
                  key={c.ledgerAccountId}
                  value={`category ${c.name}`}
                  onSelect={() => {
                    go(`/dashboard/ledger?category=${c.ledgerAccountId}`);
                  }}
                >
                  <Tags className="size-4" />
                  {c.name}
                  {c.kind === 'income' ? (
                    <span className="text-xs text-muted-foreground">income</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
