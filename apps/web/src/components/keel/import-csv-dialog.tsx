'use client';

import { useMemo, useState } from 'react';
import { FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
  createManualTransaction,
  type AccountRow,
  type CategoryRow,
  type CommandResult,
} from '@/lib/keel-api';
import { sha256Hex } from '@/lib/hash';
import { parseCsv, parseCsvAmount, parseCsvDate, guessColumns } from '@/lib/csv';
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
};

/**
 * CSV import, Quicken-style but idempotent: every row rides the
 * transactions.manual_create envelope with a content-hash economic key, so
 * re-importing the same file REPLAYS instead of duplicating (invariant 3).
 * Rows land on the Uncategorized pads; the rules engine files them within
 * minutes (same path as synced transactions). Source preserved: the CSV's
 * description is the immutable canonical description.
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

  const grid = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
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
    if (cDate === null || cAmount === null || cDesc === null) {
      return { rows: [] as Omit<ParsedRow, 'key'>[], skipped: 0 };
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
    return { rows, skipped };
  }, [dataRows, cDate, cAmount, cDesc, flipSigns]);

  const account = accounts.find((a) => a.id === accountId);

  function uncategorizedFor(sign: 'expense' | 'income'): CategoryRow | undefined {
    const wantKey = sign === 'expense' ? 'uncategorized_expense' : 'uncategorized_income';
    const wantName = sign === 'expense' ? 'Uncategorized Expense' : 'Uncategorized Income';
    return (
      categories.find((c) => c.entityId === account?.entityId && c.pfcKey === wantKey) ??
      categories.find((c) => c.entityId === account?.entityId && c.name === wantName)
    );
  }

  async function runImport() {
    if (!householdId || !userId || !account) return;
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
        const cat = outflow ? expenseCat : incomeCat;
        const negated = outflow ? row.amountMinor.slice(1) : `-${row.amountMinor}`;
        const result: CommandResult = await createManualTransaction({
          householdId,
          userId,
          accountId: account.id,
          description: row.description,
          effectiveDate: row.date,
          amountMinor: row.amountMinor,
          status: 'posted',
          splits: [{ categoryLedgerAccountId: cat.ledgerAccountId, amountMinor: negated }],
          attemptKey: `csv-${key}`,
        });
        if (result.idempotentReplay) replayed++;
        else imported++;
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
      onDone();
    }
  }

  const colItems = Object.fromEntries(header.map((h, i) => [String(i), h.trim() || `Column ${String(i + 1)}`]));
  const ready =
    accountId !== null && cDate !== null && cAmount !== null && cDesc !== null && parsed.rows.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
          <DialogDescription>
            Paste a bank CSV export (or open the file and copy it). Importing the same
            file twice never duplicates — rows are keyed by their content.
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
                Choose .csv
                <input
                  id="csv-file"
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    void f.text().then(setText);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csv-text">CSV</Label>
            <Textarea
              id="csv-text"
              value={text}
              rows={5}
              placeholder={'Transaction Date,Description,Amount\n07/01/2026,COFFEE SHOP,-4.50'}
              className="font-mono text-xs"
              onChange={(e) => {
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
                Rows land as Uncategorized; your rules file them automatically within a
                few minutes.
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
