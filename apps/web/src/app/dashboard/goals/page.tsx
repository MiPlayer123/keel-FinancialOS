'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, Plus, Loader2, Archive, ArchiveRestore, PiggyBank } from 'lucide-react';
import { toast } from 'sonner';

import { AppShell } from '@/components/keel/app-shell';
import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import {
  contributeGoal,
  fetchAccounts,
  fetchGoals,
  saveGoal,
  setGoalStatus,
  type AccountRow,
  type GoalRow,
} from '@/lib/keel-api';
import { parseSignedDollars } from '@/lib/hash';
import { formatMoney } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function GoalsPage() {
  return (
    <AppShell>
      <PageHeader
        title="Goals"
        description="Earmark money toward what's next — nothing moves, it's just spoken for."
      />
      <div className="p-6">
        <GoalsBody />
      </div>
    </AppShell>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole months from today to the target (≥1 when the date is ahead). */
function monthsUntil(targetDate: string): number {
  const now = new Date();
  const [y = 0, m = 0] = targetDate.split('-').map(Number);
  const months = (y - now.getUTCFullYear()) * 12 + (m - 1 - now.getUTCMonth());
  return Math.max(months, 1);
}

function GoalsBody() {
  const { householdId, ready } = useHousehold();
  const [goals, setGoals] = useState<GoalRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    if (!householdId) return;
    fetchGoals(householdId)
      .then(setGoals)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        if (/unknown query|does not exist|not_found/i.test(msg)) {
          setAvailable(false);
        } else {
          setGoals([]);
          toast.error(msg || 'Could not load goals.');
        }
      });
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    load();
    void fetchAccounts(householdId)
      .then(setAccounts)
      .catch(() => {
        setAccounts([]);
      });
  }, [householdId, load]);

  if (!ready || (goals === null && available)) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }
  if (!available) {
    return (
      <EmptyState
        icon={<Target className="size-6" />}
        title="Goals aren't available yet"
        description="The backend for goals hasn't been deployed to this environment."
      />
    );
  }

  const rows = goals ?? [];
  const visible = rows.filter((g) => (showArchived ? true : g.status !== 'archived'));
  const archivedCount = rows.filter((g) => g.status === 'archived').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {visible.length === 0
            ? 'Name a target and start earmarking toward it.'
            : `${String(visible.filter((g) => g.status === 'reached').length)} of ${String(
                visible.length,
              )} reached`}
        </p>
        <span className="flex items-center gap-2">
          {archivedCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setShowArchived((v) => !v);
              }}
            >
              {showArchived ? 'Hide archived' : `Archived (${String(archivedCount)})`}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" />
            New goal
          </Button>
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<PiggyBank className="size-6" />}
          title="No goals yet"
          description="An emergency fund, a trip, a down payment — set the target and KEEL tracks how much of your money is spoken for."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {visible.map((g) => (
            <GoalCard key={g.goalId} goal={g} householdId={householdId} onChanged={load} />
          ))}
        </div>
      )}

      <GoalDialog
        open={adding}
        householdId={householdId}
        accounts={accounts}
        onClose={() => {
          setAdding(false);
        }}
        onSaved={() => {
          setAdding(false);
          load();
        }}
      />
    </div>
  );
}

