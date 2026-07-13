'use client';

import { useEffect, useMemo, useState } from 'react';
import { ReceiptText, ChevronRight, Search } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchCategories,
  categorizeTransaction,
  type RichTransactionRow,
  type CategoryRow,
} from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function LedgerPage() {
  return (
    <AppShell>
      <PageHeader title="Ledger" description="Every transaction, categorized." />
      <div className="p-6">
        <LedgerTable />
      </div>
    </AppShell>
  );
}

type Grouping = 'none' | 'account' | 'category';

function LedgerTable() {
  const { householdId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RichTransactionRow>(
    'transactions.rich',
    householdId,
  );
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('none');

  useEffect(() => {
    if (!householdId) return;
    void fetchCategories(householdId)
      .then(setCategories)
      .catch(() => {
        setCategories([]);
      });
  }, [householdId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (t) =>
        t.description.toLowerCase().includes(q) ||
        t.accountName.toLowerCase().includes(q) ||
        (t.categoryName ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  async function recategorize(txnId: string, categoryLedgerAccountId: string) {
    if (!householdId) return;
    try {
      await categorizeTransaction({ householdId, transactionId: txnId, categoryLedgerAccountId });
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update category.');
    }
  }

  if (!ready || loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<ReceiptText className="size-6" />}
        title="Couldn't load transactions"
        description={error}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<ReceiptText className="size-6" />}
        title="No transactions yet"
        description="Connect a bank on the Connections page and posted transactions will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Search transactions"
            className="pl-8"
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Group by</span>
          <Select
            value={grouping}
            onValueChange={(v) => {
              setGrouping(v as Grouping);
            }}
          >
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="account">Account</SelectItem>
              <SelectItem value="category">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {grouping === 'none' ? (
        <TxnList rows={filtered} categories={categories} onRecategorize={(id, cat) => {
          void recategorize(id, cat);
        }} />
      ) : (
        <GroupedList
          rows={filtered}
          categories={categories}
          groupBy={grouping}
          onRecategorize={(id, cat) => {
          void recategorize(id, cat);
        }}
        />
      )}
    </div>
  );
}

function groupRows(rows: RichTransactionRow[], by: Grouping): Map<string, RichTransactionRow[]> {
  const map = new Map<string, RichTransactionRow[]>();
  for (const t of rows) {
    const key = by === 'account' ? t.accountName : (t.categoryName ?? 'Uncategorized');
    const bucket = map.get(key) ?? [];
    bucket.push(t);
    map.set(key, bucket);
  }
  return map;
}

function sumMinor(rows: RichTransactionRow[]): string {
  return rows.reduce((acc, r) => acc + BigInt(r.amountMinor || '0'), 0n).toString();
}

function GroupedList({
  rows,
  categories,
  groupBy,
  onRecategorize,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  groupBy: Grouping;
  onRecategorize: (txnId: string, categoryId: string) => void;
}) {
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-2">
      {[...groups.entries()].map(([name, groupRowsList]) => {
        const isOpen = !collapsed[name];
        return (
          <div key={name} className="overflow-hidden rounded-lg border border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-secondary/40"
              onClick={() => {
                setCollapsed((p) => ({ ...p, [name]: isOpen }));
              }}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <ChevronRight
                  className={`size-4 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
                {name}
                <span className="text-xs text-muted-foreground">({groupRowsList.length})</span>
              </span>
              <Money amountMinor={sumMinor(groupRowsList)} signed className="text-sm tabular-nums" />
            </button>
            {isOpen ? (
              <TxnList
                rows={groupRowsList}
                categories={categories}
                onRecategorize={onRecategorize}
                bordered
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TxnList({
  rows,
  categories,
  onRecategorize,
  bordered,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  onRecategorize: (txnId: string, categoryId: string) => void;
  bordered?: boolean;
}) {
  return (
    <div
      className={
        bordered
          ? 'border-t border-border'
          : 'overflow-hidden rounded-lg border border-border'
      }
    >
      {rows.map((t, i) => (
        <div
          key={t.transactionId}
          className={`flex items-center gap-3 px-4 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
        >
          <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
            {t.effectiveDate.slice(5)}
          </span>
          {/* min-w-0 + truncate: the description can never push into the
              category picker or the amount, no matter how long the memo is. */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={t.description}>
              {t.description}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t.accountName}
              {/* The picker is hidden below sm — keep the category visible. */}
              {t.categoryName ? (
                <span className="sm:hidden"> · {t.categoryName}</span>
              ) : null}
            </p>
          </div>
          <CategoryPicker
            row={t}
            categories={categories}
            onPick={(catId) => {
              onRecategorize(t.transactionId, catId);
            }}
          />
          <div className="flex shrink-0 items-center justify-end gap-2">
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
  );
}

function CategoryPicker({
  row,
  categories,
  onPick,
}: {
  row: RichTransactionRow;
  categories: CategoryRow[];
  onPick: (categoryLedgerAccountId: string) => void;
}) {
  // Only offer categories matching the transaction's direction (income/expense).
  const options = useMemo(
    () => categories.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true)),
    [categories, row.categoryKind],
  );
  const label = row.categoryName ?? 'Uncategorized';
  const isDefault = label.startsWith('Uncategorized');

  if (options.length === 0) {
    return (
      <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
        {label}
      </Badge>
    );
  }

  return (
    <Select
      value={row.categoryLedgerAccountId ?? undefined}
      onValueChange={(v) => {
        if (v) onPick(v);
      }}
    >
      <SelectTrigger
        className={`hidden h-7 w-40 shrink-0 border-dashed sm:flex ${
          isDefault ? 'text-muted-foreground' : ''
        }`}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((c) => (
          <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
