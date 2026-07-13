'use client';

import { useState } from 'react';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useHousehold } from '@/components/keel/household-context';
import { keelCommand, newId, type AccountRow } from '@/lib/keel-api';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Record a transfer between two of your own accounts as one balanced batch
 * with two CASH postings (debit-positive: money leaves one, arrives at the
 * other). No income/expense offsets are involved, so it can never
 * double-count in cash flow — and net worth is unchanged, as a transfer
 * should be. Rides journal.post_batch (already live).
 */
export function RecordTransferDialog({
  accounts,
  onDone,
}: {
  accounts: AccountRow[];
  onDone: () => void;
}) {
  const { householdId, userId } = useHousehold();
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  const accountItems = Object.fromEntries(accounts.map((a) => [a.id, a.name]));

  async function record() {
    if (!householdId || !userId || !from || !to || from.id === to.id) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    if (from.currency !== to.currency) {
      toast.error('Both accounts must use the same currency.');
      return;
    }
    setBusy(true);
    try {
      const commandId = newId();
      await keelCommand({
        commandId,
        command: 'journal.post_batch',
        economicEventKey: `journal.post_batch:transfer:${commandId}`,
        actor: { kind: 'user', userId },
        householdId,
        payload: {
          description: `Transfer: ${from.name} → ${to.name}`,
          effectiveDate: date,
          postings: [
            { ledgerAccountId: from.ledgerAccountId, amountMinor: `-${minor}`, currency: from.currency },
            { ledgerAccountId: to.ledgerAccountId, amountMinor: minor, currency: to.currency },
          ],
        },
      });
      toast.success('Transfer recorded — balances updated, nothing double-counted.');
      setOpen(false);
      setFromId(null);
      setToId(null);
      setAmount('');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the transfer.');
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
        <ArrowLeftRight className="size-4" />
        Record transfer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record a transfer</DialogTitle>
            <DialogDescription>
              Move money between your own accounts — pay a card, sweep to savings, top
              up cash. Balances move; income and spending don&apos;t.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>From</Label>
                <Select
                  value={fromId ?? undefined}
                  items={accountItems}
                  onValueChange={(v) => {
                    setFromId(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Source account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id} disabled={a.id === toId}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>To</Label>
                <Select
                  value={toId ?? undefined}
                  items={accountItems}
                  onValueChange={(v) => {
                    setToId(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Destination account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id} disabled={a.id === fromId}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tf-amount">Amount</Label>
                <Input
                  id="tf-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tf-date">Date</Label>
                <Input
                  id="tf-date"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              For synced accounts the bank versions of both sides will also arrive — the
              transfer detector pairs and excludes them automatically. Use this mainly
              for manual accounts (cash, private loans).
            </p>
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
              disabled={busy || !fromId || !toId || fromId === toId || !amount.trim() || !date}
              onClick={() => {
                void record();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
