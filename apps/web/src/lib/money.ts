/**
 * Money formatting for KEEL. Amounts arrive from the backend as signed decimal
 * strings of BIGINT minor units (e.g. "150000" = $1,500.00, "-250000" = −$2,500.00).
 * Never parse them as floats (Law 4) — format from the integer string with BigInt.
 */

const MINOR_DIGITS: Record<string, number> = { USD: 2 };

export type FormatMoneyOptions = {
  currency?: string;
  /** Show a leading + for positive amounts (default false). */
  signed?: boolean;
};

export function formatMoney(amountMinor: string, options: FormatMoneyOptions = {}): string {
  const currency = options.currency ?? 'USD';
  const digits = MINOR_DIGITS[currency] ?? 2;

  const negative = amountMinor.trim().startsWith('-');
  const magnitude = BigInt(amountMinor.replace('-', '') || '0');

  const divisor = 10n ** BigInt(digits);
  const whole = magnitude / divisor;
  const frac = magnitude % divisor;

  const wholeGrouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = digits > 0 ? '.' + frac.toString().padStart(digits, '0') : '';

  const symbol = currency === 'USD' ? '$' : '';
  const body = `${symbol}${wholeGrouped}${fracStr}`;

  if (negative) return `−${body}`;
  if (options.signed && magnitude > 0n) return `+${body}`;
  return body;
}

export function isNegativeMinor(amountMinor: string): boolean {
  return amountMinor.trim().startsWith('-') && BigInt(amountMinor.replace('-', '') || '0') > 0n;
}
