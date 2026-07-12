import { cn } from '@/lib/utils';
import { formatMoney, isNegativeMinor, type FormatMoneyOptions } from '@/lib/money';

type MoneyProps = FormatMoneyOptions & {
  /** Signed decimal string of minor units, e.g. "150000" or "-250000". */
  amountMinor: string;
  className?: string;
  /** Dim to muted-foreground when the value is zero (default true). */
  muteZero?: boolean;
};

/**
 * Renders a monetary amount. Law 8: red is the ONLY money-signal color — negative
 * amounts are `--keel-negative`, everything else is plain foreground (never green).
 * Always mono + tabular-nums so columns of figures align.
 */
export function Money({
  amountMinor,
  currency = 'USD',
  signed,
  className,
  muteZero = true,
}: MoneyProps) {
  const negative = isNegativeMinor(amountMinor);
  const zero = BigInt(amountMinor.replace('-', '') || '0') === 0n;

  return (
    <span
      className={cn(
        'font-mono tabular-nums whitespace-nowrap',
        negative && 'text-keel-negative',
        zero && muteZero && 'text-muted-foreground',
        className,
      )}
    >
      {formatMoney(amountMinor, signed === undefined ? { currency } : { currency, signed })}
    </span>
  );
}
