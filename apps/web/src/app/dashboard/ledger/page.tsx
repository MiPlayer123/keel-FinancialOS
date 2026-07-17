'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ReceiptText,
  ChevronRight,
  Search,
  ListChecks,
  Check,
  X,
  Loader2,
  Plus,
  Tags as TagsIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { useKeelQuery } from '@/lib/use-keel-query';
import {
  fetchAccounts,
  fetchCategories,
  fetchTags,
  categorizeTransaction,
  type AccountRow,
  type RichTransactionRow,
  type CategoryRow,
  type TagRow,
} from '@/lib/keel-api';
import { merchantDisplayName } from '@/lib/merchant-name';
import { AddTransactionDialog } from '@/components/keel/add-transaction-dialog';
import { ImportCsvDialog } from '@/components/keel/import-csv-dialog';
import { ManageTagsDialog } from '@/components/keel/manage-tags-dialog';
import { TxnEditDialog, TxnList, isUncategorized, type ListCallbacks } from '@/components/keel/txn-edit-dialog';
import { Money } from '@/components/keel/money';
import { Button } from '@/components/ui/button';
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
    <>
      <PageHeader title="Ledger" description="Every transaction, categorized." />
      <div className="p-6">
        {/* Suspense: useSearchParams in LedgerTable needs a boundary for the
            static prerender. */}
        <Suspense
          fallback={
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          }
        >
          <LedgerTable />
        </Suspense>
      </div>
    </>
  );
}

type Grouping = 'none' | 'date' | 'account' | 'category';
type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
type DatePreset = 'this_month' | 'last_month' | '30d' | '90d' | 'ytd' | 'all';

const PAGE_SIZE = 120;

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


