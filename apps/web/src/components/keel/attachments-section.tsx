'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';

import {
  detachDocument,
  fetchDocumentsForTarget,
  uploadDocument,
  type DocumentKind,
  type DocumentRow,
  type DocumentTargetType,
} from '@/lib/keel-api';
import { Button } from '@/components/ui/button';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attach-only receipts/statements (no auto-extract/match — see
 * docs/research/RECEIPTS-2026-07-16.md for the deferred fuller pipeline).
 * Drop-in section for any target: a transaction, a paycheck, a
 * reimbursement claim, or a statement. Upload → the file goes straight to
 * Storage via a signed URL, then a confirm step hashes/verifies it
 * server-side; detach is undo (Law 2), never a hard delete.
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="size-3.5" />
          Attachments{rows && rows.length > 0 ? ` (${String(rows.length)})` : ''}
        </p>
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
    </div>
  );
}