function GoalCard({
  goal,
  householdId,
  onChanged,
}: {
  goal: GoalRow;
  householdId: string | null;
  onChanged: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<'add' | 'withdraw' | 'status' | null>(null);

  const saved = BigInt(goal.savedMinor || '0');
  const target = BigInt(goal.targetMinor || '1');
  const pct = Number((saved * 100n) / target);
  const remaining = target - saved;

  const monthly = useMemo(() => {
    if (!goal.targetDate || remaining <= 0n) return null;
    const months = monthsUntil(goal.targetDate);
    // Ceiling division keeps the plan honest (Law 4 — integer math).
    return ((remaining + BigInt(months) - 1n) / BigInt(months)).toString();
  }, [goal.targetDate, remaining]);

  async function move(direction: 1n | -1n) {
    if (!householdId) return;
    const minor = parseSignedDollars(amount);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive amount.');
      return;
    }
    setBusy(direction === 1n ? 'add' : 'withdraw');
    try {
      const res = await contributeGoal({
        householdId,
        goalId: goal.goalId,
        amountMinor: (direction * BigInt(minor)).toString(),
        contributedOn: todayIso(),
      });
      setAmount('');
      if (res.status === 'reached') {
        toast.success(`${goal.name} reached — nice.`);
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the goal.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchive() {
    if (!householdId) return;
    setBusy('status');
    try {
      await setGoalStatus({
        householdId,
        goalId: goal.goalId,
        status: goal.status === 'archived' ? 'active' : 'archived',
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the goal.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className={goal.status === 'archived' ? 'opacity-60' : ''}>
      <CardContent className="space-y-3 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{goal.name}</p>
            <p className="text-xs text-muted-foreground">
              <Money amountMinor={goal.savedMinor} currency={goal.currency} className="text-xs" />{' '}
              of <Money amountMinor={goal.targetMinor} currency={goal.currency} className="text-xs" />
              {goal.targetDate ? ` · by ${goal.targetDate}` : ''}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1">
            {goal.status === 'reached' ? <Badge variant="secondary">Reached</Badge> : null}
            {goal.status === 'archived' ? <Badge variant="outline">Archived</Badge> : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={goal.status === 'archived' ? 'Restore goal' : 'Archive goal'}
              title={goal.status === 'archived' ? 'Restore' : 'Archive'}
              disabled={busy !== null}
              onClick={() => {
                void toggleArchive();
              }}
            >
              {goal.status === 'archived' ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
            </Button>
          </span>
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${String(Math.min(pct, 100))}%` }}
          />
        </div>

        {monthly !== null ? (
          <p className="text-xs text-muted-foreground">
            {formatMoney(monthly, { currency: goal.currency })}/month gets there on time.
          </p>
        ) : null}

        {goal.status !== 'archived' ? (
          <div className="flex items-center gap-2">
            <Input
              inputMode="decimal"
              placeholder="0.00"
              className="h-8 w-28 text-sm"
              aria-label={`Amount for ${goal.name}`}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8"
              disabled={busy !== null || !amount.trim()}
              onClick={() => {
                void move(1n);
              }}
            >
              {busy === 'add' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Add
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              disabled={busy !== null || !amount.trim() || saved === 0n}
              onClick={() => {
                void move(-1n);
              }}
            >
              {busy === 'withdraw' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Withdraw
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function GoalDialog({
  open,
  householdId,
  accounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string | null;
  accounts: AccountRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!householdId) return;
    const minor = parseSignedDollars(target);
    if (minor === null || minor.startsWith('-') || minor === '0') {
      toast.error('Enter a positive target.');
      return;
    }
    setBusy(true);
    try {
      await saveGoal({
        householdId,
        name: name.trim(),
        targetMinor: minor,
        targetDate: targetDate || null,
        accountId,
      });
      toast.success('Goal created — start earmarking.');
      setName('');
      setTarget('');
      setTargetDate('');
      setAccountId(null);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the goal.');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New goal</DialogTitle>
          <DialogDescription>
            Earmarks are bookkeeping, not transfers — your balances never change,
            KEEL just tracks what&apos;s spoken for.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={name}
              maxLength={80}
              placeholder="e.g. Emergency fund"
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="goal-target">Target</Label>
              <Input
                id="goal-target"
                inputMode="decimal"
                placeholder="0.00"
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-date">By (optional)</Label>
              <Input
                id="goal-date"
                type="date"
                value={targetDate}
                onChange={(e) => {
                  setTargetDate(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Lives in (optional)</Label>
            <Select
              value={accountId ?? undefined}
              items={Object.fromEntries(accounts.map((a) => [a.id, a.name]))}
              onValueChange={(v) => {
                setAccountId(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Account the money sits in" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || name.trim().length === 0 || !target.trim()}
            onClick={() => {
              void save();
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