function LedgerTable() {
  const { householdId, userId, ready } = useHousehold();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { rows, loading, error, refetch } = useKeelQuery<RichTransactionRow>(
    'transactions.rich',
    householdId,
  );
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('none');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  // Exact [from, to] day bounds seeded ONLY from the URL (Reports drill-through
  // — a chart's register link must reproduce the days it summed, Law 9). Shown
  // as a visible "from – to" entry in the date select; picking any preset
  // clears it. No new filter logic: it just sources the same bounds the
  // presets feed into `filtered`.
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const [accountFilter, setAccountFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('date_desc');

  // Deep links (Reports drill-down, ⌘K actions):
  // /dashboard/ledger?category=<id|uncategorized>&account=<id>&date=<preset>
  // &from=YYYY-MM-DD&to=YYYY-MM-DD and ?add=1 — each seeds the existing filter
  // state. Keyed on the live search params so ledger→ledger navigations (same
  // segment, no remount) still apply; ?add=1 is stripped after opening so
  // refresh/back doesn't reopen the dialog and a repeat ⌘K action re-fires.
  useEffect(() => {
    const category = searchParams.get('category');
    if (category) setCategoryFilter(category);
    const account = searchParams.get('account');
    if (account) setAccountFilter(account);
    const date = searchParams.get('date');
    const presetHit = date ? DATE_PRESETS.find((p) => p.key === date) : undefined;
    if (presetHit) {
      setDatePreset(presetHit.key);
      setCustomRange(null);
    }
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!presetHit && from && to && isoRe.test(from) && isoRe.test(to) && from <= to) {
      setCustomRange({ from, to });
    }
    const q = searchParams.get('q');
    if (q) setQuery(q);
    if (searchParams.get('add') === '1') {
      setAdding(true);
      router.replace('/dashboard/ledger', { scroll: false });
    }
  }, [searchParams, router]);
  const [editing, setEditing] = useState<RichTransactionRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [managingTags, setManagingTags] = useState(false);
  // Render cap (quality bar: interactions <100ms without virtualization).
  // Totals always compute over the FULL filtered set.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, datePreset, customRange, accountFilter, categoryFilter, tagFilter, sort, grouping]);
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
    void fetchTags(householdId)
      .then(setTags)
      .catch(() => {
        setTags([]);
      });
  }, [householdId]);

  // Search must keep matching the RAW description (never narrow search),
  // but "blue bottle" should also find "SQ *BLUE BOTTLE COFF…" — so the
  // cleaned display name matches too. Precomputed once per data load so
  // per-keystroke filtering stays cheap.
  const cleanedById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of rows) m.set(t.transactionId, merchantDisplayName(t.description).toLowerCase());
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const [from, to] = customRange
      ? ([customRange.from, customRange.to] as const)
      : presetRange(datePreset);
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
      if (tagFilter !== 'all' && !(t.tags ?? []).some((x) => x.tagId === tagFilter)) {
        return false;
      }
      if (
        q &&
        !t.description.toLowerCase().includes(q) &&
        !(t.originalDescription ?? '').toLowerCase().includes(q) &&
        !(cleanedById.get(t.transactionId) ?? '').includes(q) &&
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
  }, [rows, cleanedById, query, datePreset, customRange, accountFilter, categoryFilter, tagFilter, sort]);

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
          history={rows}
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
          value={customRange ? 'custom' : datePreset}
          items={{
            ...(customRange ? { custom: `${customRange.from} – ${customRange.to}` } : {}),
            ...Object.fromEntries(DATE_PRESETS.map((p) => [p.key, p.label])),
          }}
          onValueChange={(v) => {
            const hit = DATE_PRESETS.find((p) => p.key === v);
            if (!hit) return; // 'custom' is URL-seeded only, never re-selectable
            setCustomRange(null);
            setDatePreset(hit.key);
          }}
        >
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {customRange ? (
              <SelectItem value="custom">
                {customRange.from} – {customRange.to}
              </SelectItem>
            ) : null}
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
        {tags.length > 0 ? (
          <Select
            value={tagFilter}
            items={{
              all: 'All tags',
              ...Object.fromEntries(tags.map((t) => [t.tagId, `#${t.name}`])),
            }}
            onValueChange={(v) => {
              if (v) setTagFilter(v);
            }}
          >
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t.tagId} value={t.tagId}>
                  #{t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {tags.length > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-9 w-9"
            aria-label="Manage tags"
            title="Manage tags"
            onClick={() => {
              setManagingTags(true);
            }}
          >
            <TagsIcon className="size-4" />
          </Button>
        ) : null}
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
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => {
            setImporting(true);
          }}
        >
          Import
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
        <>
          <TxnList
            rows={filtered.slice(0, visibleCount)}
            categories={categories}
            onRecategorize={(id, cat) => {
              void recategorize(id, cat);
            }}
            onEdit={setEditing}
            selecting={selecting}
            selected={selected}
            onToggle={toggleSelected}
          />
          {filtered.length > visibleCount ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setVisibleCount((c) => c + PAGE_SIZE);
                }}
              >
                Show {String(Math.min(PAGE_SIZE, filtered.length - visibleCount))} more of{' '}
                {String(filtered.length - visibleCount)}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <GroupedList
          rows={filtered}
          categories={categories}
          groupBy={grouping}
          onRecategorize={(id, cat) => {
            void recategorize(id, cat);
          }}
          onEdit={(row) => {
            // Category grouping fans split rows with per-share amounts; the
            // edit dialog must always show the REAL transaction.
            setEditing(rows.find((r) => r.transactionId === row.transactionId) ?? row);
          }}
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

      <ManageTagsDialog
        open={managingTags}
        householdId={householdId}
        tags={tags}
        onClose={() => {
          setManagingTags(false);
        }}
        onMutated={() => {
          void refetch();
          if (householdId) {
            void fetchTags(householdId)
              .then((next) => {
                setTags(next);
                // A deleted tag can't stay selected as the filter.
                if (tagFilter !== 'all' && !next.some((t) => t.tagId === tagFilter)) {
                  setTagFilter('all');
                }
              })
              .catch(() => undefined);
          }
        }}
      />

      <TxnEditDialog
        row={editing}
        householdId={householdId}
        userId={userId}
        categories={categories}
        allTags={tags}
        onTagsMutated={() => {
          void refetch();
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
          void refetch();
        }}
        onRecategorize={(id, cat) => {
          void recategorize(id, cat);
        }}
        onMerchantSearch={(description) => {
          setQuery(description);
          setDatePreset('all');
          setCustomRange(null);
          setAccountFilter('all');
          setCategoryFilter('all');
          setTagFilter('all');
        }}
      />

      <AddTransactionDialog
        open={adding}
        householdId={householdId}
        userId={userId}
        accounts={accounts}
        categories={categories}
        history={rows}
        onClose={() => {
          setAdding(false);
        }}
        onSaved={() => {
          setAdding(false);
          void refetch();
        }}
      />

      <ImportCsvDialog
        open={importing}
        householdId={householdId}
        userId={userId}
        accounts={accounts}
        categories={categories}
        onClose={() => {
          setImporting(false);
        }}
        onDone={() => {
          setImporting(false);
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
              <span className={c.parentLedgerAccountId ? 'pl-3' : ''}>
                {c.name}
                {c.kind === 'income' ? ' (income)' : ''}
              </span>
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


