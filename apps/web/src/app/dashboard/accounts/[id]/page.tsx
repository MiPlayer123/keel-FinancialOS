'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Ellipsis,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  Scale,
  Wand2,
} from 'lucide-react';

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
import { resolveEditingAfterSave } from '@/lib/txn-edit-guard';
import { looksLikeInvestmentAccount } from '@/lib/investment-subtype';
import { ReauthLink } from '@/components/keel/reauth-link';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { RenameAccountDialog } from '@/components/keel/rename-account-dialog';
import { ReassignEntityDialog } from '@/components/keel/reassign-entity-dialog';
import { SetOpeningBalanceDialog } from '@/components/keel/set-opening-balance-dialog';
import { HoldingsCard } from '@/components/keel/holdings-card';
import {
  TxnDetailSheet,
  TxnList,
  type TxnEditFormHandle,
} from '@/components/keel/txn-edit-dialog';
import { BalanceTrendChart, CategoryBarList } from '@/components/keel/charts';
import { spendingMix } from '@/lib/spending';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const EMPTY_SELECTION = new Set<string>();
const BALANCE_RANGE_STORAGE_KEY = 'keel-account-balance-range';
const BALANCE_RANGE_OPTIONS = [
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'ytd', label: 'YTD' },
  { key: '1y', label: '1y' },
  { key: 'custom', label: 'Custom' },
] as const;

type BalanceRangeKey = (typeof BALANCE_RANGE_OPTIONS)[number]['key'];
type BalanceRangePreference = {
  key: BalanceRangeKey;
  customFrom: string;
  customTo: string;
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// keel_account_balance_daily rejects spans over 366 days (KEEL_INVALID_RANGE).
const MAX_BALANCE_RANGE_SPAN_DAYS = 366;

function shiftIsoDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

function isoDaySpan(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000
  );
}

function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && isoDay(parsed) === value;
}

function defaultBalanceRangePreference(now: Date): BalanceRangePreference {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 90);
  return { key: '90d', customFrom: isoDay(from), customTo: isoDay(now) };
}

function parseBalanceRangePreference(
  stored: string | null,
  now: Date,
): BalanceRangePreference {
  const fallback = defaultBalanceRangePreference(now);
  if (!stored) return fallback;
  try {
    const parsed = JSON.parse(stored) as Partial<BalanceRangePreference>;
    const key = BALANCE_RANGE_OPTIONS.some((option) => option.key === parsed.key)
      ? parsed.key
      : null;
    if (!key) return fallback;
    if (
      !isIsoDay(parsed.customFrom) ||
      !isIsoDay(parsed.customTo) ||
      parsed.customFrom > parsed.customTo ||
      parsed.customTo > isoDay(now)
    ) {
      return { ...fallback, key };
    }
    return { key, customFrom: parsed.customFrom, customTo: parsed.customTo };
  } catch {
    return fallback;
  }
}

function resolveBalanceRange(
  preference: BalanceRangePreference,
  now: Date,
): { from: string; to: string; label: string } {
  const to = isoDay(now);
  const from = new Date(now);
  switch (preference.key) {
    case '30d':
      from.setUTCDate(from.getUTCDate() - 30);
      return { from: isoDay(from), to, label: 'last 30 days' };
    case '90d':
      from.setUTCDate(from.getUTCDate() - 90);
      return { from: isoDay(from), to, label: 'last 90 days' };
    case 'ytd':
      return {
        from: isoDay(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))),
        to,
        label: 'year to date',
      };
    case '1y':
      from.setUTCFullYear(from.getUTCFullYear() - 1);
      return { from: isoDay(from), to, label: 'last year' };
    case 'custom':
      return { from: preference.customFrom, to: preference.customTo, label: 'custom range' };
  }
}

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  return <AccountDetailBody accountId={params.id} />;
}

