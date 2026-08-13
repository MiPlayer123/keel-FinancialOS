'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { setRecurringAmount } from '@/lib/recurring';
import { parseSignedDollars } from '@/lib/hash';

/**
 * Correct a recurring series' expected per-occurrence amount (the amount
 * sibling of EditCadenceDialog — "everything editable"). The user enters a
 * positive dollar magnitude; the series direction supplies the sign (an
 * outflow subscription is stored negative, an inflow positive — same
 * convention the detector and occurrence renderer use), so a sign mistake is
 * structurally impossible here. Class B: explicit user action, audited,
 * reversible (edit again anytime; detection never clobbers a live series'
 * locked candidate).
 */
export function EditAmountDialog(props: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  seriesId: string;
  seriesLabel: string;
  sign: 'inflow' | 'outflow';
  /** Current expected amount, signed minor-units string (prefills the field). */
  currentAmountMinor: string | null;
  householdId: string;
  userId: string;
}) {
  const { open, onClose, onDone, seriesId, seriesLabel, sign, currentAmountMinor, householdId, userId } =
    props;
  const [amount, setAmount] = useState(() => {
    if (!currentAmountMinor) return '';
    const magnitude = currentAmountMinor.replace('-', '');
    const dollars = magnitude.slice(0, -2) || '0';
    const cents = magnitude.slice(-2).padStart(2, '0');
    return `${dollars}.${cents}`;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedMinor = useMemo(() => {
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') return null;
    return sign === 'outflow' ? `-${minor}` : minor;
  }, [amount, sign]);

  const submit = async () => {
    if (!signedMinor) return;
    setBusy(true);
    setError(null);
    try {
      await setRecurringAmount({ seriesId, amountMinor: signedMinor, householdId, userId });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the amount.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit expected amount</DialogTitle>
          <DialogDescription>
            What {seriesLabel} {sign === 'outflow' ? 'charges' : 'pays'} each time. This only
            changes KEEL&apos;s expectation and forecast — no money moves, and you can change it
            again anytime.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="edit-amount">Amount</Label>
          <Input
            id="edit-amount"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
            }}
          />
          {amount !== '' && signedMinor === null ? (
            <p className="text-xs text-keel-negative">Enter a positive amount.</p>
          ) : null}
        </div>
        {error ? <p className="text-sm text-keel-negative">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || signedMinor === null}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
