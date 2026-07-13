'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Plus, ReceiptText } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCategories,
  fetchLedgerKinds,
  fetchLatestBalances,
  type AccountRow,
  type CategoryRow,
  type DailyBalanceRow,
  type LatestBalanceRow,
  type RichTransactionRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { BalanceTrendChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

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
  const [adding, setAdding] = useState(false);

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
    return () => {
      active = false;
    };
  }, [householdId, accountId]);

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
          <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
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
        </div>
      </div>

      {trend !== null && trend.length > 1 ? (
        <Card>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-2 lg:col-span-2">
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
            <div className="overflow-hidden rounded-lg border border-border">
              {accountTxns.map((t, i) => (
                <div
                  key={t.transactionId}
                  className={`flex items-center gap-3 px-4 py-2.5 ${
                    i > 0 ? 'border-t border-border' : ''
                  }`}
                >
                  <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
                    {t.effectiveDate.slice(5)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={t.description}>
                      {t.description}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {t.transferStatus === 'confirmed' ? 'Transfer' : (t.categoryName ?? '—')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {t.status === 'pending' ? (
                      <Badge variant="outline" className="hidden text-[10px] uppercase sm:inline-flex">
                        Pending
                      </Badge>
                    ) : null}
                    <Money
                      amountMinor={t.amountMinor}
                      currency={t.currency}
                      signed
                      className="min-w-24 text-right text-sm tabular-nums"
                    />
                    {runningByTxn.has(t.transactionId) ? (
                      <Money
                        amountMinor={runningByTxn.get(t.transactionId) ?? '0'}
                        currency={t.currency}
                        className="hidden min-w-24 text-right text-xs text-muted-foreground lg:inline"
                      />
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {spending.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Spending mix · last 30 days
            </h2>
            <Card>
              <CardContent className="pt-5">
                <CategoryBarList items={spending} />
              </CardContent>
            </Card>
          </section>
        ) : null}
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
