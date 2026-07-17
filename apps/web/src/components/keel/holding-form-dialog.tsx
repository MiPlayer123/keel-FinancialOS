'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { computeHoldingValueMinor } from '@/lib/holdings-math';
import { deleteHolding, upsertHolding, type HoldingRow } from '@/lib/keel-api';
import { Money } from '@/components/keel/money';
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

/** Parse a user-entered dollar amount into non-negative minor units (Law 4). */
function dollarsToMinorString(input: string): string | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  return (BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0')).toString();
}

/** Exact inverse of dollarsToMinorString — BigInt only, never round-trips
 *  money through a JS float (Law 4). */
function minorToDollarsString(minor: string): string {
  const negative = minor.startsWith('-');
  const n = BigInt(negative ? minor.slice(1) : minor);
  const whole = n / 100n;
  const cents = (n % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${cents}`;
}

/**
 * Create or edit a manual holding. Plaid-synced rows never open this dialog
 * (S-inv-1b's sync owns them entirely) — `editing` is always a
 * `source: 'manual'` row or null.
 */
export function HoldingFormDialog({
  open,
  householdId,
  accountId,
  currency,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string | null;
  accountId: string;
  currency: string;
  editing: HoldingRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSymbol(editing?.symbol ?? '');
    setName(editing?.name ?? '');
    setQty(editing?.qty ?? '');
    setPrice(editing ? minorToDollarsString(editing.priceMinor) : '');
    setCostBasis(editing?.costBasisMinor ? minorToDollarsString(editing.costBasisMinor) : '');
  }, [open, editing]);

  const priceMinor = price.trim() ? dollarsToMinorString(price) : null;
  const costBasisMinor = costBasis.trim() ? dollarsToMinorString(costBasis) : null;
  const previewValueMinor = priceMinor && qty.trim() ? computeHoldingValueMinor(qty, priceMinor) : null;
  const qtyValid = /^\d+(\.\d{1,8})?$/.test(qty.trim()) && Number(qty) > 0;

  async function save() {
    if (!householdId || symbol.trim().length === 0 || !qtyValid || priceMinor === null) return;
    if (costBasis.trim() && costBasisMinor === null) {
      toast.error('Cost basis is not a valid amount.');
      return;
    }
    setSaving(true);
    try {
      await upsertHolding({
        householdId,
        accountId,
        symbol: symbol.trim(),
        qty: qty.trim(),
        priceMinor,
        ...(editing ? { holdingId: editing.holdingId } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(costBasisMinor ? { costBasisMinor } : {}),
      });
      toast.success(editing ? 'Holding updated.' : 'Holding added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the holding.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!householdId || !editing) return;
    setDeleting(true);
    try {
      await deleteHolding({ householdId, holdingId: editing.holdingId });
      toast.success('Holding removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the holding.');
    } finally {
      setDeleting(false);
    }
  }

  const busy = saving || deleting;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit holding' : 'Add a holding'}</DialogTitle>
          <DialogDescription>
            A position in this account — shares and a price, not a transaction. Doesn&apos;t change
            the account&apos;s balance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="holding-symbol">Symbol</Label>
              <Input
                id="holding-symbol"
                value={symbol}
                maxLength={20}
                placeholder="VTI"
                onChange={(e) => {
                  setSymbol(e.target.value.toUpperCase());
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="holding-name">Name (optional)</Label>
              <Input
                id="holding-name"
                value={name}
                maxLength={200}
                placeholder="Vanguard Total Market"
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="holding-qty">Shares</Label>
              <Input
                id="holding-qty"
                value={qty}
                inputMode="decimal"
                placeholder="10"
                onChange={(e) => {
                  setQty(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="holding-price">Price per share</Label>
              <Input
                id="holding-price"
                value={price}
                inputMode="decimal"
                placeholder="150.42"
                onChange={(e) => {
                  setPrice(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="holding-cost-basis">Cost basis (optional)</Label>
            <Input
              id="holding-cost-basis"
              value={costBasis}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => {
                setCostBasis(e.target.value);
              }}
            />
          </div>
          {previewValueMinor ? (
            <p className="text-sm text-muted-foreground">
              Value: <Money amountMinor={previewValueMinor} currency={currency} className="text-sm" />
            </p>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          {editing ? (
            <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
              {deleting ? 'Removing…' : 'Remove'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy || symbol.trim().length === 0 || !qtyValid || priceMinor === null}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
