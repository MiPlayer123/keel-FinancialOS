'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { EntityPicker } from '@/components/keel/entity-picker';
import { fetchEntities, reassignAccountEntity, type EntityRow } from '@/lib/keel-api';
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

/**
 * Move an account (manual or Plaid-connected) to a different entity — the
 * repair path for a connection that landed under the wrong books at connect
 * time (docs/harness/plans/entities-investments-transfers.md, ENTITY-2).
 * Every entity-scoped view resolves from the account's current entity, so
 * this moves the account's FULL transaction history, not just new activity
 * — the correct behavior for correcting a mistake (see the migration for
 * the reasoning and what stays untouched at the raw-ledger level).
 */
export function ReassignEntityDialog({
  open,
  householdId,
  accountId,
  currentEntityId,
  onClose,
  onReassigned,
}: {
  open: boolean;
  householdId: string | null;
  accountId: string;
  currentEntityId: string;
  onClose: () => void;
  onReassigned: () => void;
}) {
  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [entityId, setEntityId] = useState(currentEntityId);
  const [saving, setSaving] = useState(false);
  const [creatingEntity, setCreatingEntity] = useState(false);

  useEffect(() => {
    if (!open || !householdId) return;
    setEntityId(currentEntityId);
    let cancelled = false;
    fetchEntities(householdId)
      .then((rows) => {
        if (!cancelled) setEntities(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load entities.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, householdId, currentEntityId]);

  async function save() {
    if (!householdId) return;
    if (entityId === currentEntityId) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await reassignAccountEntity({ householdId, accountId, entityId });
      toast.success('Account moved to the new entity.');
      onReassigned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move the account.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change entity</DialogTitle>
          <DialogDescription>
            Move this account — and its full transaction history — to a different entity&apos;s
            books. Use this to correct an account that was connected under the wrong entity.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Entity</Label>
          {householdId && entities ? (
            <EntityPicker
              householdId={householdId}
              entities={entities}
              value={entityId}
              onChange={setEntityId}
              onEntityCreated={(created) => {
                setEntities((prev) => [...(prev ?? []), created]);
              }}
              onCreatingNewChange={setCreatingEntity}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={saving || !entityId || creatingEntity}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
