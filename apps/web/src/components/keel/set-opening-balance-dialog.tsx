'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { setAccountOpeningBalance } from '@/lib/keel-api';
import { parseSignedDollars } from '@/lib/hash';
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

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * "As of [date], this account's balance was $X" — a one-time statement that
 * anchors the running balance for an account whose synced history doesn't
 * reach back far enough (Plaid only backfills ~30 days). Posts a single
 * balanced entry against the entity's Opening Balances account; re-opening
 * this dialog and saving again CORRECTS the prior entry (server reverses +
 * reposts) rather than creating a duplicate — no separate "edit" flow needed.
 */
export function SetOpeningBalanceDialog({
  open,
  householdId,
  userId,
  accountId,
  accountName,
  accountKind,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string | null;
  userId: string | null;
  accountId: string;
  accountName: string;
  accountKind: string;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isLiability = accountKind === 'liability';
  const [balance, setBalance] = useState('');
  const [asOfDate, setAsOfDate] = useState(todayIso);
  const [busy, setBusy] = useState(false);

  // Reset to a clean slate each time the dialog opens.
  useEffect(() => {
    if (open) {
      setBalance('');
      setAsOfDate(todayIso());
    }
  }, [open]);

  async function save() {
    if (!householdId || !userId) return;
    if (!asOfDate) {
      toast.error('Pick a date.');
      return;
    }
    // Non-negative real-world magnitude only (matches the add-account-dialog
    // starting-balance field): the account kind, not a typed sign, decides
    // what "balance" means. The server applies the debit-positive flip for
    // liabilities (Law 4: no float math, BigInt on integer strings only).
    const minor = parseSignedDollars(balance);
    if (minor === null || minor.startsWith('-')) {
      toast.error('Enter a non-negative amount.');
      return;
    }
    setBusy(true);
    try {
      await setAccountOpeningBalance({
        householdId,
        userId,
        accountId,
        balanceMinor: minor,
        asOfDate,
      });
      toast.success('Opening balance set.');
      onSaved();
    } catch (err) {
      // The server's typed error already explains WHY (e.g. "this account
      // already has a transaction on or before that date") — surface it
      // verbatim rather than a generic failure message.
      toast.error(err instanceof Error ? err.message : 'Could not set the opening balance.');
    } finally {
      setBusy(false);
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
          <DialogTitle>Set opening balance</DialogTitle>
          <DialogDescription>
            Anchor {accountName}&apos;s running balance to a real statement — useful when synced
            history doesn&apos;t reach back far enough. Booked as a balanced Opening Balances
            entry; setting it again corrects the prior entry.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="opening-balance-amount">
              {isLiability ? 'Amount owed as of this date' : 'Balance as of this date'}
            </Label>
            <Input
              id="opening-balance-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={balance}
              onChange={(e) => {
                setBalance(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">{currency}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="opening-balance-date">As of</Label>
            <Input
              id="opening-balance-date"
              type="date"
              max={todayIso()}
              value={asOfDate}
              onChange={(e) => {
                setAsOfDate(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Must be on or before the earliest transaction already recorded for this account.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !balance.trim() || !asOfDate}
            onClick={() => {
              void save();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
