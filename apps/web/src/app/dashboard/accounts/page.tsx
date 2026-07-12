'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet, ChevronRight } from 'lucide-react';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchLedgerKinds,
  type AccountRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { Skeleton } from '@/components/ui/skeleton';

type Enriched = AccountRow & { kind: string; balanceMinor: string };

export default function AccountsPage() {
  return (
    <AppShell>
      <PageHeader title="Accounts" description="Everything you own and owe, by type." />
      <div className="p-6">
        <AccountsBody />
      </div>
    </AppShell>
  );
}

function sumMinor(rows: Enriched[]): string {
  return rows.reduce((acc, r) => acc + BigInt(r.balanceMinor || '0'), 0n).toString();
}

function AccountsBody() {
  const { householdId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
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

  const loading = !ready || balances.loading || accounts === null || kinds === null;
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full max-w-sm" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const balanceByLedger = new Map(balances.rows.map((r) => [r.ledgerAccountId, r.balanceMinor]));
  const enriched: Enriched[] = accounts.map((a) => ({
    ...a,
    kind: kinds.get(a.ledgerAccountId) ?? 'asset',
    balanceMinor: balanceByLedger.get(a.ledgerAccountId) ?? '0',
  }));

  if (enriched.length === 0) {
    return (
      <EmptyState
        icon={<Wallet className="size-6" />}
        title="No accounts yet"
        description="Connect a bank or add an account to start tracking balances."
      />
    );
  }

  const assets = enriched.filter((a) => a.kind === 'asset');
  const liabilities = enriched.filter((a) => a.kind === 'liability');
  const other = enriched.filter((a) => a.kind !== 'asset' && a.kind !== 'liability');
  const netMinor = enriched.reduce((acc, r) => acc + BigInt(r.balanceMinor || '0'), 0n).toString();

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <p className="text-sm text-muted-foreground">Net worth</p>
        <Money amountMinor={netMinor} className="text-3xl font-semibold" muteZero={false} />
      </div>

      <AccountGroup title="Assets" rows={assets} />
      <AccountGroup title="Liabilities" rows={liabilities} />
      {other.length > 0 ? <AccountGroup title="Other" rows={other} /> : null}
    </div>
  );
}

function AccountGroup({ title, rows }: { title: string; rows: Enriched[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <Money amountMinor={sumMinor(rows)} className="text-sm text-muted-foreground" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {rows.map((a, i) => (
          <Link
            key={a.id}
            href={`/dashboard/accounts/${a.id}`}
            className={`flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-secondary/50 ${
              i > 0 ? 'border-t border-border' : ''
            }`}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{a.name}</p>
              <p className="text-xs capitalize text-muted-foreground">
                {a.subtype.replaceAll('_', ' ')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Money amountMinor={a.balanceMinor} currency={a.currency} className="text-sm" />
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
