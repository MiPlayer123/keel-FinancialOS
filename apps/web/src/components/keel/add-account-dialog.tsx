'use client';

import { useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useHousehold } from '@/components/keel/household-context';
import {
  createManualAccount,
  fetchFirstEntityId,
  fetchOpeningBalancesLedgerId,
  postOpeningBalance,
} from '@/lib/keel-api';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SUBTYPES: { value: string; label: string; kind: 'asset' | 'liability' }[] = [
  { value: 'cash', label: 'Cash', kind: 'asset' },
  { value: 'checking', label: 'Checking', kind: 'asset' },
  { value: 'savings', label: 'Savings', kind: 'asset' },
  { value: 'property', label: 'Property / real estate', kind: 'asset' },
  { value: 'vehicle', label: 'Vehicle', kind: 'asset' },
  { value: 'other_asset', label: 'Other asset', kind: 'asset' },
  { value: 'credit_card', label: 'Credit card', kind: 'liability' },
  { value: 'loan', label: 'Loan / mortgage', kind: 'liability' },
  { value: 'other_liability', label: 'Other debt', kind: 'liability' },
];

/** Parse a user-entered dollar amount into non-negative minor units (Law 4). */
function dollarsToMinorString(input: string): string | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  return (BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0')).toString();
}

/**
 * Create a manual (non-Plaid) account, optionally booking a starting balance
 * as a balanced Opening Balances entry — so a house, car, cash stash or
 * private loan shows up in net worth immediately.
 */
export function AddAccountDialog({ onCreated }: { onCreated: () => void }) {
  const { householdId, userId } = useHousehold();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [subtype, setSubtype] = useState('cash');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);

  const spec =
    SUBTYPES.find((s) => s.value === subtype) ??
    ({ value: 'cash', label: 'Cash', kind: 'asset' } as const);

  async function create() {
    if (!householdId || !userId || name.trim().length === 0) return;
    setBusy(true);
    try {
      const entityId = await fetchFirstEntityId(householdId);
      if (!entityId) throw new Error('No entity found for this household.');
      const result = await createManualAccount({
        householdId,
        entityId,
        userId,
        name: name.trim(),
        kind: spec.kind,
        subtype: spec.value,
      });
      const ledgerAccountId = (result.effects as { ledgerAccountId?: string }).ledgerAccountId;

      const minor = balance.trim() ? dollarsToMinorString(balance) : null;
      let balanceNote = '';
      if (balance.trim() && minor === null) {
        balanceNote = ' The starting balance was not a valid amount — set it later.';
      } else if (minor && minor !== '0' && ledgerAccountId) {
        try {
          const openingLedgerId = await fetchOpeningBalancesLedgerId(householdId, entityId);
          if (!openingLedgerId) {
            balanceNote = ' Starting balance skipped (no Opening Balances account).';
          } else {
            // Debit-positive: assets hold +value, debts hold −value.
            await postOpeningBalance({
              householdId,
              userId,
              accountLedgerId: ledgerAccountId,
              openingLedgerId,
              amountMinor: spec.kind === 'liability' ? `-${minor}` : minor,
              accountName: name.trim(),
            });
          }
        } catch {
          // The account exists — never leave the dialog open where a retry
          // would create a duplicate.
          balanceNote = ' Starting balance failed to book — set it later.';
        }
      }
      if (balanceNote) toast.warning(`Added ${name.trim()}.${balanceNote}`);
      else toast.success(`Added ${name.trim()}.`);
      setOpen(false);
      setName('');
      setBalance('');
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Plus className="size-4" />
        Add account
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a manual account</DialogTitle>
            <DialogDescription>
              Track anything a bank connection can&apos;t — cash, property, a car, a
              private loan. It counts toward net worth right away.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="acct-name">Name</Label>
              <Input
                id="acct-name"
                value={name}
                maxLength={200}
                placeholder="e.g. Wallet cash, 2021 Honda Civic"
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={subtype}
                onValueChange={(v) => {
                  if (v) setSubtype(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUBTYPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acct-balance">
                {spec.kind === 'liability' ? 'Amount owed today' : 'Current value'} (optional)
              </Label>
              <Input
                id="acct-balance"
                value={balance}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(e) => {
                  setBalance(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Booked as a balanced Opening Balances entry — adjustable later.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || name.trim().length === 0}
              onClick={() => {
                void create();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Add account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
