export type CurrencyAmount = {
  amountMinor: string;
  currency: string;
};

export type CurrencyTotal = CurrencyAmount & {
  rowCount: number;
};

export function currencyTotals(rows: readonly CurrencyAmount[]): CurrencyTotal[] {
  const totals = new Map<string, { amountMinor: bigint; rowCount: number; order: number }>();

  for (const [index, row] of rows.entries()) {
    const current = totals.get(row.currency);
    totals.set(row.currency, {
      amountMinor: (current?.amountMinor ?? 0n) + BigInt(row.amountMinor || '0'),
      rowCount: (current?.rowCount ?? 0) + 1,
      order: current?.order ?? index,
    });
  }

  return [...totals.entries()]
    .sort(([, a], [, b]) => b.rowCount - a.rowCount || a.order - b.order)
    .map(([currency, total]) => ({
      amountMinor: total.amountMinor.toString(),
      currency,
      rowCount: total.rowCount,
    }));
}

export function primaryCurrencyTotal(
  rows: readonly CurrencyAmount[],
): CurrencyTotal | null {
  return currencyTotals(rows)[0] ?? null;
}
