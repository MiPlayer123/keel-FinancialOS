'use client';

import { useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  bookTransferCounterparty,
  linkAndConfirmTransfer,
  type AccountRow,
  type RichTransactionRow,
} from '@/lib/keel-api';
import { maskAccountLabel } from '@/lib/account-label';
import { shortDateWithYear } from '@/lib/relative-date';
import { Money } from '@/components/keel/money';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * F-012 — Transfer counterparty flow. Picking the "Transfers" category is no
 * longer a one-sided tag: this step asks WHICH account the money moved to/from
 * and then makes the two sides a real, cash-flow-excluded transfer.
 *
 *   • MATCH  — an opposite transaction already exists on the chosen account
 *     (exact opposite amount, within ~7 days, not already linked): link the
 *     two and confirm in one call (linkAndConfirmTransfer). Typical for two
 *     synced accounts where both bank sides landed.
 *   • BOOK   — no opposite transaction exists (typical for a manual/
 *     unconnected account like a 401k or a cash jar): the server posts the
 *     opposite cash leg on that account and confirms the pairing
 *     (bookTransferCounterparty). Idempotent on the source transaction id.
 *
 * Deterministic matching only (Law 1: no LLM). The cash-flow exclusion then
 * flows through the existing confirmed-transfer_links mechanism.
 */

/** Opposite-transaction match window (days) — a hair wider than the detector's
 *  ±3 so the interactive flow can pick up a slightly slower float the batch
 *  detector skipped, still deterministic. */
const MATCH_WINDOW_DAYS = 7;

function dayGap(a: string, b: string): number {
  // Both are midnight-UTC dates, so the difference is an exact multiple of a
  // day — integer division (no rounding of money or otherwise).
  const ms = Math.abs(
    new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime(),
  );
  return Math.trunc(ms / 86_400_000);
}

/**
 * Best opposite-leg candidate on `accountId` for `source`: exact opposite
 * cash amount, same currency, not itself already part of a transfer, within
 * the window. Deterministic pick — nearest date, then transaction id.
 */
function findMatch(
  source: RichTransactionRow,
  accountId: string,
  rows: RichTransactionRow[],
): RichTransactionRow | null {
  const want = (-BigInt(source.amountMinor)).toString();
  const candidates = rows
    .filter(
      (r) =>
        r.accountId === accountId &&
        r.transactionId !== source.transactionId &&
        r.currency === source.currency &&
        r.amountMinor === want &&
        !r.transferStatus &&
        (r.splits?.length ?? 0) === 0 &&
        dayGap(r.effectiveDate, source.effectiveDate) <= MATCH_WINDOW_DAYS,
    )
    .sort((a, b) => {
      const ga = dayGap(a.effectiveDate, source.effectiveDate);
      const gb = dayGap(b.effectiveDate, source.effectiveDate);
      if (ga !== gb) return ga - gb;
      return a.transactionId < b.transactionId ? -1 : 1;
    });
  return candidates[0] ?? null;
}

