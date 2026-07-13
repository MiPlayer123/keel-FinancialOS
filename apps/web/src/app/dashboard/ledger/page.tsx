'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ReceiptText,
  ChevronRight,
  Search,
  StickyNote,
  ArrowLeftRight,
  ListChecks,
  Check,
  X,
  Loader2,
  Plus,
  Split,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCategories,
  categorizeTransaction,
  overrideTransaction,
  voidManualTransaction,
  type AccountRow,
  type RichTransactionRow,
  type CategoryRow,
} from '@/lib/keel-api';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { Money } from '@/components/keel/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
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

type Grouping = 'none' | 'date' | 'account' | 'category';
type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
type DatePreset = 'this_month' | 'last_month' | '30d' | '90d' | 'ytd' | 'all';

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'all', label: 'All time' },
];

/** [fromIso, toIso] bounds for a preset; null bound = unbounded. */
function presetRange(preset: DatePreset): [string | null, string | null] {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  switch (preset) {
    case 'this_month':
      return [iso(startOfMonth), null];
    case 'last_month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      return [iso(start), iso(end)];
    }
    case '30d': {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 30);
      return [iso(d), null];
    }
    case '90d': {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 90);
      return [iso(d), null];
    }
    case 'ytd':
      return [`${String(now.getUTCFullYear())}-01-01`, null];
    case 'all':
      return [null, null];
  }
}

/**
 * Rename-proof "is it still on a landing pad?" check: the stable pfc_key when
 * the migration has landed, the seeded name as a fallback until then. Split
 * transactions are categorized by their splits — never "uncategorized".
 */
/** Amount search: "12.34" or "1234" matches ±1234 minor units (string ops only). */
function amountMatches(amountMinor: string, q: string): boolean {
  if (!/^\d+(\.\d{1,2})?$/.test(q)) return false;
  const abs = amountMinor.startsWith('-') ? amountMinor.slice(1) : amountMinor;
  const dollars = abs.length > 2 ? abs.slice(0, -2) : '0';
  const cents = abs.padStart(3, '0').slice(-2);
  if (q.includes('.')) {
    const [qd = '', qc = ''] = q.split('.');
    return dollars === String(Number(qd)) && cents.startsWith(qc);
  }
  return dollars === q || abs === q;
}

function isUncategorized(t: RichTransactionRow): boolean {
  if (t.splits && t.splits.length > 0) return false;
  if (t.categoryPfcKey != null) return t.categoryPfcKey.startsWith('uncategorized');
  return t.categoryName ? t.categoryName.startsWith('Uncategorized') : true;
}

