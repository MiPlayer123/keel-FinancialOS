'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Receipt,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import {
  decideReceiptMatch,
  detachReceiptMatch,
  fetchEntities,
  fetchReceiptsInbox,
  fetchStorageSummary,
  uploadReceipt,
  type DocumentStorageSummary,
  type ReceiptInboxRow,
} from '@/lib/keel-api';
import { shortDateWithYear } from '@/lib/relative-date';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/** Human byte size from a BIGINT-safe string count. */
function formatByteString(byteStr: string): string {
  const n = Number(byteStr);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Storage hygiene strip. KEEL keeps document BYTES in Supabase Storage (not
 * inline in Postgres like Quicken), so growth is just the sum of uploaded
 * file sizes — surfaced here so it never silently balloons. Dedup: identical
 * re-uploads collapse to one stored object.
 */
function StorageSummaryBar({ summary }: { summary: DocumentStorageSummary | null }) {
  if (!summary || summary.liveDocuments === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span>
        <span className="font-medium text-foreground">{formatByteString(summary.liveBytes)}</span>{' '}
        in Storage
      </span>
      <span>
        {summary.liveDocuments} {summary.liveDocuments === 1 ? 'document' : 'documents'}
      </span>
      {summary.distinctContent < summary.versionCount ? (
        <span>{summary.distinctContent} unique (duplicates deduped)</span>
      ) : null}
      {summary.deletedDocuments > 0 ? (
        <span>{summary.deletedDocuments} removed (kept for export/audit)</span>
      ) : null}
    </div>
  );
}

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader
        title="Receipts"
        description="Upload receipts, let KEEL read them, and confirm the transaction each one belongs to. Every original is kept immutably and exported with your books."
      />
      <div className="p-6">
        <ReceiptsBody />
      </div>
    </>
  );
}

/** Human label for a matcher reason code. */
const REASON_LABEL: Record<string, string> = {
  AMOUNT_EXACT: 'Amount matches',
  AMOUNT_TIP_RANGE: 'Amount matches (with tip)',
  DATE_SAME_DAY: 'Same day',
  DATE_1D: '1 day apart',
  DATE_2_3D: '2–3 days apart',
  DATE_4_5D: '4–5 days apart',
  MERCHANT_EXACT: 'Merchant matches',
  MERCHANT_FUZZY: 'Merchant likely matches',
};

