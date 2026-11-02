'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { setAccountArchived } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Remove a MANUAL account (e.g. a cash account, or one typed in before the
 * bank was linked). Soft delete: the account is archived and drops out of
 * balances and lists, but its transactions stay in the ledger and the toast
 * offers Undo. Linked accounts are removed by disconnecting the bank.
 */
export function RemoveAccountDialog({
  open,
  householdId,
  accountId,
  accountName,
  onClose,
  onRemoved,
}: {
  open: boolean;
  householdId: string | null;
  accountId: string;
  accountName: string;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['keel-query'] });

  async function remove() {
    if (!householdId) return;
    setSaving(true);
    try {
      await setAccountArchived({ householdId, accountId, archived: true });
      toast.success(`${accountName} removed.`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void setAccountArchived({ householdId, accountId, archived: false })
              .then(() => {
                refresh();
                toast.success(`${accountName} restored.`);
              })
              .catch((err: unknown) => {
                toast.error(err instanceof Error ? err.message : 'Could not restore the account.');
              });
          },
        },
      });
      refresh();
      onRemoved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the account.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {accountName}?</DialogTitle>
          <DialogDescription>
            It will disappear from your accounts, balances and net worth. Its transactions are kept,
            so you can undo this.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={saving}
            onClick={() => {
              void remove();
            }}
          >
            {saving ? 'Removing…' : 'Remove account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
