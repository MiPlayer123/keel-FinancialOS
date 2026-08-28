'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet, ChevronRight } from 'lucide-react';

import { PageHeader, EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useEntityLens } from '@/components/keel/entity-lens-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchConnections,
  fetchEntities,
  fetchLatestBalances,
  fetchLedgerKinds,
  type AccountRow,
  type ConnectionRow,
  type EntityRow,
  type LatestBalanceRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { relativeSyncLabel } from '@/lib/relative-date';
import { utilizationPercent } from '@/lib/credit-utilization';
import { looksLikeRetirementAccount, looksLikeInvestmentAccount } from '@/lib/investment-subtype';
import {
  currencyTotals,
  primaryCurrencyTotal,
  type CurrencyTotal,
} from '@/lib/currency-totals';
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

function totalsFor(rows: Enriched[]): CurrencyTotal[] {
  return currencyTotals(
    rows.map((row) => ({ amountMinor: row.balanceMinor, currency: row.currency })),
  );
}

function CurrencyTotalValues({ rows }: { rows: Enriched[] }) {
  return (
    <span className="flex flex-wrap justify-end gap-x-3 gap-y-1">
      {totalsFor(rows).map((total) => (
        <Money
          key={total.currency}
          amountMinor={total.amountMinor}
          currency={total.currency}
          className="text-sm text-muted-foreground"
        />
      ))}
    </span>
  );
}

