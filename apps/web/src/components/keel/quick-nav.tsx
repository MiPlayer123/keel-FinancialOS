'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  Plus,
  Tags,
  TrendingUp,
} from 'lucide-react';

import { useHousehold } from '@/components/keel/household-context';
import {
  fetchAccounts,
  fetchCategories,
  searchTransactions,
  type AccountRow,
  type CategoryRow,
  type TransactionSearchHit,
} from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
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
  { label: 'Transactions', href: '/dashboard/ledger', icon: ReceiptText },
  { label: 'Investments', href: '/dashboard/investments', icon: TrendingUp },
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
  // F-021: server-backed transaction/payee search. The palette input is
  // controlled so the term can drive a DEBOUNCED server query (never a
  // client-side scan over a full download — that's the whole point).
  const [term, setTerm] = useState('');
  const [txnHits, setTxnHits] = useState<TransactionSearchHit[]>([]);

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

  // Debounced server search: 200ms after the user stops typing, fetch up to 8
  // matching transactions. A term under 2 chars clears results (too broad to be
  // useful and needlessly heavy). Results are discarded if the term changed or
  // the palette closed before the request resolved (stale-response guard).
  useEffect(() => {
    if (!open || !householdId) return;
    const q = term.trim();
    if (q.length < 2) {
      setTxnHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void searchTransactions(householdId, q, 8)
        .then((hits) => {
          if (active) setTxnHits(hits);
        })
        .catch(() => {
          if (active) setTxnHits([]);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term, open, householdId]);

  // Reset the query + results whenever the palette closes so a fresh open
  // starts clean (and doesn't flash the previous session's hits).
  useEffect(() => {
    if (!open) {
      setTerm('');
      setTxnHits([]);
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Quick navigation">
      <CommandInput
        placeholder="Jump to a page, account, or search transactions…"
        value={term}
        onValueChange={setTerm}
      />
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
          <CommandItem
            onSelect={() => {
              go('/dashboard#categories');
            }}
          >
            <Tags className="size-4" />
            Manage categories
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
                  // Id suffix: two same-named accounts must not collide in
                  // cmdk's value-keyed selection.
                  value={`account ${a.name} ${a.id}`}
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
                  value={`category ${c.name} ${c.ledgerAccountId}`}
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
        {txnHits.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Transactions">
              {txnHits.map((t) => (
                <CommandItem
                  key={t.transactionId}
                  // Include the live term in the value so cmdk's own filter
                  // (if active) never hides a server hit — the server already
                  // decided it matches. Id keeps same-named payees distinct.
                  value={`transaction ${term} ${t.description} ${t.transactionId}`}
                  onSelect={() => {
                    // Open the ledger scoped to this account with the search
                    // pre-filled, landing the user on (or near) the row.
                    go(
                      `/dashboard/ledger?account=${t.accountId}&q=${encodeURIComponent(
                        t.description,
                      )}`,
                    );
                  }}
                >
                  <ReceiptText className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{t.description}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t.effectiveDate}</span>
                    <Money
                      amountMinor={t.amountMinor}
                      currency={t.currency}
                      signed
                      className="text-xs tabular-nums"
                    />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}
