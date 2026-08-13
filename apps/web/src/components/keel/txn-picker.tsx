'use client';

import { useMemo } from 'react';

import type { RichTransactionRow } from '@/lib/keel-api';
import { formatMoney } from '@/lib/money';
import { shortDateWithYear } from '@/lib/relative-date';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * A row is reimbursable only if the ledger can find a single real posting for
 * it: `keel_live_real_posting` requires status `posted`/`reviewed` and exactly
 * ONE real-account leg. A `pending` charge or a distribution transfer leg fails
 * that check and the reimbursement command raises KEEL_SCOPE_VIOLATION ("not
 * found"), which surfaces as a cryptic "Not found." toast. Filtering them out
 * of the picker is the fix — you can't tag what you can't reimburse yet.
 */
export function isReimbursableRow(t: RichTransactionRow): boolean {
  if (t.status === 'pending') return false;
  if (t.distributionTransfer) return false;
  return true;
}

/**
 * Pick one canonical transaction, filtered by direction. Options render as
 * "MM/DD/YY · description · amount" (amount formatted from the BIGINT
 * string) — the year is never dropped, since picking the wrong year's
 * transaction here is a real mistake, not just a display nicety.
 *
 * `eligibleOnly` additionally restricts to reimbursable rows (see
 * {@link isReimbursableRow}) so a pending charge can't be picked and then
 * rejected server-side. Returns the count of rows hidden for eligibility so the
 * caller can explain the omission.
 */
export function TxnPicker({
  rows,
  direction,
  value,
  onChange,
  placeholder,
  eligibleOnly = false,
}: {
  rows: RichTransactionRow[];
  direction: 'inflow' | 'outflow';
  value: string | null;
  onChange: (transactionId: string) => void;
  placeholder: string;
  eligibleOnly?: boolean;
}) {
  const options = useMemo(
    () =>
      rows
        .filter((t) => {
          const v = BigInt(t.amountMinor || '0');
          if (direction === 'inflow' ? v <= 0n : v >= 0n) return false;
          if (eligibleOnly && !isReimbursableRow(t)) return false;
          return true;
        })
        .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
        .slice(0, 200),
    [rows, direction, eligibleOnly],
  );

  const items = useMemo(
    () =>
      Object.fromEntries(
        options.map((t) => [
          t.transactionId,
          `${shortDateWithYear(t.effectiveDate)} · ${t.description.slice(0, 42)} · ${formatMoney(
            t.amountMinor,
            { currency: t.currency, signed: true },
          )}`,
        ]),
      ),
    [options],
  );

  return (
    <Select
      value={value ?? undefined}
      items={items}
      onValueChange={(v) => {
        if (v) onChange(v);
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((t) => (
          <SelectItem key={t.transactionId} value={t.transactionId}>
            {shortDateWithYear(t.effectiveDate)} · {t.description.slice(0, 42)} ·{' '}
            {formatMoney(t.amountMinor, { currency: t.currency, signed: true })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
