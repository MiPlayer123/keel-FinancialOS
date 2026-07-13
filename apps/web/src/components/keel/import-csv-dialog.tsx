'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
  createCategory,
  createManualTransaction,
  overrideTransaction,
  type AccountRow,
  type CategoryRow,
  type CommandResult,
} from '@/lib/keel-api';
import { sha256Hex } from '@/lib/hash';
import { parseCsv, parseCsvAmount, parseCsvDate, guessColumns } from '@/lib/csv';
import { looksLikeQif, parseQif, type QifSplit } from '@/lib/qif';
import { Money } from '@/components/keel/money';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ParsedRow = {
  date: string;
  amountMinor: string;
  description: string;
  key: string; // content-hash idempotency key (dedupes across re-imports)
  /** QIF extras — memo becomes the note, L/S lines map to categories by name. */
  memo?: string | null;
  categoryName?: string | null;
  splits?: QifSplit[];
};

type ImportAnalysis = {
  confidence: 'high' | 'review';
  dateRange: string | null;
  duplicates: number;
  outflows: number;
  inflows: number;
  matchedCategories: number;
  unmatchedCategories: number;
  validSplits: number;
  invalidSplits: number;
  missingCategories: { name: string; kind: 'expense' | 'income' }[];
  notes: string[];
};

function formatDateRange(rows: Omit<ParsedRow, 'key'>[]): string | null {
  if (rows.length === 0) return null;
  const dates = rows.map((r) => r.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) return null;
  return first === last ? first : `${first} → ${last}`;
}

/**
 * CSV + QIF import, Quicken-style but idempotent: every row rides the
 * transactions.manual_create envelope with a content-hash economic key, so
 * re-importing the same file REPLAYS instead of duplicating (invariant 3).
 * CSV rows land on the Uncategorized pads (rules file them within minutes);
 * QIF rows carry Quicken's own categories and splits, matched by name where
 * one exists. Source preserved: the file's description is the immutable
 * canonical description; QIF memos become notes.
 */
