'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ReceiptText } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchLedgerKinds,
  type AccountRow,
  type DailyBalanceRow,
  type RichTransactionRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { BalanceTrendChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { Badge } from '@/components/ui/badge';
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
  const { householdId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const trend = useKeelQuerySilent<DailyBalanceRow>('accounts.balance_daily', householdId, {
    accountId,
  });
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [kinds, setKinds] = useState<Map<string, string> | null>(null);

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
    return () => {
      active = false;
    };
  }, [householdId]);

  const accountTxns = useMemo(
    () => txns.rows.filter((t) => t.accountId === accountId),
    [txns.rows, accountId],
  );
  const spending = useMemo(() => spendingMix(accountTxns), [accountTxns]);

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
          <h2 className="text-sm font-medium text-muted-foreground">
            Transactions{accountTxns.length > 0 ? ` (${String(accountTxns.length)})` : ''}
          </h2>
          {accountTxns.length === 0 ? (
            <EmptyState
              icon={<ReceiptText className="size-6" />}
              title="No transactions yet"
              description="Transactions for this account will appear here once it syncs."
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
