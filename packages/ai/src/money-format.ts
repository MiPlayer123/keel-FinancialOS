/**
 * Deterministic minor-unit → display formatting for prompt rendering.
 *
 * Law 1/Law 4: the model must never divide minor units itself, so the prompt
 * builder pre-renders every amount as a display string. Pure string/BigInt
 * manipulation — no floats, no locale dependence.
 */

/** Currencies whose minor unit is not 1/100 of the major unit. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

const exponentFor = (currency: string): number => CURRENCY_EXPONENTS[currency] ?? 2;

/**
 * Format a signed decimal string of minor units, e.g.
 * `formatMinorAmount('-128455', 'USD')` → `'-1284.55 USD'`.
 * Throws on non-integer input (fail closed — never guess at money).
 */
export const formatMinorAmount = (amountMinor: string, currency: string): string => {
  if (!/^-?\d+$/.test(amountMinor)) {
    throw new Error(`invalid minor-unit amount: ${JSON.stringify(amountMinor)}`);
  }
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).replace(/^0+(?=\d)/, '');
  const exp = exponentFor(currency);
  if (exp === 0) return `${negative ? '-' : ''}${digits} ${currency}`;
  const padded = digits.padStart(exp + 1, '0');
  const major = padded.slice(0, -exp);
  const fraction = padded.slice(-exp);
  const isZero = /^0*$/.test(digits);
  return `${negative && !isZero ? '-' : ''}${major}.${fraction} ${currency}`;
};
