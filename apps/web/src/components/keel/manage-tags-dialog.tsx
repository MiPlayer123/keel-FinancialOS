'use client';

import { useState } from 'react';
import { Check, Link2Off, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { saveTag, deleteTag, unbindBusinessTag, type TagRow } from '@/lib/keel-api';
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

/**
 * Rename or delete tags. Deleting removes the tag from every transaction
 * (server-side cascade, audited with the assignment count) — the usage count
 * shown next to each tag is the blast radius.
 *
 * A BUSINESS tag (20260831120000) is shown here too, but its destructive action
 * is Unbind, not Delete: deleting it would un-attribute every transaction that
 * business owns, and the database refuses it outright. Unbind is the reversible
 * correction — the tag and all its assignments survive, they just stop counting
 * as that business's — and this is the only place in the UI that offers it, so
 * choosing the wrong entity is repairable without hand-written SQL (Law 2).
 */
export function ManageTagsDialog({
  open,
  householdId,
  tags,
  onClose,
  onMutated,
}: {
  open: boolean;
  householdId: string | null;
  tags: TagRow[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function closeAll() {
    setEditingId(null);
    setConfirmingId(null);
    onClose();
  }

  async function rename(tag: TagRow) {
    if (!householdId) return;
    const name = editName.trim();
    if (name.length === 0 || name === tag.name) {
      setEditingId(null);
      return;
    }
    setBusyId(tag.tagId);
    try {
      await saveTag({ householdId, tagId: tag.tagId, name });
      setEditingId(null);
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename the tag.');
    } finally {
      setBusyId(null);
    }
  }

  async function unbind(tag: TagRow) {
    if (!householdId || !tag.entityId) return;
    setBusyId(tag.tagId);
    try {
      await unbindBusinessTag({ householdId, entityId: tag.entityId });
      setConfirmingId(null);
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unbind the tag.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(tag: TagRow) {
    if (!householdId) return;
    setBusyId(tag.tagId);
    try {
      await deleteTag(householdId, tag.tagId);
      setConfirmingId(null);
      onMutated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the tag.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeAll();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Manage tags</DialogTitle>
          <DialogDescription>
            Rename a tag everywhere it&apos;s used, or delete it: deleting removes it from
            every transaction. A business tag can be unbound instead, which leaves the tag
            and its transactions alone and only stops them counting as that business&apos;s.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {tags.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No tags yet.</p>
          ) : null}
          {tags.map((t) => (
            <div key={t.tagId} className="flex items-center gap-2 rounded-md px-1 py-1">
              {editingId === t.tagId ? (
                <>
                  <Input
                    className="h-8 flex-1"
                    value={editName}
                    maxLength={40}
                    autoFocus
                    onChange={(e) => {
                      setEditName(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(t);
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Save name"
                    disabled={busyId === t.tagId}
                    onClick={() => {
                      void rename(t);
                    }}
                  >
                    {busyId === t.tagId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Check className="size-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Cancel rename"
                    onClick={() => {
                      setEditingId(null);
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </>
              ) : confirmingId === t.tagId ? (
                <>
                  <span className="min-w-0 flex-1 text-sm">
                    {t.entityId ? (
                      <>
                        Stop counting {String(t.usageCount)} transaction
                        {t.usageCount === 1 ? '' : 's'} as this business? The tag stays on
                        them.
                      </>
                    ) : (
                      <>
                        Remove <span className="font-medium">#{t.name}</span> from{' '}
                        {String(t.usageCount)} transaction{t.usageCount === 1 ? '' : 's'}?
                      </>
                    )}
                  </span>
                  <Button
                    variant={t.entityId ? 'secondary' : 'destructive'}
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busyId === t.tagId}
                    onClick={() => {
                      if (t.entityId) void unbind(t);
                      else void remove(t);
                    }}
                  >
                    {busyId === t.tagId ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t.entityId ? 'Unbind' : 'Delete'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setConfirmingId(null);
                    }}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {t.entityId ? t.name : `#${t.name}`}
                  </span>
                  {t.entityId ? (
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[0.7rem] text-muted-foreground">
                      Business
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {String(t.usageCount)} txn{t.usageCount === 1 ? '' : 's'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Rename ${t.name}`}
                    onClick={() => {
                      setEditingId(t.tagId);
                      setEditName(t.name);
                      setConfirmingId(null);
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      t.entityId ? `Unbind ${t.name} from its business` : `Delete ${t.name}`
                    }
                    title={
                      t.entityId
                        ? 'Unbind from the business (the tag and its transactions stay)'
                        : undefined
                    }
                    onClick={() => {
                      setConfirmingId(t.tagId);
                      setEditingId(null);
                    }}
                  >
                    {t.entityId ? (
                      <Link2Off className="size-3.5" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeAll}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
