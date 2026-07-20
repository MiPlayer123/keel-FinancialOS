'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, Link2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';

import {
  attachExistingDocument,
  detachDocument,
  fetchDocumentsForTarget,
  fetchHouseholdDocuments,
  uploadDocument,
  type DocumentKind,
  type DocumentRow,
  type DocumentTargetType,
  type HouseholdDocumentRow,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attach-only receipts/statements. Drop-in section for any target: a
 * transaction, a paycheck, a reimbursement claim, or a statement. Two ways to
 * attach:
 *  - "Attach file": a FRESH upload straight to Storage via a signed URL, then
 *    a confirm step hashes/verifies it server-side.
 *  - "Attach existing": link an already-uploaded document (e.g. a receipt from
 *    the inbox) to this target — no bytes move, just a document_attachments
 *    link row (idempotent server-side).
 * Detach is undo (Law 2), never a hard delete.
 */
export function AttachmentsSection({
  householdId,
  userId,
  entityId,
  targetType,
  targetId,
  kind,
}: {
  householdId: string | null;
  userId: string | null;
  entityId: string | null;
  targetType: DocumentTargetType;
  targetId: string;
  /** Which Storage bucket new uploads land in — 'receipt' for most targets, 'statement' for statements. */
  kind: DocumentKind;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<DocumentRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [detaching, setDetaching] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Ignore a resolving fetch for a target this section has since moved past
  // (e.g. the desktop panel switching rows) — otherwise an older request can
  // resolve after a newer one and overwrite the current target's rows with
  // a different transaction's attachments (review r3606236984).
  const requestKeyRef = useRef(0);

  const load = useCallback(() => {
    if (!householdId) {
      setRows(null);
      return;
    }
    const requestKey = ++requestKeyRef.current;
    setRows(null);
    void fetchDocumentsForTarget(householdId, targetType, targetId)
      .then((fetched) => {
        if (requestKeyRef.current === requestKey) setRows(fetched);
      })
      .catch(() => {
        if (requestKeyRef.current === requestKey) setRows([]);
      });
  }, [householdId, targetType, targetId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !householdId || !entityId) return;
    const file = files[0];
    if (!file) return;
    if (!ACCEPTED_MIME.has(file.type)) {
      toast.error('Only JPEG, PNG, WebP, or PDF files are supported.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('Files over 10MB are not supported.');
      return;
    }
    setUploading(true);
    try {
      await uploadDocument({
        householdId,
        entityId,
        kind,
        file,
        target: { type: targetType, id: targetId },
      });
      toast.success('Attached.');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not attach the file.');
    } finally {
      setUploading(false);
    }
  }

  async function handleDetach(row: DocumentRow) {
    if (!householdId || !userId) return;
    setDetaching(row.attachmentId);
    try {
      await detachDocument({
        householdId,
        userId,
        attachmentId: row.attachmentId,
        reason: 'Removed by user',
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the attachment.');
    } finally {
      setDetaching(null);
    }
  }

  const attachedDocIds = useMemo(
    () => new Set((rows ?? []).map((r) => r.documentId)),
    [rows],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="size-3.5" />
          Attachments{rows && rows.length > 0 ? ` (${String(rows.length)})` : ''}
        </p>
        <span className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!householdId || !userId}
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            <Link2 className="size-3.5" />
            Attach existing
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={uploading || !householdId || !entityId}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Attach file
          </Button>
        </span>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          disabled={uploading}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {rows === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No files attached yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li
              key={row.attachmentId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
            >
              {row.mimeType === 'application/pdf' ? (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {row.url ? (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate hover:underline"
                  title={row.originalFilename}
                >
                  {row.originalFilename}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate" title={row.originalFilename}>
                  {row.originalFilename}
                </span>
              )}
              <span className="shrink-0 text-muted-foreground/70">{formatBytes(row.byteSize)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${row.originalFilename}`}
                disabled={detaching === row.attachmentId}
                onClick={() => {
                  void handleDetach(row);
                }}
              >
                {detaching === row.attachmentId ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <X className="size-3" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ExistingDocumentPicker
        open={pickerOpen}
        householdId={householdId}
        userId={userId}
        targetType={targetType}
        targetId={targetId}
        alreadyAttached={attachedDocIds}
        onClose={() => {
          setPickerOpen(false);
        }}
        onAttached={() => {
          setPickerOpen(false);
          load();
        }}
      />
    </div>
  );
}

/**
 * Dialog listing every already-uploaded household document; picking one links
 * it to the current target via documents.attach (no bytes move). Documents
 * already attached to THIS target are shown as "attached" and disabled.
 */
function ExistingDocumentPicker({
  open,
  householdId,
  userId,
  targetType,
  targetId,
  alreadyAttached,
  onClose,
  onAttached,
}: {
  open: boolean;
  householdId: string | null;
  userId: string | null;
  targetType: DocumentTargetType;
  targetId: string;
  alreadyAttached: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [docs, setDocs] = useState<HouseholdDocumentRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [attaching, setAttaching] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !householdId) return;
    setDocs(null);
    setQuery('');
    void fetchHouseholdDocuments(householdId)
      .then(setDocs)
      .catch(() => {
        setDocs([]);
      });
  }, [open, householdId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = docs ?? [];
    if (!q) return all;
    return all.filter((d) => d.originalFilename.toLowerCase().includes(q));
  }, [docs, query]);

  async function attach(doc: HouseholdDocumentRow) {
    if (!householdId || !userId) return;
    setAttaching(doc.documentId);
    try {
      await attachExistingDocument({
        householdId,
        userId,
        documentId: doc.documentId,
        targetType,
        targetId,
      });
      toast.success('Attached.');
      onAttached();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not attach the document.');
    } finally {
      setAttaching(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach an existing document</DialogTitle>
          <DialogDescription>
            Link a receipt or statement you&apos;ve already uploaded. The file stays put — this
            only adds a link.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search by filename…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <div className="max-h-72 overflow-y-auto">
          {docs === null ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {(docs.length === 0) ? 'No documents uploaded yet.' : 'No matches.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.map((doc) => {
                const isAttached = alreadyAttached.has(doc.documentId);
                return (
                  <li
                    key={doc.documentId}
                    className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
                  >
                    {doc.mimeType === 'application/pdf' ? (
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={doc.originalFilename}>
                      {doc.originalFilename}
                    </span>
                    <span className="shrink-0 text-muted-foreground/70">
                      {formatBytes(doc.byteSize)}
                    </span>
                    {isAttached ? (
                      <span className="shrink-0 text-muted-foreground/70">Attached</span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 text-xs"
                        disabled={attaching === doc.documentId}
                        onClick={() => {
                          void attach(doc);
                        }}
                      >
                        {attaching === doc.documentId ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          'Attach'
                        )}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
