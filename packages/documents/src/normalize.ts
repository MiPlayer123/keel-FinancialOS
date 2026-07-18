/**
 * Merchant string normalization for receipt→transaction matching.
 *
 * Bank descriptors ("SQ *BLUE BOTTLE 4421", "TST* Joe's Cafe", "PAYPAL *ETSY")
 * rarely equal the merchant header printed on a receipt ("Blue Bottle Coffee").
 * This strips the payment-processor prefixes and store-number/punctuation noise
 * the risk ladder already classes as an auto (class A) transform, then exposes
 * token-overlap and trigram similarity as pure string arithmetic (Law 1 — the
 * matcher never asks an LLM whether two strings are the same merchant).
 *
 * Pure: no I/O, no Supabase, no model. Deterministic — same input, same output.
 */

/**
 * Payment-processor / aggregator prefixes seen on card descriptors. Stripped so
 * "SQ *BLUE BOTTLE" and "Blue Bottle" compare on the same stem. Matched
 * case-insensitively at the START of the (uppercased) string only.
 */
const PROCESSOR_PREFIXES: readonly string[] = [
  'SQ *',
  'SQ*',
  'TST*',
  'TST *',
  'PAYPAL *',
  'PAYPAL*',
  'PP*',
  'PP *',
  'SP *',
  'SP*',
  'IN *',
  'IN *',
  'WWW.',
  'WWW ',
  'POS ',
  'PURCHASE ',
  'DEBIT ',
  'CKCD ',
];

/** Collapse runs of whitespace and trim. */
const collapseSpaces = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Normalize a merchant string to a comparison stem:
 *   uppercase → strip a leading processor prefix → drop trailing store numbers
 *   and reference codes → strip punctuation → collapse whitespace.
 * Purely lexical; the result is only ever compared to another normalized stem.
 */
export const normalizeMerchant = (raw: string): string => {
  let value = collapseSpaces(raw).toUpperCase();

  // Strip at most one leading processor prefix (longest match first so
  // "PAYPAL *" wins over "PP*" when both could apply on different strings).
  for (const prefix of [...PROCESSOR_PREFIXES].sort((a, b) => b.length - a.length)) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  // Drop a trailing store/reference number cluster ("... 4421", "#0231").
  value = value.replace(/[#*]?\d[\d-]*\s*$/u, '');
  // Strip remaining punctuation to spaces; keep alphanumerics and spaces.
  value = value.replace(/[^A-Z0-9 ]+/gu, ' ');
  return collapseSpaces(value);
};

/** Non-empty word tokens of a normalized stem. */
export const merchantTokens = (normalized: string): string[] =>
  normalized.length === 0 ? [] : normalized.split(' ').filter((t) => t.length > 0);

/**
 * Jaccard token overlap of two normalized merchant stems, in [0,1].
 * Empty on either side → 0 (no evidence, never a false positive).
 */
export const tokenOverlap = (aNorm: string, bNorm: string): number => {
  const a = new Set(merchantTokens(aNorm));
  const b = new Set(merchantTokens(bNorm));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  // Both sets are non-empty here (guarded above), so unionSize ≥ 1 always
  // (union ≥ max(|a|,|b|) ≥ 1) — no divide-by-zero guard needed.
  const unionSize = a.size + b.size - intersection;
  return intersection / unionSize;
};

/** Character trigrams of a normalized stem (spaces removed first). */
const trigrams = (normalized: string): Set<string> => {
  const compact = normalized.replace(/ /gu, '');
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= compact.length; i += 1) {
    grams.add(compact.slice(i, i + 3));
  }
  return grams;
};

/**
 * Trigram (Dice) similarity of two normalized stems, in [0,1]. Robust to token
 * reordering and minor spelling drift; complements tokenOverlap. Strings too
 * short for any trigram → 0.
 */
export const trigramSimilarity = (aNorm: string, bNorm: string): number => {
  const a = trigrams(aNorm);
  const b = trigrams(bNorm);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
};

/**
 * Best available fuzzy similarity between two RAW merchant strings, in [0,1]:
 * normalized-exact → 1; otherwise the max of token overlap and trigram Dice.
 */
export const merchantSimilarity = (aRaw: string, bRaw: string): number => {
  const a = normalizeMerchant(aRaw);
  const b = normalizeMerchant(bRaw);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  return Math.max(tokenOverlap(a, b), trigramSimilarity(a, b));
};