export function ImportCsvDialog({
  open,
  householdId,
  userId,
  accounts,
  categories,
  onClose,
  onDone,
}: {
  open: boolean;
  householdId: string | null;
  userId: string | null;
  accounts: AccountRow[];
  categories: CategoryRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dateCol, setDateCol] = useState<number | null>(null);
  const [amountCol, setAmountCol] = useState<number | null>(null);
  const [descCol, setDescCol] = useState<number | null>(null);
  const [flipSigns, setFlipSigns] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [createMissingCategories, setCreateMissingCategories] = useState(true);

  const [fileName, setFileName] = useState<string | null>(null);
  const isQif = useMemo(
    () => (text.trim() ? looksLikeQif(text, fileName ?? undefined) : false),
    [text, fileName],
  );
  const grid = useMemo(() => (text.trim() && !isQif ? parseCsv(text) : []), [text, isQif]);
  const header = grid[0] ?? [];
  const guessed = useMemo(() => guessColumns(header), [header]);
  const cDate = touched ? dateCol : (dateCol ?? guessed.date);
  const cAmount = touched ? amountCol : (amountCol ?? guessed.amount);
  const cDesc = touched ? descCol : (descCol ?? guessed.description);

  // Skip the header row when its date cell doesn't parse as a date.
  const dataRows = useMemo(() => {
    if (grid.length === 0 || cDate === null) return [];
    const first = grid[0]?.[cDate] ?? '';
    return parseCsvDate(first) === null ? grid.slice(1) : grid;
  }, [grid, cDate]);

  const parsed = useMemo(() => {
    if (isQif) {
      const q = parseQif(text);
      const rows: Omit<ParsedRow, 'key'>[] = q.rows.map((r) => {
        const flip = (m: string) => (m.startsWith('-') ? m.slice(1) : `-${m}`);
        return {
          date: r.date,
          amountMinor: flipSigns ? flip(r.amountMinor) : r.amountMinor,
          description: r.description.slice(0, 500),
          memo: r.memo,
          categoryName: r.categoryName,
          splits: flipSigns
            ? r.splits.map((sp) => ({ ...sp, amountMinor: flip(sp.amountMinor) }))
            : r.splits,
        };
      });
      return { rows, skipped: q.skipped, ignored: q.ignored, dayFirst: q.dayFirst };
    }
    if (cDate === null || cAmount === null || cDesc === null) {
      return { rows: [] as Omit<ParsedRow, 'key'>[], skipped: 0, ignored: 0, dayFirst: false };
    }
    const rows: Omit<ParsedRow, 'key'>[] = [];
    let skipped = 0;
    for (const r of dataRows) {
      const date = parseCsvDate(r[cDate] ?? '');
      let amountMinor = parseCsvAmount(r[cAmount] ?? '');
      const description = (r[cDesc] ?? '').trim().slice(0, 500);
      if (!date || amountMinor === null || amountMinor === '0' || description === '') {
        skipped++;
        continue;
      }
      if (flipSigns) {
        amountMinor = amountMinor.startsWith('-') ? amountMinor.slice(1) : `-${amountMinor}`;
      }
      rows.push({ date, amountMinor, description });
    }
    return { rows, skipped, ignored: 0, dayFirst: false };
  }, [isQif, text, dataRows, cDate, cAmount, cDesc, flipSigns]);

  const account = accounts.find((a) => a.id === accountId);

  const analysis = useMemo<ImportAnalysis>(() => {
    const notes: string[] = [];
    let duplicates = 0;
    let outflows = 0;
    let inflows = 0;
    let matchedCategories = 0;
    let unmatchedCategories = 0;
    let validSplits = 0;
    let invalidSplits = 0;
    const seen = new Map<string, number>();
    const missingByKey = new Map<string, { name: string; kind: 'expense' | 'income' }>();

    for (const row of parsed.rows) {
      const tuple = `${row.date}|${row.amountMinor}|${row.description.toLowerCase()}`;
      const count = seen.get(tuple) ?? 0;
      if (count > 0) duplicates++;
      seen.set(tuple, count + 1);
      const outflow = row.amountMinor.startsWith('-');
      if (outflow) outflows++;
      else inflows++;

      if (row.splits && row.splits.length > 1) {
        const sum = row.splits.reduce((a, sp) => a + BigInt(sp.amountMinor), 0n);
        if (sum === BigInt(row.amountMinor)) validSplits++;
        else invalidSplits++;
        for (const split of row.splits) {
          const splitOutflow = split.amountMinor.startsWith('-');
          if (categoryByName(split.categoryName, splitOutflow ? 'expense' : 'income')) {
            matchedCategories++;
          } else if (split.categoryName) {
            unmatchedCategories++;
            missingByKey.set(
              `${splitOutflow ? 'expense' : 'income'}:${split.categoryName.toLowerCase()}`,
              {
                name: split.categoryName,
                kind: splitOutflow ? 'expense' : 'income',
              },
            );
          }
        }
      } else if (row.categoryName) {
        if (categoryByName(row.categoryName, outflow ? 'expense' : 'income')) matchedCategories++;
        else {
          unmatchedCategories++;
          missingByKey.set(`${outflow ? 'expense' : 'income'}:${row.categoryName.toLowerCase()}`, {
            name: row.categoryName,
            kind: outflow ? 'expense' : 'income',
          });
        }
      }
    }

    if (parsed.skipped > 0) notes.push(`${String(parsed.skipped)} rows could not be parsed.`);
    if (duplicates > 0) notes.push(`${String(duplicates)} rows look duplicated inside this file.`);
    if (unmatchedCategories > 0) {
      notes.push(`${String(unmatchedCategories)} QIF categories will land as Uncategorized.`);
    }
    if (invalidSplits > 0) {
      notes.push(
        `${String(invalidSplits)} split transactions did not add up and will import as single-category rows.`,
      );
    }
    if (!isQif && parsed.rows.length > 0) {
      notes.push('CSV has no category/split metadata; rules can clean these after import.');
    }

    return {
      confidence:
        parsed.rows.length > 0 && parsed.skipped === 0 && duplicates === 0 && invalidSplits === 0
          ? 'high'
          : 'review',
      dateRange: formatDateRange(parsed.rows),
      duplicates,
      outflows,
      inflows,
      matchedCategories,
      unmatchedCategories,
      validSplits,
      invalidSplits,
      missingCategories: [...missingByKey.values()].slice(0, 25),
      notes,
    };
  }, [parsed, isQif, account?.entityId, categories]);

  function uncategorizedFor(sign: 'expense' | 'income'): CategoryRow | undefined {
    const wantKey = sign === 'expense' ? 'uncategorized_expense' : 'uncategorized_income';
    const wantName = sign === 'expense' ? 'Uncategorized Expense' : 'Uncategorized Income';
    return (
      categories.find((c) => c.entityId === account?.entityId && c.pfcKey === wantKey) ??
      categories.find((c) => c.entityId === account?.entityId && c.name === wantName)
    );
  }

  /** Quicken category names ("Auto:Fuel") matched to KEEL categories: full
   *  name first, then the leaf. Same entity + correct side only. */
  function categoryByName(name: string | null | undefined, sign: 'expense' | 'income') {
    if (!name) return undefined;
    const find = (n: string) =>
      categories.find(
        (c) =>
          c.entityId === account?.entityId &&
          c.kind === sign &&
          c.name.toLowerCase() === n.toLowerCase(),
      );
    const leaf = name.includes(':') ? name.split(':').at(-1) : null;
    return find(name) ?? (leaf ? find(leaf) : undefined);
  }

  const categoryByNameFrom = (
    available: CategoryRow[],
    name: string | null | undefined,
    sign: 'expense' | 'income',
  ) => {
    if (!name) return undefined;
    const find = (n: string) =>
      available.find(
        (c) =>
          c.entityId === account?.entityId &&
          c.kind === sign &&
          c.name.toLowerCase() === n.toLowerCase(),
      );
    const leaf = name.includes(':') ? name.split(':').at(-1) : null;
    return find(name) ?? (leaf ? find(leaf) : undefined);
  };

  async function categoriesForImport(): Promise<CategoryRow[]> {
    if (
      !householdId ||
      !account ||
      !createMissingCategories ||
      analysis.missingCategories.length === 0
    ) {
      return categories;
    }
    const next = [...categories];
    for (const missing of analysis.missingCategories) {
      const name = missing.name.includes(':')
        ? (missing.name.split(':').at(-1) ?? missing.name)
        : missing.name;
      const existing =
        categoryByNameFrom(next, name, missing.kind) ??
        categoryByNameFrom(next, missing.name, missing.kind);
      if (existing) continue;
      try {
        const created = await createCategory({
          householdId,
          entityId: account.entityId,
          name: name.slice(0, 80),
          kind: missing.kind,
        });
        if (created.ledgerAccountId) {
          next.push({
            ledgerAccountId: created.ledgerAccountId,
            name: name.slice(0, 80),
            kind: missing.kind,
            entityId: account.entityId,
          });
        }
      } catch {
        // Best effort only: if a category already exists via race/rename, the
        // transaction still imports safely to Uncategorized below.
      }
    }
    return next;
  }

  async function runImport() {
    if (!householdId || !userId || !account) return;
    const workingCategories = await categoriesForImport();
    const expenseCat = uncategorizedFor('expense');
    const incomeCat = uncategorizedFor('income');
    if (!expenseCat || !incomeCat) {
      toast.error('Could not find the Uncategorized categories for this account.');
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: parsed.rows.length });
    // Identical rows in ONE file are distinct purchases (two same-price
    // coffees); across files they replay. Hash carries an occurrence index.
    const seen = new Map<string, number>();
    let imported = 0;
    let replayed = 0;
    let failed = 0;
    for (const row of parsed.rows) {
      const tuple = `${account.id}|${row.date}|${row.amountMinor}|${row.description}`;
      const nth = seen.get(tuple) ?? 0;
      seen.set(tuple, nth + 1);
      try {
        const key = await sha256Hex(`import|${tuple}|${String(nth)}`);
        const outflow = row.amountMinor.startsWith('-');
        const fallback = outflow ? expenseCat : incomeCat;
        // QIF splits become REAL splits when they add up; each maps by name.
        let payloadSplits: { categoryLedgerAccountId: string; amountMinor: string }[] | null = null;
        if (row.splits && row.splits.length > 1) {
          const sum = row.splits.reduce((a, sp) => a + BigInt(sp.amountMinor), 0n);
          if (sum === BigInt(row.amountMinor)) {
            payloadSplits = row.splits.map((sp) => {
              const spOut = sp.amountMinor.startsWith('-');
              const cat =
                categoryByNameFrom(
                  workingCategories,
                  sp.categoryName,
                  spOut ? 'expense' : 'income',
                ) ?? (spOut ? expenseCat : incomeCat);
              return {
                categoryLedgerAccountId: cat.ledgerAccountId,
                amountMinor: (-BigInt(sp.amountMinor)).toString(),
              };
            });
          }
        }
        if (!payloadSplits) {
          const cat =
            categoryByNameFrom(
              workingCategories,
              row.categoryName,
              outflow ? 'expense' : 'income',
            ) ?? fallback;
          const negated = outflow ? row.amountMinor.slice(1) : `-${row.amountMinor}`;
          payloadSplits = [{ categoryLedgerAccountId: cat.ledgerAccountId, amountMinor: negated }];
        }
        const result: CommandResult = await createManualTransaction({
          householdId,
          userId,
          accountId: account.id,
          description: row.description,
          effectiveDate: row.date,
          amountMinor: row.amountMinor,
          status: 'posted',
          splits: payloadSplits,
          attemptKey: `csv-${key}`,
        });
        if (result.idempotentReplay) replayed++;
        else {
          imported++;
          // Quicken memos become notes (best-effort; the row itself is safe).
          const txnId = result.effects['canonicalTransactionId'];
          if (row.memo && typeof txnId === 'string') {
            await overrideTransaction({
              householdId,
              transactionId: txnId,
              displayDescription: '',
              note: row.memo,
            }).catch(() => undefined);
          }
        }
      } catch {
        failed++;
      }
      setProgress((p) => (p ? { done: p.done + 1, total: p.total } : p));
    }
    setBusy(false);
    setProgress(null);
    const parts = [`Imported ${String(imported)}`];
    if (replayed > 0) parts.push(`${String(replayed)} already there (skipped)`);
    if (failed > 0) parts.push(`${String(failed)} failed`);
    toast[failed > 0 ? 'error' : 'success'](`${parts.join(' · ')}.`);
    if (imported > 0 || replayed > 0) {
      setText('');
      setFileName(null);
      onDone();
    }
  }

  const colItems = Object.fromEntries(
    header.map((h, i) => [String(i), h.trim() || `Column ${String(i + 1)}`]),
  );
  const ready =
    accountId !== null &&
    parsed.rows.length > 0 &&
    (isQif || (cDate !== null && cAmount !== null && cDesc !== null));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import CSV or QIF</DialogTitle>
          <DialogDescription>
            Paste a bank CSV export or a Quicken QIF file (or pick the file). Importing the same
            file twice never duplicates — rows are keyed by their content. QIF categories and splits
            come along by name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Into account</Label>
              <Select
                value={accountId ?? undefined}
                items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
                onValueChange={(v) => {
                  setAccountId(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csv-file">Or pick a file</Label>
              <label
                htmlFor="csv-file"
                className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              >
                <FileUp className="size-4" />
                Choose .csv / .qif
                <input
                  id="csv-file"
                  type="file"
                  accept=".csv,.qif,text/csv"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setFileName(f.name);
                    void f.text().then(setText);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csv-text">CSV / QIF</Label>
            <Textarea
              id="csv-text"
              value={text}
              rows={5}
              placeholder={'Transaction Date,Description,Amount\n07/01/2026,COFFEE SHOP,-4.50'}
              className="font-mono text-xs"
              onChange={(e) => {
                // Typed/pasted content stands on its own — a previously chosen
                // file's name must not steer format detection.
                setFileName(null);
                setText(e.target.value);
              }}
            />
          </div>

          {header.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  ['Date', 'date', cDate],
                  ['Amount', 'amount', cAmount],
                  ['Description', 'desc', cDesc],
                ] as const
              ).map(([label, which, value]) => (
                <div key={which} className="space-y-1.5">
                  <Label>{label} column</Label>
                  <Select
                    value={value === null ? undefined : String(value)}
                    items={colItems}
                    onValueChange={(v) => {
                      if (v === null) return;
                      // Materialize the current guesses once, then apply the
                      // user's pick — other columns keep their mapping.
                      if (!touched) {
                        setDateCol(cDate);
                        setAmountCol(cAmount);
                        setDescCol(cDesc);
                        setTouched(true);
                      }
                      const n = Number(v);
                      if (which === 'date') setDateCol(n);
                      else if (which === 'amount') setAmountCol(n);
                      else setDescCol(n);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Pick column" />
                    </SelectTrigger>
                    <SelectContent>
                      {header.map((h, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {h.trim() || `Column ${String(i + 1)}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          ) : null}

          {parsed.rows.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {String(parsed.rows.length)} rows ready
                  {parsed.skipped > 0 ? ` · ${String(parsed.skipped)} skipped (unparseable)` : ''}
                  {parsed.ignored > 0
                    ? ` · ${String(parsed.ignored)} non-cash records ignored`
                    : ''}
                  {isQif && parsed.dayFirst ? ' · dates read day-first (DD/MM)' : ''}
                </span>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={flipSigns}
                    onChange={(e) => {
                      setFlipSigns(e.target.checked);
                    }}
                  />
                  Flip signs (money out shown positive)
                </label>
              </div>
              <div className="rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {analysis.confidence === 'high' ? (
                    <CheckCircle2 className="size-4 text-primary" />
                  ) : (
                    <AlertTriangle className="size-4 text-muted-foreground" />
                  )}
                  <span className="font-medium">
                    {analysis.confidence === 'high'
                      ? 'High-confidence import'
                      : 'Review before importing'}
                  </span>
                  {analysis.dateRange ? (
                    <span className="text-muted-foreground">· {analysis.dateRange}</span>
                  ) : null}
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <span>{String(analysis.outflows)} outflows</span>
                  <span>{String(analysis.inflows)} inflows</span>
                  <span>{String(analysis.duplicates)} duplicate-looking</span>
                  <span>
                    {String(analysis.matchedCategories)} categories matched
                    {analysis.unmatchedCategories > 0
                      ? ` / ${String(analysis.unmatchedCategories)} unmatched`
                      : ''}
                  </span>
                </div>
                {analysis.validSplits > 0 || analysis.invalidSplits > 0 ? (
                  <p className="mt-2 text-muted-foreground">
                    {String(analysis.validSplits)} split transactions valid
                    {analysis.invalidSplits > 0
                      ? ` · ${String(analysis.invalidSplits)} split transactions need cleanup`
                      : ''}
                  </p>
                ) : null}
                {analysis.notes.length > 0 ? (
                  <ul className="mt-2 list-disc pl-4 text-muted-foreground">
                    {analysis.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                ) : null}
                {analysis.missingCategories.length > 0 ? (
                  <label className="mt-3 flex cursor-pointer items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={createMissingCategories}
                      onChange={(e) => {
                        setCreateMissingCategories(e.target.checked);
                      }}
                    />
                    Create {String(analysis.missingCategories.length)} missing QIF categories before
                    import
                  </label>
                ) : null}
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border px-3 py-2">
                {parsed.rows.slice(0, 8).map((r, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className="w-16 shrink-0 font-mono text-muted-foreground">
                      {r.date.slice(5)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.description}</span>
                    <Money amountMinor={r.amountMinor} signed className="shrink-0 text-xs" />
                  </div>
                ))}
                {parsed.rows.length > 8 ? (
                  <p className="text-[11px] text-muted-foreground">
                    …and {String(parsed.rows.length - 8)} more
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {isQif
                  ? 'Categories and splits from the QIF are matched by name; anything unmatched lands as Uncategorized. Re-imports never duplicate — and never overwrite categorization you have since changed here.'
                  : 'Rows land as Uncategorized; your rules file them automatically within a few minutes.'}
              </p>
            </div>
          ) : null}

          {progress ? (
            <p className="text-sm text-muted-foreground">
              Importing {String(progress.done)} / {String(progress.total)}…
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() => {
              void runImport();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Import {parsed.rows.length > 0 ? String(parsed.rows.length) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