function AccountsBody() {
  const { householdId, ready } = useHousehold();
  // Global entity lens (persona theme #2): null = "All entities" (blended,
  // pre-lens behavior). A concrete id narrows this page — and the net-worth
  // hero — to that entity's accounts only, client-side. `entityLens` is always
  // null for a single-entity household, so nothing below changes for them.
  const { entityId: entityLens, entity: lensEntity } = useEntityLens();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [kinds, setKinds] = useState<Map<string, string> | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [provider, setProvider] = useState<LatestBalanceRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!householdId) {
      setAccounts([]);
      setKinds(new Map());
      setLoadError(null);
      return;
    }
    setLoadError(null);
    let active = true;
    void Promise.all([fetchAccounts(householdId), fetchLedgerKinds(householdId)])
      .then(([a, k]) => {
        if (!active) return;
        setAccounts(a);
        setKinds(k);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAccounts([]);
        setKinds(new Map());
        setLoadError(error instanceof Error ? error.message : 'Could not load accounts.');
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
    // F-023: entity grouping is additive — a failed entities read degrades
    // to the single-entity layout, never blocks balances.
    void fetchEntities(householdId)
      .then((rows) => {
        if (active) setEntities(rows);
      })
      .catch(() => {
        if (active) setEntities([]);
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

  const coreError = balances.error ?? loadError;
  if (coreError) {
    return (
      <QueryErrorState
        description={coreError}
        onRetry={() => {
          setReload((value) => value + 1);
          void balances.refetch();
        }}
      />
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
    // Investment accounts display their MARKET value (Plaid snapshot total incl.
    // securities), matching the headline net worth and the sidebar rail. The
    // anchored cash ledger is stale + already contains securities, so it is not
    // the right display figure. A manual investment account has no provider
    // snapshot → falls back to its ledger balance (same as the backend).
    const marketMinor =
      looksLikeInvestmentAccount(a.subtype) && snapshot?.currentMinor
        ? snapshot.currentMinor
        : null;
    return {
      ...a,
      kind,
      balanceMinor: marketMinor ?? balanceByLedger.get(a.ledgerAccountId) ?? '0',
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

  // Entity lens (persona theme #2): when a specific entity is selected, this
  // page shows exactly that entity's accounts, grouped by type. It's a VIEW
  // filter — the hidden accounts aren't erased, they're just out of the lens,
  // and the net-worth hero below scopes to match so its number equals the sum
  // of the rows shown (no phantom money, no double-count).
  const lensRows = entityLens === null ? enriched : enriched.filter((a) => a.entityId === entityLens);

  const assets = lensRows.filter((a) => a.kind === 'asset');
  const liabilities = lensRows.filter((a) => a.kind === 'liability');
  const other = lensRows.filter((a) => a.kind !== 'asset' && a.kind !== 'liability');
  const netTotals = totalsFor(lensRows);
  const primaryNet = primaryCurrencyTotal(
    lensRows.map((row) => ({ amountMinor: row.balanceMinor, currency: row.currency })),
  ) ?? { amountMinor: '0', currency: 'USD', rowCount: 0 };

  // F-023: entity grouping renders ONLY for a blended, multi-entity household —
  // a single-entity household (entities.length <= 1) and a lensed view (one
  // entity already chosen) both see the plain type-grouped layout.
  const multiEntity = entities.length > 1;
  const lensActive = entityLens !== null;

  return (
    <div className="space-y-8">
      {/* Fused hero (C11): number + Δ + % + window + chart as one unit. When a
          lens is active the hero is entity-scoped: it drops the household-wide
          trend series (which can't be decomposed per entity client-side) and
          shows the lensed net worth from the rows above — the number always
          matches what's on screen (Law 9). */}
      <NetWorthHero
        householdId={householdId}
        fallbackNetMinor={primaryNet.amountMinor}
        fallbackCurrency={primaryNet.currency}
        fallbackMultiCurrency={netTotals.length > 1}
        fallbackAsOf={balances.asOf}
        entityScoped={lensActive}
        {...(lensActive && lensEntity ? { scopeLabel: `${lensEntity.name} only` } : {})}
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

      {multiEntity && !lensActive ? (
        <EntityGroupedAccounts entities={entities} rows={enriched} />
      ) : (
        <>
          <AccountGroup title="Assets" rows={assets} />
          <AccountGroup title="Liabilities" rows={liabilities} />
          {other.length > 0 ? <AccountGroup title="Other" rows={other} /> : null}
        </>
      )}
    </div>
  );
}

type EntitySection = {
  entityId: string;
  name: string;
  rows: Enriched[];
  assets: Enriched[];
  liabilities: Enriched[];
};

/**
 * F-023: per-entity breakdown — net-worth chips up top, then each entity's
 * accounts with Assets / Retirement / Liabilities subtotals. "Retirement" is
 * an account class carved out of assets (subtype keywords), NOT a legal
 * entity. Entities render in entities.list order (deterministic); accounts
 * pointing at an entity the list doesn't know (an archived entity still
 * owning live accounts) fall into a trailing "Other entity" section rather
 * than silently vanishing from the page total.
 */
function EntityGroupedAccounts({ entities, rows }: { entities: EntityRow[]; rows: Enriched[] }) {
  const byEntity = new Map<string, Enriched[]>();
  for (const r of rows) {
    const list = byEntity.get(r.entityId) ?? [];
    list.push(r);
    byEntity.set(r.entityId, list);
  }
  const known = new Set(entities.map((e) => e.entityId));
  const orphanIds = [...byEntity.keys()].filter((id) => !known.has(id)).sort();
  const sections: EntitySection[] = [
    ...entities.map((e) => ({ entityId: e.entityId, name: e.name })),
    ...orphanIds.map((id) => ({ entityId: id, name: 'Other entity' })),
  ]
    .map(({ entityId, name }) => {
      const entityRows = byEntity.get(entityId) ?? [];
      return {
        entityId,
        name,
        rows: entityRows,
        assets: entityRows.filter((r) => r.kind === 'asset'),
        liabilities: entityRows.filter((r) => r.kind === 'liability'),
      };
    })
    .filter((s) => s.rows.length > 0);

  return (
    <div className="space-y-8">
      {/* Per-entity net worth at a glance (F-023b). */}
      <div className="flex flex-wrap gap-2">
        {sections.map((s) => (
          <div
            key={s.entityId}
            className="flex items-baseline gap-2 rounded-lg border border-border bg-card px-3 py-2"
          >
            <span className="text-xs font-medium text-muted-foreground">{s.name}</span>
            <CurrencyTotalValues rows={s.rows} />
          </div>
        ))}
      </div>

      {sections.map((s) => {
        const retirement = s.rows.filter(
          (r) => r.kind === 'asset' && looksLikeRetirementAccount(r.subtype),
        );
        const assets = s.rows.filter(
          (r) => r.kind === 'asset' && !looksLikeRetirementAccount(r.subtype),
        );
        const liabilities = s.rows.filter((r) => r.kind === 'liability');
        const other = s.rows.filter((r) => r.kind !== 'asset' && r.kind !== 'liability');
        return (
          <section key={s.entityId} className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
              <h2 className="text-base font-semibold">{s.name}</h2>
              <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Assets <CurrencyTotalValues rows={s.assets} />
                </span>
                <span>
                  Liabilities <CurrencyTotalValues rows={s.liabilities} />
                </span>
                <span>
                  Net <CurrencyTotalValues rows={s.rows} />
                </span>
              </p>
            </div>
            <AccountGroup title="Assets" rows={assets} />
            <AccountGroup title="Retirement" rows={retirement} />
            <AccountGroup title="Liabilities" rows={liabilities} />
            {other.length > 0 ? <AccountGroup title="Other" rows={other} /> : null}
          </section>
        );
      })}
    </div>
  );
}

function AccountGroup({ title, rows }: { title: string; rows: Enriched[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        <CurrencyTotalValues rows={rows} />
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
