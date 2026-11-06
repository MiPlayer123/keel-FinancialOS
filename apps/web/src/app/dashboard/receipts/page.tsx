'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Receipt,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState, QueryErrorState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import {
  attachExistingDocument,
  decideReceiptMatch,
  detachDocument,
  detachReceiptMatch,
  fetchEntities,
  fetchReceiptCandidates,
  fetchReceiptsInbox,
  fetchStorageSummary,
  uploadReceipt,
  type DocumentStorageSummary,
  type EntityRow,
  type ReceiptCandidate,
  type ReceiptInboxRow,
} from '@/lib/keel-api';
import { minorToDollarsInput, parseDollarsToMinorString } from '@/lib/money';
import { prepareReceiptFile } from '@/lib/receipt-image';
import { shortDateWithYear } from '@/lib/relative-date';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
/** iOS Safari converts HEIC to JPEG when HEIC isn't listed here. */
const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,application/pdf';
const ENTITY_PREF_KEY = 'keel-receipt-entity';
/** Keep checking for a read result this long after an upload. */
const POLL_WINDOW_MS = 3 * 60 * 1000;
const POLL_EVERY_MS = 4000;

/** Human byte size from a BIGINT-safe string count. */
function formatByteString(byteStr: string): string {
  const n = Number(byteStr);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readPref(): string | null {
  try {
    return window.localStorage.getItem(ENTITY_PREF_KEY);
  } catch {
    return null;
  }
}

function writePref(value: string): void {
  try {
    window.localStorage.setItem(ENTITY_PREF_KEY, value);
  } catch {
    /* a remembered choice is a convenience only */
  }
}

/**
 * Storage hygiene strip. KEEL keeps document BYTES in Supabase Storage (not
 * inline in Postgres like Quicken), so growth is just the sum of uploaded
 * file sizes — surfaced here so it never silently balloons. Identical
 * re-uploads are recognised and filed once.
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
      {summary.deletedDocuments > 0 ? (
        <span>{summary.deletedDocuments} removed (kept for export/audit)</span>
      ) : null}
    </div>
  );
}

export default function ReceiptsPage() {
  return (
    <>
      <PageHeader title="Receipts" />
      <div className="p-4 sm:p-6">
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
  DATE_4_5D: '4+ days apart',
  MERCHANT_EXACT: 'Merchant matches',
  MERCHANT_FUZZY: 'Merchant likely matches',
};

/** Still waiting on a read, and uploaded recently enough to keep checking. */
function isReading(row: ReceiptInboxRow, now: number): boolean {
  const pending = row.extraction === null || row.extraction.status === 'pending';
  return pending && now - Date.parse(row.createdAt) < POLL_WINDOW_MS;
}

function ReceiptsBody() {
  const { householdId, userId } = useHousehold();
  const [rows, setRows] = useState<ReceiptInboxRow[] | null>(null);
  const [storage, setStorage] = useState<DocumentStorageSummary | null>(null);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const requestKeyRef = useRef(0);

  const load = useCallback(() => {
    if (!householdId) {
      setRows(null);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    const requestKey = ++requestKeyRef.current;
    void fetchReceiptsInbox(householdId)
      .then((fetched) => {
        if (requestKeyRef.current === requestKey) setRows(fetched);
      })
      .catch((error: unknown) => {
        if (requestKeyRef.current === requestKey) {
          setRows([]);
          setLoadError(error instanceof Error ? error.message : 'Could not load receipts.');
        }
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

  // While a fresh upload is being read, check back every few seconds.
  useEffect(() => {
    if (!rows || !rows.some((r) => isReading(r, Date.now()))) return;
    const timer = window.setTimeout(load, POLL_EVERY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [rows, load]);

  // Books to file uploads under: the last choice, else personal, else the first.
  useEffect(() => {
    if (!householdId) return;
    void fetchEntities(householdId)
      .then((list) => {
        setEntities(list);
        const remembered = readPref();
        const fallback = list.find((e) => e.kind === 'personal') ?? list[0];
        setEntityId(
          (current) =>
            current ?? (list.some((e) => e.entityId === remembered) ? remembered : null) ?? fallback?.entityId ?? null,
        );
      })
      .catch(() => {
        /* upload buttons stay disabled without an entity */
      });
  }, [householdId]);

  async function handleFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0 || !householdId || !entityId) return;
    const chosen = Array.from(files).filter((f) => {
      if (!ACCEPTED_MIME.has(f.type)) {
        toast.error(`${f.name}: only JPEG, PNG, WebP, or PDF are supported.`);
        return false;
      }
      return true;
    });
    if (chosen.length === 0) return;
    setUploading(true);
    let filed = 0;
    let duplicates = 0;
    for (const original of chosen) {
      try {
        const file = await prepareReceiptFile(original);
        if (file.size > MAX_BYTES) {
          toast.error(`${original.name}: files over 10MB are not supported.`);
          continue;
        }
        const result = await uploadReceipt({ householdId, entityId, file });
        if (result.duplicate) duplicates += 1;
        else filed += 1;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : `Could not upload ${original.name}.`);
      }
    }
    setUploading(false);
    if (filed > 0) {
      toast.success(
        filed === 1 ? 'Receipt uploaded. Reading it now.' : `${String(filed)} receipts uploaded. Reading them now.`,
      );
    }
    if (duplicates > 0) {
      toast.info(duplicates === 1 ? 'That receipt was already here.' : `${String(duplicates)} were already here.`);
    }
    load();
  }

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    try {
      await action();
      toast.success(success);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  function decide(matchId: string, confirm: boolean) {
    if (!householdId || !userId) return;
    void run(
      matchId,
      () => decideReceiptMatch({ householdId, userId, matchId, confirm }),
      confirm ? 'Receipt attached to the transaction.' : 'Suggestion dismissed.',
    );
  }

  function detach(row: ReceiptInboxRow) {
    if (!householdId || !userId) return;
    const matchId = row.match?.status === 'confirmed' ? row.match.matchId : null;
    const attachmentId = row.attached?.attachmentId ?? null;
    if (!matchId && !attachmentId) return;
    void run(
      row.documentVersionId,
      () =>
        matchId
          ? detachReceiptMatch({ householdId, userId, matchId })
          : detachDocument({
              householdId,
              userId,
              attachmentId: attachmentId ?? '',
              reason: 'Detached on the receipts page',
            }),
      'Receipt detached from the transaction.',
    );
  }

  function attachTo(row: ReceiptInboxRow, transactionId: string) {
    if (!householdId || !userId) return;
    void run(
      row.documentVersionId,
      async () => {
        // Picking a different transaction answers an open suggestion too.
        if (row.match?.status === 'suggested' && row.match.transactionId !== transactionId) {
          await decideReceiptMatch({ householdId, userId, matchId: row.match.matchId, confirm: false });
        }
        await attachExistingDocument({
          householdId,
          userId,
          documentId: row.documentId,
          targetType: 'transaction',
          targetId: transactionId,
        });
      },
      'Receipt attached to the transaction.',
    );
  }

  const accountName = (r: ReceiptInboxRow): string | null =>
    r.attached?.txnAccountName ?? r.match?.txnAccountName ?? null;

  const accountOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows ?? []) {
      const name = accountName(r);
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    if (accountFilter === 'all') return rows;
    return rows.filter((r) => accountName(r) === accountFilter);
  }, [rows, accountFilter]);

  const isAttached = (r: ReceiptInboxRow) => Boolean(r.attached) || r.match?.status === 'confirmed';
  const attached = filtered?.filter(isAttached) ?? [];
  const suggested = filtered?.filter((r) => !isAttached(r) && r.match?.status === 'suggested') ?? [];
  const unmatched = filtered?.filter((r) => !isAttached(r) && r.match?.status !== 'suggested') ?? [];

  const entityName = entities.find((e) => e.entityId === entityId)?.name ?? null;
  const canUpload = !uploading && Boolean(householdId) && Boolean(entityId);

  const uploadControls = (
    <div className="flex flex-wrap items-center gap-2">
      {entities.length > 1 ? (
        <Select
          value={entityId ?? ''}
          onValueChange={(value) => {
            if (!value) return;
            setEntityId(value);
            writePref(value);
          }}
        >
          <SelectTrigger className="h-9 w-40 text-sm" aria-label="File receipts under">
            <SelectValue placeholder="Books">{entityName ?? 'Books'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {entities.map((e) => (
              <SelectItem key={e.entityId} value={e.entityId}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        accept={ACCEPT_ATTR}
        disabled={!canUpload}
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {/* Camera capture: the photo goes straight to KEEL, not the phone's library. */}
      <input
        ref={cameraRef}
        type="file"
        className="sr-only"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        disabled={!canUpload}
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        className="sm:hidden"
        disabled={!canUpload}
        onClick={() => {
          cameraRef.current?.click();
        }}
      >
        <Camera className="size-4" />
        Take photo
      </Button>
      <Button
        type="button"
        variant="outline"
        className="sm:hidden"
        disabled={!canUpload}
        onClick={() => {
          fileRef.current?.click();
        }}
      >
        <Upload className="size-4" />
        Choose file
      </Button>
      <Button
        type="button"
        className="hidden sm:inline-flex"
        disabled={!canUpload}
        onClick={() => {
          fileRef.current?.click();
        }}
      >
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        Upload receipts
      </Button>
      {uploading ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
          <Loader2 className="size-3.5 animate-spin" /> Uploading…
        </span>
      ) : null}
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

  if (loadError) {
    return (
      <QueryErrorState
        onRetry={() => {
          load();
        }}
      />
    );
  }

  const isEmpty = rows.length === 0;

  return (
    <div
      className={cn(
        'relative space-y-6 rounded-lg',
        dragging && 'outline-2 outline-offset-4 outline-dashed outline-primary/60',
      )}
      onDragOver={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragging(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
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
                <SelectValue placeholder="All accounts">
                  {accountFilter === 'all' ? 'All accounts' : accountFilter}
                </SelectValue>
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
          description="Take a photo or upload an image or PDF (or drop files here). KEEL reads the merchant, amount and date, then suggests the transaction it belongs to for you to confirm. Every original is kept and exported with your books."
        />
      ) : (
        <>
          {suggested.length > 0 ? (
            <Section
              title="Needs your review"
              count={suggested.length}
              hint="KEEL found a likely transaction for these. Attach the receipt, or say it's not a match."
            >
              {suggested.map((row) => (
                <SuggestionCard
                  key={row.documentVersionId}
                  row={row}
                  busy={busy === row.match?.matchId}
                  onConfirm={() => {
                    if (row.match) decide(row.match.matchId, true);
                  }}
                  onReject={() => {
                    if (row.match) decide(row.match.matchId, false);
                  }}
                />
              ))}
            </Section>
          ) : null}

          {unmatched.length > 0 ? (
            <Section
              title="Unmatched"
              count={unmatched.length}
              hint="No confident match yet. Find the transaction yourself, or leave it here until one shows up."
            >
              {unmatched.map((row) => (
                <UnmatchedCard
                  key={row.documentVersionId}
                  row={row}
                  householdId={householdId ?? ''}
                  busy={busy === row.documentVersionId}
                  onAttach={(transactionId) => {
                    attachTo(row, transactionId);
                  }}
                />
              ))}
            </Section>
          ) : null}

          {attached.length > 0 ? (
            <Section title="Attached" count={attached.length}>
              {attached.map((row) => (
                <AttachedCard
                  key={row.documentVersionId}
                  row={row}
                  busy={busy === row.documentVersionId}
                  onDetach={() => {
                    detach(row);
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

const FAILURE_TEXT: Record<string, string> = {
  extraction_off: 'Automatic reading is off. Find the transaction below.',
  monthly_limit_reached: 'Monthly reading limit reached. Find the transaction below.',
};

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
    return (
      <p className="text-xs text-muted-foreground">
        {FAILURE_TEXT[ex.errorCode ?? ''] ?? 'Could not read this receipt automatically.'}
      </p>
    );
  }
  const parts: string[] = [];
  if (ex.merchant) parts.push(ex.merchant);
  if (ex.txnDate) parts.push(shortDateWithYear(ex.txnDate));
  if (parts.length === 0 && !ex.amountMinor) {
    return <p className="text-xs text-muted-foreground">Nothing readable found. Find the transaction below.</p>;
  }
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Sparkles className="size-3 shrink-0" />
      <span className="truncate">{parts.join(' · ')}</span>
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
  return <div className="rounded-lg border border-border bg-card p-3 text-sm">{children}</div>;
}

function TxnLine({
  description,
  amountMinor,
  currency,
  date,
  accountName,
}: {
  description: string;
  amountMinor: string | null;
  currency: string;
  date: string | null;
  accountName: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="truncate font-medium">{description}</span>
      {amountMinor ? <Money amountMinor={amountMinor} currency={currency} className="text-sm" /> : null}
      <span className="text-xs text-muted-foreground">
        {[date ? shortDateWithYear(date) : null, accountName].filter(Boolean).join(' · ')}
      </span>
    </div>
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
            <TxnLine
              description={match.txnDescription}
              amountMinor={match.txnAmountMinor}
              currency={match.txnCurrency ?? row.extraction?.currency ?? 'USD'}
              date={match.txnDate}
              accountName={match.txnAccountName}
            />
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

function UnmatchedCard({
  row,
  householdId,
  busy,
  onAttach,
}: {
  row: ReceiptInboxRow;
  householdId: string;
  busy: boolean;
  onAttach: (transactionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const reading = row.extraction === null || row.extraction.status === 'pending';
  return (
    <CardShell>
      <div className="flex items-start gap-2">
        <FileGlyph mimeType={row.mimeType} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <ReceiptFileLink row={row} />
          <ExtractionLine row={row} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {shortDateWithYear(row.createdAt.slice(0, 10))}
        </span>
      </div>
      {!reading ? (
        <div className="mt-2">
          {open ? (
            <CandidatePicker
              row={row}
              householdId={householdId}
              busy={busy}
              onAttach={onAttach}
              onClose={() => {
                setOpen(false);
              }}
            />
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(true);
              }}
            >
              <Search className="size-3.5" />
              Find transaction
            </Button>
          )}
        </div>
      ) : null}
    </CardShell>
  );
}

/**
 * Ranked transactions for one receipt, from the deterministic matcher. When
 * nothing was read, the user types the amount and date. Nothing is attached
 * until the user picks one (suggest → approve, Law 10).
 */
function CandidatePicker({
  row,
  householdId,
  busy,
  onAttach,
  onClose,
}: {
  row: ReceiptInboxRow;
  householdId: string;
  busy: boolean;
  onAttach: (transactionId: string) => void;
  onClose: () => void;
}) {
  const read = row.extraction;
  const [amount, setAmount] = useState(read?.amountMinor ? minorToDollarsInput(read.amountMinor) : '');
  const [date, setDate] = useState(read?.txnDate?.slice(0, 10) ?? '');
  const [results, setResults] = useState<ReceiptCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    (manual: { amountMinor?: string; txnDate?: string }) => {
      setLoading(true);
      setError(null);
      void fetchReceiptCandidates({ householdId, documentVersionId: row.documentVersionId, ...manual })
        .then((res) => {
          setResults(res.rows);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Could not search transactions.');
          setResults([]);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [householdId, row.documentVersionId],
  );

  // First look uses what was read, if anything.
  useEffect(() => {
    if (read?.amountMinor && read.txnDate) search({});
  }, [read?.amountMinor, read?.txnDate, search]);

  function submitManual() {
    const amountMinor = parseDollarsToMinorString(amount);
    if (!amountMinor || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      setError('Enter the receipt total and date.');
      return;
    }
    search({ amountMinor, txnDate: date });
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-2.5">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Total</span>
          <Input
            inputMode="decimal"
            placeholder="0.00"
            className="h-8 w-28"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
            }}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Date</span>
          <Input
            type="date"
            className="h-8 w-40"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
            }}
          />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          Search
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </form>
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
      {results !== null && results.length === 0 && !loading && !error ? (
        <p className="text-xs text-muted-foreground">
          No transaction with that amount within 3 days before to 10 days after. It may not have synced yet.
        </p>
      ) : null}
      {results && results.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {results.map((c) => (
            <li key={c.transactionId} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <TxnLine
                  description={c.description}
                  amountMinor={c.amountMinor}
                  currency={c.currency}
                  date={c.effectiveDate}
                  accountName={c.accountName}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <MatchEvidence reasonCodes={c.reasonCodes} />
                  {c.hasReceipt ? (
                    <span className="text-[11px] text-muted-foreground">Already has a receipt</span>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => {
                  onAttach(c.transactionId);
                }}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
                Attach
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
  const att = row.attached;
  const match = row.match?.status === 'confirmed' ? row.match : null;
  const description = att?.txnDescription ?? match?.txnDescription ?? '';
  const amountMinor = att?.txnAmountMinor ?? match?.txnAmountMinor ?? null;
  const currency = att?.txnCurrency ?? match?.txnCurrency ?? 'USD';
  const account = att?.txnAccountName ?? match?.txnAccountName ?? null;
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <FileGlyph mimeType={row.mimeType} />
        <div className="min-w-0 flex-1">
          <ReceiptFileLink row={row} />
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <Paperclip className="size-3 shrink-0" />
            <span className="truncate">{description}</span>
            {amountMinor ? <Money amountMinor={amountMinor} currency={currency} className="text-xs" /> : null}
            {account ? <span>· {account}</span> : null}
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
