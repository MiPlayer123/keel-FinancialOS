'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target, Plus, Loader2, Archive, ArchiveRestore, PiggyBank } from 'lucide-react';
import { toast } from 'sonner';

import { PageHeader, EmptyState } from '@/components/keel/page-header';
import { Money } from '@/components/keel/money';
import { useHousehold } from '@/components/keel/household-context';
import {
  contributeGoal,
  fetchAccounts,
  fetchGoals,
  fetchLatestBalances,
  fetchLedgerKinds,
  saveGoal,
  setGoalStatus,
  type AccountRow,
  type GoalRow,
} from '@/lib/keel-api';
import { minorToDollars, parseSignedDollars } from '@/lib/hash';
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
    <>
      <PageHeader
        title="Goals"
        description="Earmark money toward what's next — nothing moves, it's just spoken for."
      />
      <div className="p-6">
        <GoalsBody />
      </div>
    </>
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
  const [ledgerKinds, setLedgerKinds] = useState<Map<string, string>>(new Map());
  const [balances, setBalances] = useState<Map<string, string>>(new Map());
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
    void fetchLedgerKinds(householdId)
      .then(setLedgerKinds)
      .catch(() => {
        setLedgerKinds(new Map());
      });
    void fetchLatestBalances(householdId)
      .then((rows) => {
        setBalances(new Map(rows.map((r) => [r.accountId, r.currentMinor])));
      })
      .catch(() => {
        setBalances(new Map());
      });
  }, [householdId, load]);

  // Liability accounts only — a debt goal can't target an asset.
  const liabilityAccounts = useMemo(
    () => accounts.filter((a) => ledgerKinds.get(a.ledgerAccountId) === 'liability'),
    [accounts, ledgerKinds],
  );

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
        liabilityAccounts={liabilityAccounts}
        balances={balances}
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

  const isDebt = goal.kind === 'debt';
  const saved = BigInt((isDebt ? goal.paidMinor : goal.savedMinor) || '0');
  const target = BigInt(goal.targetMinor || '1');
  const pct = Number((saved * 100n) / target);
  const remaining = target - saved;

  const monthly = useMemo(() => {
    if (isDebt || !goal.targetDate || remaining <= 0n) return null;
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
              <Money amountMinor={isDebt ? (goal.paidMinor ?? '0') : goal.savedMinor} currency={goal.currency} className="text-xs" />{' '}
              of <Money amountMinor={goal.targetMinor} currency={goal.currency} className="text-xs" />
              {isDebt ? ' paid off' : ''}
              {goal.targetDate ? ` · by ${goal.targetDate}` : ''}
            </p>
            {isDebt ? (
              <p className="text-xs text-muted-foreground">
                Current balance:{' '}
                <Money amountMinor={goal.currentBalanceMinor ?? '0'} currency={goal.currency} className="text-xs" />
              </p>
            ) : null}
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

        {isDebt && goal.status !== 'archived' ? (
          <p className="text-xs text-muted-foreground">
            Progress updates automatically as the account balance changes.
          </p>
        ) : null}

        {goal.status !== 'archived' && !isDebt ? (
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
  liabilityAccounts,
  balances,
  onClose,
  onSaved,
}: {
  open: boolean;
  householdId: string | null;
  accounts: AccountRow[];
  liabilityAccounts: AccountRow[];
  balances: Map<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<'savings' | 'debt'>('savings');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [targetTouched, setTargetTouched] = useState(false);
  const [targetDate, setTargetDate] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accountChoices = kind === 'debt' ? liabilityAccounts : accounts;

  function resetForm() {
    setKind('savings');
    setName('');
    setTarget('');
    setTargetTouched(false);
    setTargetDate('');
    setAccountId(null);
  }

  function pickKind(next: 'savings' | 'debt') {
    setKind(next);
    setAccountId(null);
    setTargetTouched(false);
    if (next === 'savings') setTarget('');
  }

  function pickAccount(id: string | null) {
    setAccountId(id);
    // Debt goals default the target to the account's current balance — a
    // sensible "pay it off" default that stays fully editable.
    if (kind === 'debt' && id && !targetTouched) {
      const currentMinor = balances.get(id);
      if (currentMinor) setTarget(minorToDollars(currentMinor));
    }
  }

  async function save() {
    if (!householdId) return;
    if (kind === 'debt' && !accountId) {
      toast.error('Choose the liability account to pay down.');
      return;
    }
    const minor = parseSignedDollars(target);
    // A debt target above the current balance is unachievable (progress is
    // capped by the balance captured at creation) — the server refuses it;
    // say it clearly here first.
    if (kind === 'debt' && accountId && minor !== null) {
      const bal = balances.get(accountId);
      if (bal !== undefined && BigInt(minor) > BigInt(bal.replace('-', '') || '0')) {
        toast.error('Target is more than what you owe on that account.');
        return;
      }
    }
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
        kind,
      });
      toast.success(kind === 'debt' ? 'Debt goal created.' : 'Goal created — start earmarking.');
      resetForm();
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
            {kind === 'debt'
              ? "Debt goals track themselves — progress comes straight from the account's balance."
              : "Earmarks are bookkeeping, not transfers — your balances never change, KEEL just tracks what's spoken for."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={kind === 'savings' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => {
                  pickKind('savings');
                }}
              >
                Savings
              </Button>
              <Button
                type="button"
                variant={kind === 'debt' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => {
                  pickKind('debt');
                }}
              >
                Pay down debt
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-name">Name</Label>
            <Input
              id="goal-name"
              value={name}
              maxLength={80}
              placeholder={kind === 'debt' ? 'e.g. Payoff — Visa' : 'e.g. Emergency fund'}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          {kind === 'debt' ? (
            <div className="space-y-1.5">
              <Label>Account to pay down</Label>
              <Select
                value={accountId ?? undefined}
                items={Object.fromEntries(liabilityAccounts.map((a) => [a.id, a.name]))}
                onValueChange={(v) => {
                  pickAccount(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Liability account" />
                </SelectTrigger>
                <SelectContent>
                  {liabilityAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {liabilityAccounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No liability accounts found — connect a credit card or loan account first.
                </p>
              ) : null}
            </div>
          ) : null}
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
                  setTargetTouched(true);
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
          {kind === 'savings' ? (
          <div className="space-y-1.5">
            <Label>Lives in (optional)</Label>
            <Select
              value={accountId ?? undefined}
              items={Object.fromEntries(accountChoices.map((a) => [a.id, a.name]))}
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
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              name.trim().length === 0 ||
              !target.trim() ||
              (kind === 'debt' && !accountId)
            }
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
