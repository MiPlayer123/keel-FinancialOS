'use client';

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import { fetchAccounts, type AccountRow, type TrialBalanceRow } from '@/lib/keel-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function HomePage() {
  return (
    <AppShell>
      <PageHeader title="Home" description="Your financial position at a glance." />
      <div className="space-y-8 p-6">
        <HomeBody />
      </div>
    </AppShell>
  );
}

function HomeBody() {
  const { householdId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    void fetchAccounts(householdId)
      .then((a) => {
        if (active) setAccounts(a);
      })
      .catch(() => {
        if (active) setAccounts([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  const loading = !ready || balances.loading || accounts === null;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full max-w-sm" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const balanceByLedger = new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor]));
  const netMinor = accounts.reduce((acc, a) => {
    const b = balanceByLedger.get(a.ledgerAccountId) ?? '0';
    return acc + BigInt(b);
  }, 0n);

  return (
    <>
      <Card className="max-w-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Net position</CardTitle>
        </CardHeader>
        <CardContent>
          <Money
            amountMinor={netMinor.toString()}
            className="text-3xl font-semibold"
            muteZero={false}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Accounts</h2>
        {accounts.length === 0 ? (
          <EmptyState
            icon={<Wallet className="size-6" />}
            title="No accounts yet"
            description="Connect a bank or add an account to start tracking balances."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {accounts.map((a, i) => (
              <div
                key={a.id}
                className={`flex items-center justify-between px-4 py-3 ${
                  i > 0 ? 'border-t border-border' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{a.name}</p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {a.subtype.replaceAll('_', ' ')}
                  </p>
                </div>
                <Money
                  amountMinor={balanceByLedger.get(a.ledgerAccountId) ?? '0'}
                  currency={a.currency}
                  className="text-sm"
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
