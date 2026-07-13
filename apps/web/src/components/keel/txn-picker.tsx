'use client';

import { useMemo } from 'react';

import type { RichTransactionRow } from '@/lib/keel-api';
import { formatMoney } from '@/lib/money';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Pick one canonical transaction, filtered by direction. Options render as
 * "MM-DD · description · amount" (amount formatted from the BIGINT string).
 */
export function TxnPicker({
  rows,
  direction,
  value,
  onChange,
  placeholder,
}: {
  rows: RichTransactionRow[];
  direction: 'inflow' | 'outflow';
  value: string | null;
  onChange: (transactionId: string) => void;
  placeholder: string;
}) {
  const options = useMemo(
    () =>
      rows
        .filter((t) => {
          const v = BigInt(t.amountMinor || '0');
          return direction === 'inflow' ? v > 0n : v < 0n;
        })
        .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
        .slice(0, 200),
    [rows, direction],
  );

  const items = useMemo(
    () =>
      Object.fromEntries(
        options.map((t) => [
          t.transactionId,
          `${t.effectiveDate.slice(5)} · ${t.description.slice(0, 42)} · ${formatMoney(
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
            {t.effectiveDate.slice(5)} · {t.description.slice(0, 42)} ·{' '}
            {formatMoney(t.amountMinor, { currency: t.currency, signed: true })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