function AccountDetailBody({ accountId }: { accountId: string }) {
  const { householdId, userId, ready } = useHousehold();
  const balances = useKeelQuery<TrialBalanceRow>('ledger.trial_balance', householdId);
  const txns = useKeelQuery<RichTransactionRow>('transactions.rich', householdId);
  const [balanceRangeAnchor] = useState(() => new Date());
  const [balanceRangePreference, setBalanceRangePreference] = useState(() =>
    defaultBalanceRangePreference(balanceRangeAnchor),
  );
  const [balanceRangeReady, setBalanceRangeReady] = useState(false);
  const balanceRange = useMemo(
    () => resolveBalanceRange(balanceRangePreference, balanceRangeAnchor),
    [balanceRangeAnchor, balanceRangePreference],
  );
  const trend = useKeelQuerySilent<DailyBalanceRow>('accounts.balance_daily', householdId, {
    accountId,
    from: balanceRange.from,
    to: balanceRange.to,
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
  // F-010: one full-height right-side detail sheet, same surface as the ledger
  // register (TxnDetailSheet). editorRef pre-flushes it when switching rows.
  const editorRef = useRef<TxnEditFormHandle>(null);
  const [renaming, setRenaming] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [accountReload, setAccountReload] = useState(0);
  const [settingBalance, setSettingBalance] = useState(false);
  const [fixingBalance, setFixingBalance] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setBalanceRangePreference(
      parseBalanceRangePreference(
        window.localStorage.getItem(BALANCE_RANGE_STORAGE_KEY),
        balanceRangeAnchor,
      ),
    );
    setBalanceRangeReady(true);
  }, [balanceRangeAnchor]);

  useEffect(() => {
    if (!balanceRangeReady) return;
    window.localStorage.setItem(
      BALANCE_RANGE_STORAGE_KEY,
      JSON.stringify(balanceRangePreference),
    );
  }, [balanceRangePreference, balanceRangeReady]);

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

  // While a connection is mid-sync, isSyncing is a snapshot from the fetch
  // above — nothing else refreshes it, so a page left open past the
  // backend's completion (or the 15-minute staleness cutoff) would keep
  // "Fix balance" disabled indefinitely. Poll only while genuinely syncing;
  // stops itself once fetchConnections reports isSyncing=false.
  const anyConnectionSyncing = useMemo(() => connections.some((c) => c.isSyncing), [connections]);
  useEffect(() => {
    if (!householdId || !anyConnectionSyncing) return;
    const interval = setInterval(() => {
      void fetchConnections(householdId)
        .then((c) => {
          setConnections(c);
        })
        .catch(() => {});
    }, 60_000);
    return () => {
      clearInterval(interval);
    };
  }, [householdId, anyConnectionSyncing]);

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
  // Re-anchoring against a mid-backfill account computes against a moving
  // target (production incident, 2026-07-18) — the backend now rejects this
  // outright, but surface it here too so the button doesn't invite the click.
  const isSyncing = connection?.isSyncing ?? false;
  // C9: utilization only when the provider reports a limit; currentMinor is
  // the positive owed magnitude, so the % is scaled-integer BigInt math.
  const utilization =
    kind === 'liability' && provider
      ? utilizationPercent(provider.currentMinor, provider.limitMinor ?? null)
      : null;
  const entityName = entities.find((e) => e.entityId === account.entityId)?.name ?? null;

  // F-010: one full-height right-side detail sheet (TxnDetailSheet). Flush the
  // outgoing row before switching to another so no pending write is stranded.
  function selectForEdit(next: RichTransactionRow) {
    if (editing && editing.transactionId !== next.transactionId) {
      editorRef.current?.requestClose();
    }
    setEditing(next);
  }
  const closeEditing = () => {
    setEditing(null);
  };
  const savedEditing = (txnId: string) => {
    setEditing((cur) => resolveEditingAfterSave(cur, txnId));
    void txns.refetch();
    void balances.refetch();
  };
  const tagsMutatedEditing = () => {
    void txns.refetch();
    if (householdId) {
      void fetchTags(householdId)
        .then(setTags)
        .catch(() => undefined);
    }
  };
  const recategorizeEditing = (txnId: string, categoryId: string) => {
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
  };
  const merchantSearchEditing = (description: string) => {
    router.push(`/dashboard/ledger?q=${encodeURIComponent(description)}`);
  };

  return (
    <div className="space-y-6 p-6">
      <BackLink />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <button
              type="button"
              aria-label={`Rename ${account.name}`}
              title="Rename account"
              className="max-w-full rounded-sm text-left break-words hover:underline hover:decoration-muted-foreground/50 hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => {
                setRenaming(true);
              }}
            >
              {account.name}
            </button>
          </h1>
          <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <span className="capitalize">
              {kind} · {account.subtype.replaceAll('_', ' ')}
            </span>
            {entityName ? <> · {entityName}</> : null}
          </p>
          {connection?.status === 'reauth_required' ? <ReauthLink className="mt-1.5" /> : null}
        </div>
        <div className="flex items-start justify-between gap-2 sm:justify-end">
          <div className="text-left sm:text-right">
            <p className="text-sm text-muted-foreground">Balance</p>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 sm:justify-end">
              <Money
                amountMinor={balanceMinor}
                currency={account.currency}
                className="text-2xl font-semibold"
                muteZero={false}
              />
              {isSyncing ? (
                <span className="text-xs text-muted-foreground">Syncing…</span>
              ) : syncLabel ? (
                <span className="text-xs text-muted-foreground">Updated {syncLabel}</span>
              ) : null}
            </div>
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
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Account actions"
                  title="Account actions"
                >
                  <Ellipsis />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => {
                    setRenaming(true);
                  }}
                >
                  <Pencil />
                  Rename account
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setReassigning(true);
                  }}
                >
                  <Building2 />
                  Reassign entity
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => {
                    setSettingBalance(true);
                  }}
                >
                  <Scale />
                  Set opening balance
                </DropdownMenuItem>
                {/* Fix balance / re-anchor: only meaningful once the bank has
                    reported a balance. The sync guard is a deliberate data-
                    integrity boundary and must remain visible and disabled. */}
                {provider ? (
                  <DropdownMenuItem
                    disabled={fixingBalance || isSyncing}
                    title={
                      isSyncing
                        ? 'Still syncing — the balance will settle once the initial sync finishes'
                        : undefined
                    }
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
                            err instanceof Error
                              ? err.message
                              : 'Could not re-anchor the balance.',
                          );
                        })
                        .finally(() => {
                          setFixingBalance(false);
                        });
                    }}
                  >
                    {fixingBalance || isSyncing ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Wand2 />
                    )}
                    {isSyncing ? 'Syncing…' : 'Fix balance'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className={spending.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader className="gap-3 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Balance · {balanceRange.label}
              </CardTitle>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Balance chart range">
                {BALANCE_RANGE_OPTIONS.map((option) => (
                  <Button
                    key={option.key}
                    type="button"
                    variant={balanceRangePreference.key === option.key ? 'secondary' : 'ghost'}
                    size="xs"
                    aria-pressed={balanceRangePreference.key === option.key}
                    onClick={() => {
                      setBalanceRangePreference((current) => ({
                        ...current,
                        key: option.key,
                      }));
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            {balanceRangePreference.key === 'custom' ? (
              <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  From
                  <Input
                    type="date"
                    value={balanceRangePreference.customFrom}
                    max={balanceRangePreference.customTo}
                    onChange={(event) => {
                      const nextFrom = event.target.value;
                      if (!isIsoDay(nextFrom)) return;
                      setBalanceRangePreference((current) => {
                        const nextTo = nextFrom > current.customTo ? nextFrom : current.customTo;
                        return {
                          key: 'custom',
                          customFrom: nextFrom,
                          customTo:
                            isoDaySpan(nextFrom, nextTo) > MAX_BALANCE_RANGE_SPAN_DAYS
                              ? shiftIsoDay(nextFrom, MAX_BALANCE_RANGE_SPAN_DAYS)
                              : nextTo,
                        };
                      });
                    }}
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  To
                  <Input
                    type="date"
                    value={balanceRangePreference.customTo}
                    min={balanceRangePreference.customFrom}
                    max={isoDay(balanceRangeAnchor)}
                    onChange={(event) => {
                      const nextTo = event.target.value;
                      if (!isIsoDay(nextTo) || nextTo > isoDay(balanceRangeAnchor)) return;
                      setBalanceRangePreference((current) => {
                        const nextFrom =
                          nextTo < current.customFrom ? nextTo : current.customFrom;
                        return {
                          key: 'custom',
                          customFrom:
                            isoDaySpan(nextFrom, nextTo) > MAX_BALANCE_RANGE_SPAN_DAYS
                              ? shiftIsoDay(nextTo, -MAX_BALANCE_RANGE_SPAN_DAYS)
                              : nextFrom,
                          customTo: nextTo,
                        };
                      });
                    }}
                  />
                </label>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            {trend === null ? (
              <Skeleton className="h-64 w-full" />
            ) : trend.length > 1 ? (
              <BalanceTrendChart points={trend} />
            ) : (
              <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                Not enough balance history for this range.
              </div>
            )}
          </CardContent>
        </Card>
        {spending.length > 0 ? (
          <Card>
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

      {looksLikeInvestmentAccount(account.subtype) ? (
        <HoldingsCard householdId={householdId} accountId={accountId} currency={account.currency} />
      ) : null}

      <div>
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
                onEdit={selectForEdit}
                onRecategorize={recategorizeEditing}
              />
            )}
          </section>
        </div>

        {/* F-010: single full-height right-side detail sheet for every width. */}
        <TxnDetailSheet
          row={editing}
          householdId={householdId}
          userId={userId}
          accounts={accounts}
          categories={categories}
          allRows={txns.rows}
          allTags={tags}
          formRef={editorRef}
          onTagsMutated={tagsMutatedEditing}
          onClose={closeEditing}
          onSaved={savedEditing}
          onRecategorize={recategorizeEditing}
          onMerchantSearch={merchantSearchEditing}
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