export function TransferCounterpartyFlow({
  householdId,
  row,
  accounts,
  allRows,
  onDone,
  onCancel,
}: {
  householdId: string | null;
  /** The source transaction the user is filing as a transfer. */
  row: RichTransactionRow;
  accounts: AccountRow[];
  /** The household/account rows already loaded on the page, for match detection. */
  allRows: RichTransactionRow[];
  /** Called after a link/book succeeds (parent refetches). */
  onDone: () => void;
  /** Called when the user backs out (return to the plain category picker). */
  onCancel: () => void;
}) {
  const [counterpartyId, setCounterpartyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // P1-4: one idempotency nonce per book attempt. A retry of the SAME click
  // replays; a book→undo→re-book is a fresh attempt (regenerated on success).
  const bookAttemptKey = useRef(crypto.randomUUID());

  // Eligible counterparties: any live account in the same currency that isn't
  // the source's own account. Manual and connected both qualify — but the
  // action offered differs (P0-2): a CONNECTED account can only be MATCHED
  // (its side arrives on the bank feed); only a MANUAL account may be booked.
  const eligible = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.id !== row.accountId && a.currency === row.currency && a.archivedAt == null,
      ),
    [accounts, row.accountId, row.currency],
  );

  const match = useMemo(
    () => (counterpartyId ? findMatch(row, counterpartyId, allRows) : null),
    [counterpartyId, row, allRows],
  );
  const counterparty = accounts.find((a) => a.id === counterpartyId) ?? null;
  const accountItems = Object.fromEntries(eligible.map((a) => [a.id, a.name]));

  // P0-2: booking synthesizes a leg — NEVER do that onto a connected account,
  // the bank feed already delivers that side (double-posting the money). A
  // connected counterparty is actionable ONLY when a real opposite leg already
  // matched; otherwise the user leaves it unlinked until the next sync.
  const counterpartyConnected = counterparty?.connectionId != null;
  const canProceed = Boolean(counterpartyId) && (match !== null || !counterpartyConnected);

  async function confirm() {
    if (!householdId || !counterpartyId || !canProceed) return;
    setBusy(true);
    try {
      if (match) {
        await linkAndConfirmTransfer({
          householdId,
          txnA: row.transactionId,
          txnB: match.transactionId,
        });
        toast.success('Linked as a transfer — excluded from income and spending.');
      } else {
        // Reached only for a MANUAL counterparty (canProceed gate above).
        await bookTransferCounterparty({
          householdId,
          sourceTxnId: row.transactionId,
          counterpartyAccountId: counterpartyId,
          attemptKey: bookAttemptKey.current,
        });
        // Fresh nonce so a later book→undo→re-book isn't a stale replay.
        bookAttemptKey.current = crypto.randomUUID();
        toast.success(
          `Booked the other side on ${counterparty?.name ?? 'the account'} — balances move, nothing double-counts.`,
        );
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not record the transfer.');
    } finally {
      setBusy(false);
    }
  }

  const outbound = BigInt(row.amountMinor) < 0n;

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-2">
        <ArrowLeftRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 text-sm">
          <p className="font-medium">Where did this money {outbound ? 'go' : 'come from'}?</p>
          <p className="text-xs text-muted-foreground">
            A transfer moves money between your own accounts — it isn&apos;t income or
            spending. Pick the {outbound ? 'destination' : 'source'} account.
          </p>
        </div>
      </div>

      {eligible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No other {row.currency} account to transfer with. Add one, or keep the plain category.
        </p>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-xs">{outbound ? 'To account' : 'From account'}</Label>
          <Select
            value={counterpartyId ?? undefined}
            items={accountItems}
            onValueChange={(v) => {
              setCounterpartyId(v);
            }}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder="Choose an account" />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.connectionId == null ? ' · manual' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {counterpartyId ? (
        match ? (
          <div className="space-y-1 rounded-md border border-border bg-background px-3 py-2 text-sm">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 text-foreground" />
              Found the matching transaction on {counterparty?.name}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {shortDateWithYear(match.effectiveDate)} · {match.description}
              </span>
              <Money amountMinor={match.amountMinor} currency={match.currency} signed />
            </div>
            <p className="text-xs text-muted-foreground">
              Linking these two and confirming — both are excluded from cash flow.
            </p>
          </div>
        ) : counterpartyConnected ? (
          // P0-2: no match on a CONNECTED account — do NOT book (the bank feed
          // will deliver the other side). Tell the user it'll arrive on sync;
          // they leave it unlinked for now.
          <p className="text-xs text-muted-foreground">
            No matching transaction on {maskAccountLabel(counterparty.name, null)} yet.
            Since that account syncs with your bank, the other side of this transfer will
            arrive with the next sync — link them then. Nothing to book here.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No matching transaction on {maskAccountLabel(counterparty?.name ?? '', null)} yet —
            KEEL will book the other side there for you (
            <Money amountMinor={(-BigInt(row.amountMinor)).toString()} currency={row.currency} signed />
            ), so its balance moves and nothing double-counts.
          </p>
        )
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !canProceed}
          onClick={() => {
            void confirm();
          }}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {match ? 'Link transfer' : 'Book transfer'}
        </Button>
      </div>
    </div>
  );
}