function ReceiptsBody() {
  const { householdId, userId } = useHousehold();
  const [rows, setRows] = useState<ReceiptInboxRow[] | null>(null);
  const [storage, setStorage] = useState<DocumentStorageSummary | null>(null);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyMatch, setBusyMatch] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const requestKeyRef = useRef(0);

  const load = useCallback(() => {
    if (!householdId) {
      setRows(null);
      return;
    }
    const requestKey = ++requestKeyRef.current;
    void fetchReceiptsInbox(householdId)
      .then((fetched) => {
        if (requestKeyRef.current === requestKey) setRows(fetched);
      })
      .catch(() => {
        if (requestKeyRef.current === requestKey) setRows([]);
      });
    void fetchStorageSummary(householdId)
      .then((s) => {
        if (requestKeyRef.current === requestKey) setStorage(s);
      })
      .catch(() => {
        if (requestKeyRef.current === requestKey) setStorage(null);
      });
  }, [householdId]);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve a default entity for uploads (the household's first/personal books).
  useEffect(() => {
    if (!householdId) return;
    void fetchEntities(householdId)
      .then((entities) => {
        setEntityId((current) => current ?? entities[0]?.entityId ?? null);
      })
      .catch(() => {
        /* upload button stays disabled without an entity */
      });
  }, [householdId]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !householdId || !entityId) return;
    const chosen = Array.from(files).filter((f) => {
      if (!ACCEPTED_MIME.has(f.type)) {
        toast.error(`${f.name}: only JPEG, PNG, WebP, or PDF are supported.`);
        return false;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name}: files over 10MB are not supported.`);
        return false;
      }
      return true;
    });
    if (chosen.length === 0) return;
    setUploading(true);
    let ok = 0;
    for (const file of chosen) {
      try {
        await uploadReceipt({ householdId, entityId, file });
        ok += 1;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not upload ${file.name}.`);
      }
    }
    setUploading(false);
    if (ok > 0) {
      toast.success(
        ok === 1 ? 'Receipt uploaded — reading it now.' : `${String(ok)} receipts uploaded — reading them now.`,
      );
    }
    load();
  }

  async function decide(matchId: string, confirm: boolean) {
    if (!householdId || !userId) return;
    setBusyMatch(matchId);
    try {
      await decideReceiptMatch({ householdId, userId, matchId, confirm });
      toast.success(confirm ? 'Receipt attached to the transaction.' : 'Suggestion dismissed.');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the match.');
    } finally {
      setBusyMatch(null);
    }
  }

  async function detach(matchId: string) {
    if (!householdId || !userId) return;
    setBusyMatch(matchId);
    try {
      await detachReceiptMatch({ householdId, userId, matchId });
      toast.success('Receipt detached from the transaction.');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not detach the receipt.');
    } finally {
      setBusyMatch(null);
    }
  }

  const accountOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows ?? []) {
      if (r.match?.txnAccountName) names.add(r.match.txnAccountName);
    }
    return Array.from(names).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    if (accountFilter === 'all') return rows;
    return rows.filter((r) => r.match?.txnAccountName === accountFilter);
  }, [rows, accountFilter]);

  const suggested = filtered?.filter((r) => r.match?.status === 'suggested') ?? [];
  const attached = filtered?.filter((r) => r.match?.status === 'confirmed') ?? [];
  const unmatched = filtered?.filter((r) => r.match === null) ?? [];

  const uploadControls = (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        disabled={uploading}
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        disabled={uploading || !householdId || !entityId}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Upload receipts
      </Button>
    </div>
  );

  if (rows === null) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{uploadControls}</div>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  const isEmpty = rows.length === 0;

  return (
    <div className="space-y-6">
      <StorageSummaryBar summary={storage} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {accountOptions.length > 0 ? (
            <Select
              value={accountFilter}
              onValueChange={(value) => {
                setAccountFilter(value ?? 'all');
              }}
            >
              <SelectTrigger className="h-9 w-52 text-sm">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accountOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        {uploadControls}
      </div>

      {isEmpty ? (
        <EmptyState
          icon={<Receipt className="size-6" />}
          title="No receipts yet"
          description="Upload a receipt image or PDF. KEEL reads the merchant, amount, and date, then suggests the transaction it belongs to for you to confirm."
        />
      ) : (
        <>
          {suggested.length > 0 ? (
            <Section
              title="Needs your review"
              count={suggested.length}
              hint="KEEL found a likely transaction for these. Confirm to attach the receipt, or dismiss."
            >
              {suggested.map((row) => (
                <SuggestionCard
                  key={row.documentVersionId}
                  row={row}
                  busy={busyMatch === row.match?.matchId}
                  onConfirm={() => {
                    if (row.match) void decide(row.match.matchId, true);
                  }}
                  onReject={() => {
                    if (row.match) void decide(row.match.matchId, false);
                  }}
                />
              ))}
            </Section>
          ) : null}

          {unmatched.length > 0 ? (
            <Section
              title="Unmatched"
              count={unmatched.length}
              hint="No confident transaction match — read details are shown when available. These stay here until a match appears or you handle them manually."
            >
              {unmatched.map((row) => (
                <UnmatchedCard key={row.documentVersionId} row={row} />
              ))}
            </Section>
          ) : null}

          {attached.length > 0 ? (
            <Section title="Attached" count={attached.length}>
              {attached.map((row) => (
                <AttachedCard
                  key={row.documentVersionId}
                  row={row}
                  busy={busyMatch === row.match?.matchId}
                  onDetach={() => {
                    if (row.match) void detach(row.match.matchId);
                  }}
                />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count: number;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function FileGlyph({ mimeType }: { mimeType: string }) {
  return mimeType === 'application/pdf' ? (
    <FileText className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
  );
}

function ReceiptFileLink({ row }: { row: ReceiptInboxRow }) {
  return row.url ? (
    <a
      href={row.url}
      target="_blank"
      rel="noreferrer"
      className="min-w-0 truncate font-medium hover:underline"
      title={row.originalFilename}
    >
      {row.originalFilename}
    </a>
  ) : (
    <span className="min-w-0 truncate font-medium" title={row.originalFilename}>
      {row.originalFilename}
    </span>
  );
}

function ExtractionLine({ row }: { row: ReceiptInboxRow }) {
  const ex = row.extraction;
  if (!ex || ex.status === 'pending') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Reading receipt…
      </p>
    );
  }
  if (ex.status === 'failed') {
    return <p className="text-xs text-muted-foreground">Could not read this receipt automatically.</p>;
  }
  const parts: string[] = [];
  if (ex.merchant) parts.push(ex.merchant);
  if (ex.txnDate) parts.push(shortDateWithYear(ex.txnDate));
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="size-3 shrink-0" />
      <span className="truncate">{parts.length > 0 ? parts.join(' · ') : 'Read complete'}</span>
      {ex.amountMinor ? (
        <Money amountMinor={ex.amountMinor} currency={ex.currency ?? 'USD'} className="text-xs" />
      ) : null}
    </p>
  );
}

/** The evidence-check line: shows the matcher's reason codes (proof on demand). */
function MatchEvidence({ reasonCodes }: { reasonCodes: string[] }) {
  if (reasonCodes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {reasonCodes.map((code) => (
        <Badge key={code} variant="secondary" className="gap-1 text-[11px] font-normal">
          <Check className="size-3" />
          {REASON_LABEL[code] ?? code}
        </Badge>
      ))}
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">{children}</div>
  );
}

function SuggestionCard({
  row,
  busy,
  onConfirm,
  onReject,
}: {
  row: ReceiptInboxRow;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const match = row.match;
  if (!match) return null;
  return (
    <CardShell>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <FileGlyph mimeType={row.mimeType} />
            <ReceiptFileLink row={row} />
          </div>
          <ExtractionLine row={row} />
          <div className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <p className="text-xs text-muted-foreground">Likely transaction</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="truncate font-medium">{match.txnDescription}</span>
              {match.txnAmountMinor ? (
                <Money amountMinor={match.txnAmountMinor} currency="USD" className="text-sm" />
              ) : null}
              <span className="text-xs text-muted-foreground">
                {shortDateWithYear(match.txnDate)} · {match.txnAccountName}
              </span>
            </div>
            <div className="mt-1.5">
              <MatchEvidence reasonCodes={match.reasonCodes} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
            Attach
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReject}>
            Not a match
          </Button>
        </div>
      </div>
    </CardShell>
  );
}

function UnmatchedCard({ row }: { row: ReceiptInboxRow }) {
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <FileGlyph mimeType={row.mimeType} />
        <div className="min-w-0 flex-1">
          <ReceiptFileLink row={row} />
          <ExtractionLine row={row} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {shortDateWithYear(row.createdAt.slice(0, 10))}
        </span>
      </div>
    </CardShell>
  );
}

function AttachedCard({
  row,
  busy,
  onDetach,
}: {
  row: ReceiptInboxRow;
  busy: boolean;
  onDetach: () => void;
}) {
  const match = row.match;
  if (!match) return null;
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <FileGlyph mimeType={row.mimeType} />
        <div className="min-w-0 flex-1">
          <ReceiptFileLink row={row} />
          <p className="flex items-center gap-x-2 text-xs text-muted-foreground">
            <Paperclip className="size-3 shrink-0" />
            <span className="truncate">{match.txnDescription}</span>
            {match.txnAmountMinor ? (
              <Money amountMinor={match.txnAmountMinor} currency="USD" className="text-xs" />
            ) : null}
            <span>· {match.txnAccountName}</span>
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onDetach}
          aria-label="Detach receipt"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          Detach
        </Button>
      </div>
    </CardShell>
  );
}
