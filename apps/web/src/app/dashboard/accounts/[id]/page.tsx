'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Pencil, Plus, ReceiptText, Scale, Wand2 } from 'lucide-react';

import { EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery, useKeelQuerySilent } from '@/lib/use-keel-query';
import { toast } from 'sonner';
import {
  categorizeTransaction,
  fetchAccounts,
  fetchConnections,
  fetchEntities,
  fetchGoals,
  reanchorAccountBalance,
  fetchCategories,
  fetchLedgerKinds,
  fetchLatestBalances,
  fetchTags,
  type AccountRow,
  type CategoryRow,
  type ConnectionRow,
  type DailyBalanceRow,
  type EntityRow,
  type LatestBalanceRow,
  type GoalRow,
  type RichTransactionRow,
  type TagRow,
  type TrialBalanceRow,
} from '@/lib/keel-api';
import { relativeSyncLabel } from '@/lib/relative-date';
import { utilizationPercent } from '@/lib/credit-utilization';
import { ReauthLink } from '@/components/keel/reauth-link';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { RenameAccountDialog } from '@/components/keel/rename-account-dialog';
import { ReassignEntityDialog } from '@/components/keel/reassign-entity-dialog';
import { SetOpeningBalanceDialog } from '@/components/keel/set-opening-balance-dialog';
import { TxnEditDialog, TxnList } from '@/components/keel/txn-edit-dialog';
import { BalanceTrendChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const EMPTY_SELECTION = new Set<string>();

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  return <AccountDetailBody accountId={params.id} />;
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
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RichTransactionRow | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [accountReload, setAccountReload] = useState(0);
  const [settingBalance, setSettingBalance] = useState(false);
  const [fixingBalance, setFixingBalance] = useState(false);
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
    // Per-account freshness/reauth (C8): same member-read the Connections
    // page uses; best-effort — a failure degrades to the pre-slice header.
    void fetchConnections(householdId)
      .then((c) => {
        if (active) setConnections(c);
      })
      .catch(() => {
        if (active) setConnections([]);
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
    void fetchEntities(householdId)
      .then((e) => {
        if (active) setEntities(e);
      })
      .catch(() => {
        if (active) setEntities([]);
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
  // C8: freshness + reauth from the OWNING connection (manual accounts have none).
  const connection = account.connectionId
    ? connections.find((c) => c.id === account.connectionId)
    : undefined;
  const syncLabel = connection?.lastSuccessfulSyncAt
    ? relativeSyncLabel(connection.lastSuccessfulSyncAt, new Date().toISOString())
    : null;
  // C9: utilization only when the provider reports a limit; currentMinor is
  // the positive owed magnitude, so the % is scaled-integer BigInt math.
  const utilization =
    kind === 'liability' && provider
      ? utilizationPercent(provider.currentMinor, provider.limitMinor ?? null)
      : null;
  const entityName = entities.find((e) => e.entityId === account.entityId)?.name ?? null;

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
          <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <span className="capitalize">
              {kind} · {account.subtype.replaceAll('_', ' ')}
            </span>
            {syncLabel ? <> · Updated {syncLabel}</> : null}
            {entityName ? (
              <>
                {' '}
                · {entityName}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Change entity"
                  title="Change entity"
                  className="size-5 text-muted-foreground/60 hover:text-foreground"
                  onClick={() => {
                    setReassigning(true);
                  }}
                >
                  <Pencil className="size-3" />
                </Button>
              </>
            ) : null}
          </p>
          {connection?.status === 'reauth_required' ? <ReauthLink className="mt-1.5" /> : null}
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
          {/* C9: shown ONLY when the institution reports a limit; neutral
              tokens — utilization is status, not negative money (Law 8). */}
          {utilization !== null && provider?.limitMinor ? (
            <p className="text-xs text-muted-foreground">
              {utilization}% of{' '}
              <Money
                amountMinor={provider.limitMinor}
                currency={account.currency}
                className="text-xs"
              />{' '}
              limit used
            </p>
          ) : null}
          <EarmarkLine
            goals={goals}
            accountId={accountId}
            balanceMinor={balanceMinor}
            currency={account.currency}
          />
          <div className="mt-1 flex flex-col items-start gap-0.5 sm:items-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => {
                setSettingBalance(true);
              }}
            >
              <Scale className="size-3.5" />
              Set opening balance
            </Button>
            {/* Fix balance / re-anchor: only meaningful once the bank has
                reported a balance (a synced, connected account). Re-reads
                provider truth and re-books the opening anchor so a balance that
                drifted high/low from a shallow or early-anchored sync ties back
                to the bank — audited + reversible, no relinking. */}
            {provider ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={fixingBalance}
                className="h-7 text-xs text-muted-foreground"
                onClick={() => {
                  if (!householdId || !userId) return;
                  setFixingBalance(true);
                  void reanchorAccountBalance({ householdId, userId, accountId })
                    .then(() => {
                      toast.success('Balance re-anchored to the bank.');
                      void balances.refetch();
                      void txns.refetch();
                    })
                    .catch((err: unknown) => {
                      toast.error(
                        err instanceof Error ? err.message : 'Could not re-anchor the balance.',
                      );
                    })
                    .finally(() => {
                      setFixingBalance(false);
                    });
                }}
              >
                {fixingBalance ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
                Fix balance
              </Button>
            ) : null}
          </div>
          <SetOpeningBalanceDialog
            open={settingBalance}
            householdId={householdId}
            userId={userId}
            accountId={accountId}
            accountName={account.name}
            accountKind={kind}
            currency={account.currency}
            onClose={() => {
              setSettingBalance(false);
            }}
            onSaved={() => {
              setSettingBalance(false);
              void balances.refetch();
              void txns.refetch();
            }}
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

      <ReassignEntityDialog
        open={reassigning}
        householdId={householdId}
        accountId={accountId}
        currentEntityId={account.entityId}
        onClose={() => {
          setReassigning(false);
        }}
        onReassigned={() => {
          setReassigning(false);
          setAccountReload((n) => n + 1);
          void balances.refetch();
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
