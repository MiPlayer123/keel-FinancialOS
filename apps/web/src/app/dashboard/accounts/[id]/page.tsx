'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Plus, ReceiptText } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import { toast } from 'sonner';
import {
  categorizeTransaction,
  fetchAccounts,
  fetchGoals,
  fetchCategories,
  fetchLedgerKinds,
  fetchLatestBalances,
  fetchTags,
  type AccountRow,
  type CategoryRow,
  type DailyBalanceRow,
  type LatestBalanceRow,
  type GoalRow,
  type RichTransactionRow,
  type TagRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { RenameAccountDialog } from '@/components/keel/rename-account-dialog';
import { TxnEditDialog, TxnList } from '@/components/keel/txn-edit-dialog';
import { BalanceTrendChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const EMPTY_SELECTION = new Set<string>();

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <AppShell>
      <AccountDetailBody accountId={params.id} />
    </AppShell>
  );
}

function AccountDetailBody({ accountId }: { accountId: string }) {
  const { householdId, userId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const trend = useKeelQuerySilent<DailyBalanceRow>('accounts.balance_daily', householdId, {
    accountId,
  });
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [kinds, setKinds] = useState<Map<string, string> | null>(null);
  const [provider, setProvider] = useState<LatestBalanceRow | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RichTransactionRow | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [accountReload, setAccountReload] = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (!householdId) {
      setAccounts([]);
      setKinds(new Map());
      return;
    }
    let active = true;
    void Promise.all([fetchAccounts(householdId), fetchLedgerKinds(householdId)])
      .then(([a, k]) => {
        if (!active) return;
        setAccounts(a);
        setKinds(k);
      })
      .catch(() => {
        if (!active) return;
        setAccounts([]);
        setKinds(new Map());
      });
    void fetchLatestBalances(householdId)
      .then((rows) => {
        if (active) setProvider(rows.find((r) => r.accountId === accountId) ?? null);
      })
      .catch(() => {
        if (active) setProvider(null);
      });
    void fetchCategories(householdId)
      .then((c) => {
        if (active) setCategories(c);
      })
      .catch(() => {
        if (active) setCategories([]);
      });
    void fetchTags(householdId)
      .then((t) => {
        if (active) setTags(t);
      })
      .catch(() => {
        if (active) setTags([]);
      });
    void fetchGoals(householdId)
      .then((g) => {
        if (active) setGoals(g);
      })
      .catch(() => {
        if (active) setGoals([]);
      });
    return () => {
      active = false;
    };
  }, [householdId, accountId, accountReload]);

  const accountTxns = useMemo(
    () => txns.rows.filter((t) => t.accountId === accountId),
    [txns.rows, accountId],
  );
  const spending = useMemo(() => spendingMix(accountTxns), [accountTxns]);

  const balanceByLedgerMap = useMemo(
    () => new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor])),
    [balances.rows],
  );
  // Quicken-register running balance: walk newest→oldest from the account's
  // CURRENT ledger balance so the top row always ties to the header number.
  const runningByTxn = useMemo(() => {
    const map = new Map<string, string>();
    const ledgerId = accounts?.find((a) => a.id === accountId)?.ledgerAccountId;
    if (!ledgerId) return map;
    let running = BigInt(balanceByLedgerMap.get(ledgerId) ?? '0');
    const sorted = [...accountTxns].sort(
      (a, b) =>
        b.effectiveDate.localeCompare(a.effectiveDate) ||
        a.transactionId.localeCompare(b.transactionId),
    );
    for (const t of sorted) {
      map.set(t.transactionId, running.toString());
      running -= BigInt(t.amountMinor || '0');
    }
    return map;
  }, [accountTxns, accounts, accountId, balanceByLedgerMap]);

  const loading = !ready || balances.loading || accounts === null || kinds === null;
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full max-w-sm" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    return (
      <div className="p-6">
        <BackLink />
        <EmptyState title="Account not found" description="This account isn't in your household." />
      </div>
    );
  }

  const balanceByLedger = new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor]));
  const balanceMinor = balanceByLedger.get(account.ledgerAccountId) ?? '0';
  const kind = kinds.get(account.ledgerAccountId) ?? 'asset';

  return (
    <div className="space-y-6 p-6">
      <BackLink />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rename account"
              title="Rename account"
              className="text-muted-foreground/60 hover:text-foreground"
              onClick={() => {
                setRenaming(true);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
          <p className="text-sm capitalize text-muted-foreground">
            {kind} · {account.subtype.replaceAll('_', ' ')}
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-sm text-muted-foreground">Balance</p>
          <Money
            amountMinor={balanceMinor}
            currency={account.currency}
            className="text-2xl font-semibold"
            muteZero={false}
          />
          {provider?.availableMinor ? (
            <p className="text-xs text-muted-foreground">
              <Money
                amountMinor={provider.availableMinor}
                currency={account.currency}
                className="text-xs"
              />{' '}
              available at the bank
            </p>
          ) : null}
          <EarmarkLine
            goals={goals}
            accountId={accountId}
            balanceMinor={balanceMinor}
            currency={account.currency}
          />
        </div>
      </div>

      <RenameAccountDialog
        open={renaming}
        householdId={householdId}
        accountId={accountId}
        currentName={account.name}
        onClose={() => {
          setRenaming(false);
        }}
        onRenamed={() => {
          setRenaming(false);
          setAccountReload((n) => n + 1);
          void txns.refetch();
        }}
      />

      {(trend !== null && trend.length > 1) || spending.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {trend !== null && trend.length > 1 ? (
            <Card className={spending.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Balance · last 90 days
                </CardTitle>
              </CardHeader>
              <CardContent>
                <BalanceTrendChart points={trend} />
              </CardContent>
            </Card>
          ) : null}
          {spending.length > 0 ? (
            <Card className={trend !== null && trend.length > 1 ? '' : 'lg:col-span-3'}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Spending mix · last 30 days
                </CardTitle>
              </CardHeader>
              <CardContent>
                <CategoryBarList items={spending} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      <div>
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              Transactions{accountTxns.length > 0 ? ` (${String(accountTxns.length)})` : ''}
            </h2>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setAdding(true);
              }}
            >
              <Plus className="size-3.5" />
              Add
            </Button>
          </div>
          <AddTransactionDialog
            open={adding}
            householdId={householdId}
            userId={userId}
            accounts={accounts}
            categories={categories}
            defaultAccountId={accountId}
            history={txns.rows}
            onClose={() => {
              setAdding(false);
            }}
            onSaved={() => {
              setAdding(false);
              void txns.refetch();
              void balances.refetch();
            }}
          />
          {accountTxns.length === 0 ? (
            <EmptyState
              icon={<ReceiptText className="size-6" />}
              title="No transactions yet"
              description="Transactions land here when the account syncs — or add one by hand."
            />
          ) : (
            <TxnList
              rows={accountTxns}
              categories={categories}
              running={runningByTxn}
              selecting={false}
              selected={EMPTY_SELECTION}
              onToggle={() => undefined}
              onEdit={setEditing}
              onRecategorize={(txnId, categoryId) => {
                if (!householdId) return;
                void categorizeTransaction({
                  householdId,
                  transactionId: txnId,
                  categoryLedgerAccountId: categoryId,
                })
                  .then(() => txns.refetch())
                  .catch((err: unknown) => {
                    toast.error(
                      err instanceof Error ? err.message : 'Could not change the category.',
                    );
                  });
              }}
            />
          )}
        </section>

        <TxnEditDialog
          row={editing}
          householdId={householdId}
          userId={userId}
          categories={categories}
          allTags={tags}
          onTagsMutated={() => {
            void txns.refetch();
            if (householdId) {
              void fetchTags(householdId)
                .then(setTags)
                .catch(() => undefined);
            }
          }}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void txns.refetch();
            void balances.refetch();
          }}
          onRecategorize={(txnId, categoryId) => {
            if (!householdId) return;
            void categorizeTransaction({
              householdId,
              transactionId: txnId,
              categoryLedgerAccountId: categoryId,
            })
              .then(() => txns.refetch())
              .catch((err: unknown) => {
                toast.error(err instanceof Error ? err.message : 'Could not change the category.');
              });
          }}
          onMerchantSearch={(description) => {
            router.push(`/dashboard/ledger?q=${encodeURIComponent(description)}`);
          }}
        />
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/dashboard/accounts"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Accounts
    </Link>
  );
}

/**
 * Earmarks are bookkeeping, not transfers (money never moves) — this line
 * shows how much of the balance is spoken for by goals living here, and what
 * that leaves free. BigInt only (Law 4).
 */
function EarmarkLine({
  goals,
  accountId,
  balanceMinor,
  currency,
}: {
  goals: GoalRow[];
  accountId: string;
  balanceMinor: string;
  currency: string;
}) {
  const earmarked = goals
    .filter((g) => g.accountId === accountId && g.status !== 'archived')
    .reduce((acc, g) => acc + BigInt(g.savedMinor || '0'), 0n);
  if (earmarked <= 0n) return null;
  const free = BigInt(balanceMinor || '0') - earmarked;
  return (
    <p className="text-xs text-muted-foreground">
      <Money amountMinor={earmarked.toString()} currency={currency} className="text-xs" /> earmarked
      for goals · <Money amountMinor={free.toString()} currency={currency} className="text-xs" />{' '}
      free
    </p>
  );
}
