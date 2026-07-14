'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { renameAccount } from '@/lib/keel-api';
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
import { Label } from '@/components/ui/label';

/**
 * Rename a real-world account (checking, card, …). Plain user-owned metadata
 * edit — not an AI action, so no suggest/approve gate applies (Law 2 only
 * requires the mutation to hit audit_log, which keel_rename_account does).
 */
export function RenameAccountDialog({
  open,
  householdId,
  accountId,
  currentName,
  onClose,
  onRenamed,
}: {
  open: boolean;
  householdId: string | null;
  accountId: string;
  currentName: string;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  async function save() {
    if (!householdId) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (trimmed === currentName) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await renameAccount({ householdId, accountId, name: trimmed });
      toast.success('Account renamed.');
      onRenamed();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename the account.');
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
          <DialogTitle>Rename account</DialogTitle>
          <DialogDescription>
            Change how this account&apos;s name appears throughout KEEL.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="account-name">Name</Label>
          <Input
            id="account-name"
            value={name}
            maxLength={200}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void save();
            }}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
