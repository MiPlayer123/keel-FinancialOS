'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet, ChevronRight } from 'lucide-react';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchConnections,
  fetchLatestBalances,
  fetchLedgerKinds,
  type AccountRow,
  type ConnectionRow,
  type LatestBalanceRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { relativeSyncLabel } from '@/lib/relative-date';
import { utilizationPercent } from '@/lib/credit-utilization';
import { Skeleton } from '@/components/ui/skeleton';
import { AddAccountDialog } from '@/components/keel/add-account-dialog';
import { NetWorthHero } from '@/components/keel/net-worth-hero';
import { RecordTransferDialog } from '@/components/keel/record-transfer-dialog';
import { ReauthLink } from '@/components/keel/reauth-link';
import { buttonVariants } from '@/components/ui/button';

type Enriched = AccountRow & {
  kind: string;
  balanceMinor: string;
  /** "Updated 2h ago" from the owning connection; null for manual accounts. */
  syncLabel: string | null;
  needsReauth: boolean;
  /** Integer % of the provider credit limit in use; null when no limit exists. */
  utilization: number | null;
};

export default function AccountsPage() {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Everything you own and owe, by type."
        actions={
          <Link
            href="/dashboard/connections"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Manage connections
          </Link>
        }
      />
      <div className="p-6">
        <AccountsBody />
      </div>
    </>
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
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [provider, setProvider] = useState<LatestBalanceRow[]>([]);
  const [reload, setReload] = useState(0);

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
    // Row enrichment (C8/C9) is best-effort: freshness/reauth ride the same
    // member-read the Connections page uses, utilization the same
    // balances.latest the detail page uses. A failure here degrades to
    // exactly the pre-slice rows — never blocks balances.
    void fetchConnections(householdId)
      .then((c) => {
        if (active) setConnections(c);
      })
      .catch(() => {
        if (active) setConnections([]);
      });
    void fetchLatestBalances(householdId)
      .then((rows) => {
        if (active) setProvider(rows);
      })
      .catch(() => {
        if (active) setProvider([]);
      });
    return () => {
      active = false;
    };
  }, [householdId, reload]);

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
  const connectionById = new Map(connections.map((c) => [c.id, c]));
  const providerByAccount = new Map(provider.map((r) => [r.accountId, r]));
  const nowIso = new Date().toISOString();
  const enriched: Enriched[] = accounts.map((a) => {
    const kind = kinds.get(a.ledgerAccountId) ?? 'asset';
    const conn = a.connectionId ? connectionById.get(a.connectionId) : undefined;
    const snapshot = providerByAccount.get(a.id);
    return {
      ...a,
      kind,
      balanceMinor: balanceByLedger.get(a.ledgerAccountId) ?? '0',
      syncLabel: conn?.lastSuccessfulSyncAt
        ? relativeSyncLabel(conn.lastSuccessfulSyncAt, nowIso)
        : null,
      needsReauth: conn?.status === 'reauth_required',
      // Utilization only ever renders on liabilities WITH a provider limit —
      // provider currentMinor is the positive owed magnitude the bank reports.
      utilization:
        kind === 'liability' && snapshot
          ? utilizationPercent(snapshot.currentMinor, snapshot.limitMinor ?? null)
          : null,
    };
  });

  if (enriched.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={<Wallet className="size-6" />}
          title="No accounts yet"
          description="Connect a bank or add an account to start tracking balances."
        />
        <div className="flex justify-center">
          <AddAccountDialog
            onCreated={() => {
              setReload((n) => n + 1);
              void balances.refetch();
            }}
          />
        </div>
      </div>
    );
  }

  const assets = enriched.filter((a) => a.kind === 'asset');
  const liabilities = enriched.filter((a) => a.kind === 'liability');
  const other = enriched.filter((a) => a.kind !== 'asset' && a.kind !== 'liability');
  const netMinor = enriched.reduce((acc, r) => acc + BigInt(r.balanceMinor || '0'), 0n).toString();

  return (
    <div className="space-y-8">
      {/* Fused hero (C11): number + Δ + % + window + chart as one unit. */}
      <NetWorthHero
        householdId={householdId}
        fallbackNetMinor={netMinor}
        fallbackAsOf={balances.asOf}
        actions={
          <>
            <RecordTransferDialog
              accounts={accounts}
              onDone={() => {
                setReload((n) => n + 1);
                void balances.refetch();
              }}
            />
            <AddAccountDialog
              onCreated={() => {
                setReload((n) => n + 1);
                void balances.refetch();
              }}
            />
          </>
        }
      />

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
          // Stretched-link row: the account link covers the whole row via the
          // absolute overlay span, while the reauth link stays independently
          // clickable above it (z-10) — no nested anchors.
          <div
            key={a.id}
            className={`relative flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-secondary/50 ${
              i > 0 ? 'border-t border-border' : ''
            }`}
          >
            <div className="min-w-0">
              <Link href={`/dashboard/accounts/${a.id}`} className="focus-visible:outline-none">
                <span className="absolute inset-0" aria-hidden="true" />
                <p className="truncate text-sm font-medium">{a.name}</p>
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                <span className="capitalize">{a.subtype.replaceAll('_', ' ')}</span>
                {/* Freshness at the row (C8): from the OWNING connection's
                    last successful sync — status adjacent to its number. */}
                {a.syncLabel ? <> · Updated {a.syncLabel}</> : null}
              </p>
              {a.needsReauth ? <ReauthLink className="relative z-10 mt-1" /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="text-right">
                <Money amountMinor={a.balanceMinor} currency={a.currency} className="text-sm" />
                {/* Utilization (C9): only when a provider limit exists; neutral
                    tokens — the % is status, not negative money (Law 8). */}
                {a.utilization !== null ? (
                  <p className="text-[11px] text-muted-foreground">{a.utilization}% of limit</p>
                ) : null}
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