function LedgerTable() {
  const { householdId, userId, ready } = useHousehold();
  const { rows, loading, error, refetch } = useKeelQuery<RichTransactionRow>(
    'transactions.rich',
    householdId,
  );
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('date_desc');

  // Deep links (e.g. from Reports): /dashboard/ledger?category=<id|uncategorized>.
  // Applied post-mount to avoid a server/client hydration mismatch.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get('category');
    if (param) setCategoryFilter(param);
  }, []);
  const [editing, setEditing] = useState<RichTransactionRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (!householdId) return;
    void fetchCategories(householdId)
      .then(setCategories)
      .catch(() => {
        setCategories([]);
      });
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
  }, [householdId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const [from, to] = presetRange(datePreset);
    const out = rows.filter((t) => {
      if (from && t.effectiveDate < from) return false;
      if (to && t.effectiveDate > to) return false;
      if (accountFilter !== 'all' && t.accountId !== accountFilter) return false;
      if (categoryFilter === 'uncategorized') {
        if (!isUncategorized(t)) return false;
      } else if (categoryFilter === 'transfers') {
        if (t.transferStatus !== 'confirmed') return false;
      } else if (
        categoryFilter !== 'all' &&
        t.categoryLedgerAccountId !== categoryFilter &&
        !(t.splits ?? []).some((s) => s.categoryLedgerAccountId === categoryFilter)
      ) {
        return false;
      }
      if (
        q &&
        !t.description.toLowerCase().includes(q) &&
        !t.accountName.toLowerCase().includes(q) &&
        !(t.categoryName ?? '').toLowerCase().includes(q) &&
        // "12.34" or "1234" finds the amount, sign-agnostic.
        !amountMatches(t.amountMinor, q)
      ) {
        return false;
      }
      return true;
    });
    const byAmount = (a: RichTransactionRow, b: RichTransactionRow) => {
      const av = BigInt(a.amountMinor || '0');
      const bv = BigInt(b.amountMinor || '0');
      return av < bv ? -1 : av > bv ? 1 : 0;
    };
    out.sort((a, b) => {
      switch (sort) {
        case 'date_desc':
          return b.effectiveDate.localeCompare(a.effectiveDate) || a.transactionId.localeCompare(b.transactionId);
        case 'date_asc':
          return a.effectiveDate.localeCompare(b.effectiveDate) || a.transactionId.localeCompare(b.transactionId);
        case 'amount_desc':
          return byAmount(b, a);
        case 'amount_asc':
          return byAmount(a, b);
      }
    });
    return out;
  }, [rows, query, datePreset, accountFilter, categoryFilter, sort]);

  const totals = useMemo(() => {
    let inflow = 0n;
    let outflow = 0n;
    for (const t of filtered) {
      const v = BigInt(t.amountMinor || '0');
      if (v > 0n) inflow += v;
      else outflow += v;
    }
    return { inflow: inflow.toString(), outflow: outflow.toString(), count: filtered.length };
  }, [filtered]);

  async function recategorize(txnId: string, categoryLedgerAccountId: string) {
    if (!householdId) return;
    try {
      await categorizeTransaction({ householdId, transactionId: txnId, categoryLedgerAccountId });
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update category.');
    }
  }

  async function bulkCategorize(categoryLedgerAccountId: string) {
    if (!householdId || selected.size === 0) return;
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const txnId of selected) {
      try {
        await categorizeTransaction({ householdId, transactionId: txnId, categoryLedgerAccountId });
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    setSelecting(false);
    toast[failed > 0 ? 'error' : 'success'](
      failed > 0
        ? `Categorized ${String(ok)}, ${String(failed)} failed.`
        : `Categorized ${String(ok)} transaction${ok === 1 ? '' : 's'}.`,
    );
    await refetch();
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      <div className="space-y-4">
        <EmptyState
          icon={<ReceiptText className="size-6" />}
          title="No transactions yet"
          description="Connect a bank on the Connections page, or add one by hand — cash counts too."
        />
        <div className="flex justify-center">
          <Button
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" />
            Add transaction
          </Button>
        </div>
        <AddTransactionDialog
          open={adding}
          householdId={householdId}
          userId={userId}
          accounts={accounts}
          categories={categories}
          onClose={() => {
            setAdding(false);
          }}
          onSaved={() => {
            setAdding(false);
            void refetch();
          }}
        />
      </div>
    );
  }

  const expenseCategories = categories.filter((c) => c.kind === 'expense');
  const incomeCategories = categories.filter((c) => c.kind === 'income');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-56">
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
        <Select
          value={datePreset}
          items={Object.fromEntries(DATE_PRESETS.map((p) => [p.key, p.label]))}
          onValueChange={(v) => {
            if (v) setDatePreset(v);
          }}
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={accountFilter}
          items={{
            all: 'All accounts',
            ...Object.fromEntries(accounts.map((a) => [a.id, a.name])),
          }}
          onValueChange={(v) => {
            if (v) setAccountFilter(v);
          }}
        >
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          items={{
            all: 'All categories',
            uncategorized: 'Uncategorized',
            transfers: 'Transfers',
            ...Object.fromEntries(
              categories.map((c) => [
                c.ledgerAccountId,
                c.kind === 'income' ? `${c.name} (income)` : c.name,
              ]),
            ),
          }}
          onValueChange={(v) => {
            if (v) setCategoryFilter(v);
          }}
        >
          <SelectTrigger className="h-9 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            <SelectItem value="uncategorized">Uncategorized</SelectItem>
            <SelectItem value="transfers">Transfers</SelectItem>
            {expenseCategories.map((c) => (
              <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                {c.name}
              </SelectItem>
            ))}
            {incomeCategories.map((c) => (
              <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                {c.name} (income)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          items={{
            date_desc: 'Newest first',
            date_asc: 'Oldest first',
            amount_desc: 'Largest amount',
            amount_asc: 'Smallest amount',
          }}
          onValueChange={(v) => {
            if (v) setSort(v);
          }}
        >
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_desc">Newest first</SelectItem>
            <SelectItem value="date_asc">Oldest first</SelectItem>
            <SelectItem value="amount_desc">Largest amount</SelectItem>
            <SelectItem value="amount_asc">Smallest amount</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Group by</span>
          <Select
            value={grouping}
            items={{ none: 'None', date: 'Date', account: 'Account', category: 'Category' }}
            onValueChange={(v) => {
              if (v) setGrouping(v);
            }}
          >
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="account">Account</SelectItem>
              <SelectItem value="category">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant={selecting ? 'secondary' : 'outline'}
          size="sm"
          className="h-9"
          onClick={() => {
            setSelecting((s) => !s);
            setSelected(new Set());
          }}
        >
          <ListChecks className="size-4" />
          {selecting ? 'Done' : 'Select'}
        </Button>
        <Button
          size="sm"
          className="h-9"
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      {selecting ? (
        <BulkBar
          count={selected.size}
          categories={categories}
          busy={bulkBusy}
          onApply={(catId) => {
            void bulkCategorize(catId);
          }}
          onClear={() => {
            setSelected(new Set());
          }}
        />
      ) : null}

      {grouping === 'none' ? (
        <TxnList
          rows={filtered}
          categories={categories}
          onRecategorize={(id, cat) => {
            void recategorize(id, cat);
          }}
          onEdit={setEditing}
          selecting={selecting}
          selected={selected}
          onToggle={toggleSelected}
        />
      ) : (
        <GroupedList
          rows={filtered}
          categories={categories}
          groupBy={grouping}
          onRecategorize={(id, cat) => {
            void recategorize(id, cat);
          }}
          onEdit={setEditing}
          selecting={selecting}
          selected={selected}
          onToggle={toggleSelected}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
        <span className="text-muted-foreground">
          {String(totals.count)} transaction{totals.count === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-4">
          <span className="text-muted-foreground">
            In <Money amountMinor={totals.inflow} className="text-foreground" />
          </span>
          <span className="text-muted-foreground">
            Out <Money amountMinor={totals.outflow} />
          </span>
        </span>
      </div>

      <TxnEditDialog
        row={editing}
        householdId={householdId}
        userId={userId}
        categories={categories}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={() => {
          setEditing(null);
          void refetch();
        }}
        onRecategorize={(id, cat) => {
          void recategorize(id, cat);
        }}
      />

      <AddTransactionDialog
        open={adding}
        householdId={householdId}
        userId={userId}
        accounts={accounts}
        categories={categories}
        onClose={() => {
          setAdding(false);
        }}
        onSaved={() => {
          setAdding(false);
          void refetch();
        }}
      />
    </div>
  );
}

function BulkBar({
  count,
  categories,
  busy,
  onApply,
  onClear,
}: {
  count: number;
  categories: CategoryRow[];
  busy: boolean;
  onApply: (categoryLedgerAccountId: string) => void;
  onClear: () => void;
}) {
  const [catId, setCatId] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-2.5">
      <span className="text-sm font-medium">
        {String(count)} selected
      </span>
      <Select
        value={catId ?? undefined}
        items={Object.fromEntries(
          categories.map((c) => [
            c.ledgerAccountId,
            c.kind === 'income' ? `${c.name} (income)` : c.name,
          ]),
        )}
        onValueChange={(v) => {
          setCatId(v);
        }}
      >
        <SelectTrigger className="h-8 w-48">
          <SelectValue placeholder="Set category to…" />
        </SelectTrigger>
        <SelectContent>
          {categories.map((c) => (
            <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
              {c.name}
              {c.kind === 'income' ? ' (income)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={busy || count === 0 || !catId}
        onClick={() => {
          if (catId) onApply(catId);
        }}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        Apply
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || count === 0} onClick={onClear}>
        <X className="size-4" />
        Clear
      </Button>
      <span className="text-xs text-muted-foreground">
        The category must match each transaction&apos;s direction; mismatches are skipped.
      </span>
    </div>
  );
}

/** Friendly date header: Today / Yesterday / "Jul 10" / "Jul 10, 2025". */
function dateLabel(iso: string): string {
  const todayIso = new Date().toISOString().slice(0, 10);
  if (iso === todayIso) return 'Today';
  const y = new Date();
  y.setUTCDate(y.getUTCDate() - 1);
  if (iso === y.toISOString().slice(0, 10)) return 'Yesterday';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [yy = '', mm = '', dd = ''] = iso.split('-');
  const label = `${months[Number(mm) - 1] ?? mm} ${String(Number(dd))}`;
  return yy === todayIso.slice(0, 4) ? label : `${label}, ${yy}`;
}

function groupRows(rows: RichTransactionRow[], by: Grouping): Map<string, RichTransactionRow[]> {
  const map = new Map<string, RichTransactionRow[]>();
  const push = (key: string, row: RichTransactionRow) => {
    const bucket = map.get(key) ?? [];
    bucket.push(row);
    map.set(key, bucket);
  };
  for (const t of rows) {
    if (by === 'category' && t.splits && t.splits.length > 0) {
      // Fan a split transaction across its categories, each share carrying
      // its own cash-signed amount so group totals stay exact (BigInt).
      for (const s of t.splits) {
        push(s.name, { ...t, amountMinor: (-BigInt(s.amountMinor)).toString() });
      }
      continue;
    }
    const key =
      by === 'account'
        ? t.accountName
        : by === 'date'
          ? dateLabel(t.effectiveDate)
          : (t.categoryName ?? 'Uncategorized');
    push(key, t);
  }
  return map;
}

function sumMinor(rows: RichTransactionRow[]): string {
  return rows.reduce((acc, r) => acc + BigInt(r.amountMinor || '0'), 0n).toString();
}

type ListCallbacks = {
  onRecategorize: (txnId: string, categoryId: string) => void;
  onEdit: (row: RichTransactionRow) => void;
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
};

function GroupedList({
  rows,
  categories,
  groupBy,
  ...cb
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  groupBy: Grouping;
} & ListCallbacks) {
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
              <TxnList rows={groupRowsList} categories={categories} bordered {...cb} />
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
  bordered,
  onRecategorize,
  onEdit,
  selecting,
  selected,
  onToggle,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  bordered?: boolean;
} & ListCallbacks) {
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
          {selecting ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected.has(t.transactionId)}
              aria-label="Select transaction"
              className={`flex size-5 shrink-0 items-center justify-center rounded border ${
                selected.has(t.transactionId)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border'
              }`}
              onClick={() => {
                onToggle(t.transactionId);
              }}
            >
              {selected.has(t.transactionId) ? <Check className="size-3.5" /> : null}
            </button>
          ) : null}
          <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
            {t.effectiveDate.slice(5)}
          </span>
          {/* min-w-0 + truncate: the description can never push into the
              category picker or the amount, no matter how long the memo is. */}
          <button
            type="button"
            className="min-w-0 flex-1 rounded-sm text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              if (selecting) onToggle(t.transactionId);
              else onEdit(t);
            }}
          >
            <p className="truncate text-sm font-medium" title={t.description}>
              {t.description}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t.accountName}
              {/* The picker is hidden below sm — keep the category visible. */}
              {t.categoryName ? (
                <span className="sm:hidden"> · {t.categoryName}</span>
              ) : null}
              {t.note ? (
                <span className="text-muted-foreground/80">
                  {' '}
                  <StickyNote className="inline size-3 align-[-1px]" aria-label="Note" />{' '}
                  {t.note.length > 40 ? `${t.note.slice(0, 40)}…` : t.note}
                </span>
              ) : null}
            </p>
          </button>
          {t.transferStatus === 'confirmed' ? (
            <Badge variant="secondary" className="hidden shrink-0 gap-1 sm:inline-flex">
              <ArrowLeftRight className="size-3" />
              Transfer
            </Badge>
          ) : t.splits && t.splits.length > 0 ? (
            <Badge
              variant="secondary"
              className="hidden shrink-0 gap-1 sm:inline-flex"
              title={t.splits.map((s) => s.name).join(' · ')}
            >
              <Split className="size-3" />
              Split · {t.splits.length}
            </Badge>
          ) : (
            <CategoryPicker
              row={t}
              categories={categories}
              onPick={(catId) => {
                onRecategorize(t.transactionId, catId);
              }}
            />
          )}
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
  const isDefault = isUncategorized(row);

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
      items={Object.fromEntries(options.map((c) => [c.ledgerAccountId, c.name]))}
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
            {c.parentLedgerAccountId ? <span className="pl-3">{c.name}</span> : c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Edit the user-facing name + note for a transaction. Presentation overlay
 * only: the provider's original description is immutable and stays visible.
 * Also hosts the category picker (on mobile it's the only recategorize path).
 */
function TxnEditDialog({
  row,
  householdId,
  userId,
  categories,
  onClose,
  onSaved,
  onRecategorize,
}: {
  row: RichTransactionRow | null;
  householdId: string | null;
  userId: string | null;
  categories: CategoryRow[];
  onClose: () => void;
  onSaved: () => void;
  onRecategorize: (txnId: string, categoryId: string) => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);

  useEffect(() => {
    if (!row) return;
    setName(row.description);
    setNote(row.note ?? '');
    setVoiding(false);
  }, [row]);

  async function voidTxn() {
    if (!row || !householdId || !userId) return;
    setSaving(true);
    try {
      await voidManualTransaction({
        householdId,
        userId,
        transactionId: row.transactionId,
        reason: 'Voided from ledger',
      });
      toast.success('Transaction voided — the reversal is on the books, nothing deleted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not void the transaction.');
    } finally {
      setSaving(false);
    }
  }

  const original = row?.originalDescription ?? row?.description ?? '';
  const categoryOptions = useMemo(
    () =>
      row
        ? categories.filter((c) => (row.categoryKind ? c.kind === row.categoryKind : true))
        : [],
    [categories, row],
  );

  async function save() {
    if (!row || !householdId) return;
    setSaving(true);
    try {
      await overrideTransaction({
        householdId,
        transactionId: row.transactionId,
        // Saving the unchanged original name means "no override".
        displayDescription: name.trim() === original ? '' : name,
        note,
      });
      toast.success('Transaction updated.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit transaction</DialogTitle>
          <DialogDescription>
            Rename it or add a note. The bank&apos;s original description is kept.
          </DialogDescription>
        </DialogHeader>
        {row ? (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground" title={original}>
                {original}
              </span>
              <Money amountMinor={row.amountMinor} currency={row.currency} signed />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="txn-name">Name</Label>
              <Input
                id="txn-name"
                value={name}
                maxLength={140}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
            {row.splits && row.splits.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Splits</Label>
                <div className="space-y-1 rounded-md border border-border px-3 py-2">
                  {row.splits.map((s) => (
                    <div
                      key={s.categoryLedgerAccountId}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate">{s.name}</span>
                      <Money
                        amountMinor={(-BigInt(s.amountMinor)).toString()}
                        currency={row.currency}
                        signed
                        className="shrink-0 text-sm"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Split transactions are categorized by their splits. To change them,
                  void and re-enter.
                </p>
              </div>
            ) : null}
            {row.transferStatus !== 'confirmed' &&
            !(row.splits && row.splits.length > 0) &&
            categoryOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={row.categoryLedgerAccountId ?? undefined}
                  items={Object.fromEntries(
                    categoryOptions.map((c) => [c.ledgerAccountId, c.name]),
                  )}
                  onValueChange={(v) => {
                    if (v) onRecategorize(row.transactionId, v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={row.categoryName ?? 'Uncategorized'} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((c) => (
                      <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="txn-note">Note</Label>
              <Textarea
                id="txn-note"
                value={note}
                maxLength={2000}
                rows={3}
                placeholder="Anything worth remembering about this transaction"
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {row?.source === 'manual' && !voiding ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={saving}
              onClick={() => {
                setVoiding(true);
              }}
            >
              <Trash2 className="size-4" />
              Void
            </Button>
          ) : row?.source === 'manual' ? (
            <Button
              variant="destructive"
              disabled={saving}
              onClick={() => {
                void voidTxn();
              }}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Confirm void
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void save();
              }}
              disabled={saving || name.trim().length === 0}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
