/**
 * Decimal-string → minor-unit conversion by PURE STRING MATH (Law 4: money is
 * BIGINT minor units; no floats — a float never enters the value path). The
 * only shared money primitive for the statement parsers, so CSV and OFX convert
 * identically and the round-trip property (parse∘format) is provable.
 *
 * The algorithm splits the cleaned decimal on '.', pads/truncates the fraction
 * to the currency scale, concatenates the integer and fraction digit runs, and
 * hands the resulting all-digits string to `BigInt`. No `Number`, no `parseF*`,
 * no multiplication by 100 — the conversion is textual, then a single BigInt.
 *
 * Everything defensive: unparseable input returns null (never throws), so a
 * hostile cell (`=cmd`, `$(rm)`, an emoji) degrades to an inert null the caller
 * annotates with a null_reason. Pure: no I/O, no Supabase, no model.
 */

/** Result of a money parse: the minor-unit string, or a typed failure reason. */
export type MoneyParse =
  | { readonly ok: true; readonly minor: string }
  | { readonly ok: false; readonly reason: 'empty' | 'unparseable' };

/** Minor-unit scale per ISO-4217 currency; default 2 for anything unlisted. */
const CURRENCY_SCALE: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  CLP: 0,
  VND: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

/** Minor-unit scale (decimal places) for a currency code; default 2. */
export const currencyScale = (currency: string | null): number => {
  if (currency === null) return 2;
  const code = currency.trim().toUpperCase();
  return CURRENCY_SCALE[code] ?? 2;
};

/** Guard: a run of ASCII digits (possibly empty). Used after cleaning. */
const DIGITS_ONLY = /^\d*$/u;

/**
 * Parse one raw money cell into a signed minor-unit decimal string. Accepts a
 * leading/trailing currency symbol, thousands separators (','), surrounding
 * whitespace, an explicit sign, and accounting-style parentheses for negatives
 * — `($1,234.56)` → "-123456" at scale 2. Anything else → an inert failure.
 *
 * String math only: the fraction is padded/truncated as TEXT, then the whole
 * digit run is passed to BigInt exactly once. `scale` decimals of over-precision
 * are truncated toward zero (never rounded — rounding money silently is a bug).
 */
export const parseMoneyToMinor = (raw: string, scale = 2): MoneyParse => {
  let s = raw.trim();
  if (s.length === 0) return { ok: false, reason: 'empty' };

  // Accounting parentheses => negative. Detect before stripping symbols.
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
    if (s.length === 0) return { ok: false, reason: 'unparseable' };
  }

  // Leading sign (a trailing '-' as in some exports is also honored).
  if (s.startsWith('-') || s.startsWith('+')) {
    if (s.startsWith('-')) negative = !negative;
    s = s.slice(1).trim();
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  // Strip a currency symbol / letters and thousands separators / spaces. We keep
  // only digits and at most one decimal point; anything else makes it hostile.
  // Remove common currency prefixes/suffixes and grouping commas + spaces.
  s = s.replace(/[\s,]/gu, '');
  s = s.replace(/^[$£€¥₩₹]/u, '').replace(/[$£€¥₩₹]$/u, '');

  if (s.length === 0) return { ok: false, reason: 'unparseable' };

  // At most one decimal point; split integer / fraction as pure text.
  const dotCount = (s.match(/\./gu) ?? []).length;
  if (dotCount > 1) return { ok: false, reason: 'unparseable' };
  // `s.split('.')` always yields at least one element, so intPart is a string.
  const [intPart = '', fracPartRaw = ''] = s.split('.');

  // After cleaning, both halves must be pure digits (rejects letters, symbols,
  // formula-injection payloads, unicode look-alikes) — inert null, no throw.
  if (!DIGITS_ONLY.test(intPart) || !DIGITS_ONLY.test(fracPartRaw)) {
    return { ok: false, reason: 'unparseable' };
  }
  // Nothing but a decimal point (or an empty run) → unparseable.
  if (intPart.length === 0 && fracPartRaw.length === 0) {
    return { ok: false, reason: 'unparseable' };
  }

  // Pad or truncate the fraction to `scale` digits, textually.
  let frac = fracPartRaw;
  if (frac.length < scale) {
    frac = frac.padEnd(scale, '0');
  } else if (frac.length > scale) {
    frac = frac.slice(0, scale); // truncate toward zero
  }

  // `digits` can still be empty — e.g. ".5" truncated to scale 0 leaves ''
  // (int empty + fraction truncated away). BigInt('') throws, so guard it.
  const digits = `${intPart}${frac}`;
  if (digits.length === 0) return { ok: false, reason: 'unparseable' };
  let value = BigInt(digits);
  if (negative && value !== 0n) value = -value;
  return { ok: true, minor: value.toString() };
};

/**
 * Format a minor-unit decimal string back to a plain decimal string at `scale`,
 * for the round-trip property test. Pure string math; null on bad input.
 */
export const formatMinorToDecimal = (minor: string, scale = 2): string | null => {
  if (!/^-?\d+$/u.test(minor)) return null;
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(scale + 1, '0');
  const cut = padded.length - scale;
  const intPart = padded.slice(0, cut);
  const fracPart = padded.slice(cut);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
};
