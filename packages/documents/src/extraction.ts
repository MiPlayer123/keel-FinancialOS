/**
 * Typed extraction record + parser (Law 11: material AI outputs are records).
 *
 * The vision model returns ONE thing we trust for meaning: the raw JSON of
 * fields it read off the receipt image. Everything structural — the stamp of
 * which extractor/version produced it, the confidence bounds — is enforced
 * here, in pure TS, so a malformed or hostile model response can only ever
 * become an inert, well-typed record or a rejection (never a write, never a
 * tool call — Law 5). Money is BIGINT minor units carried as a decimal STRING
 * end-to-end (Law 4: no floats).
 *
 * Pure: no I/O, no model, no Supabase.
 */

/** Boundary version stamp carried on every extraction (Law 9/11). */
export const EXTRACTOR_PROMPT_VERSION = 'keel-receipt-extract@v1';

export interface ReceiptExtraction {
  /** Merchant string exactly as read; inert data (Law 5). */
  readonly merchant: string | null;
  /** Total in minor units as a decimal string, or null if unread. */
  readonly totalMinor: string | null;
  /** ISO-4217 code, uppercased, or null. */
  readonly currency: string | null;
  /** Receipt date as YYYY-MM-DD, or null. */
  readonly txnDate: string | null;
  /** Model's self-reported confidence for the whole read, clamped to [0,1]. */
  readonly confidence: number;
}

export interface ExtractionRecord extends ReceiptExtraction {
  /** 'fixture' | 'claude:<model>' | 'ollama:<model>' — provenance. */
  readonly extractor: string;
  /** Prompt/policy version stamp. */
  readonly extractorVersion: string;
  /**
   * Verbatim model output, retained as evidence. NEVER interpreted as an
   * instruction; only stored and displayed (Law 5).
   */
  readonly rawEvidence: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Clamp any input to a finite number in [0,1]; non-numbers → 0. */
const clampConfidence = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const MERCHANT_MAX = 200;
const CURRENCY_RE = /^[A-Za-z]{3}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
/** A decimal integer string (minor units): optional sign, digits only. */
const MINOR_RE = /^-?\d{1,18}$/u;

const parseMerchant = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MERCHANT_MAX);
};

const parseCurrency = (value: unknown): string | null =>
  typeof value === 'string' && CURRENCY_RE.test(value.trim())
    ? value.trim().toUpperCase()
    : null;

const parseDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !DATE_RE.test(value.trim())) return null;
  const iso = value.trim();
  // Reject impossible civil dates (2026-13-40) without importing a date lib.
  const [y, m, d] = iso.split('-').map((p) => Number(p));
  if (y === undefined || m === undefined || d === undefined) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return iso;
};

/**
 * Money arrives as either a minor-unit integer string, a JS integer, or is
 * absent. A float (e.g. 42.17) is REJECTED to null — the model is instructed to
 * return minor units, and silently rounding a float here would violate Law 4.
 */
const parseTotalMinor = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return MINOR_RE.test(trimmed) ? String(BigInt(trimmed)) : null;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  return null;
};

/**
 * Parse a raw model response object into a typed ReceiptExtraction. Never
 * throws on bad data — unreadable fields become null (an inert extraction the
 * matcher will simply produce no suggestion for). The `rawEvidence` is the
 * caller's responsibility to attach; this only reads the typed fields.
 */
export const parseReceiptExtraction = (raw: unknown): ReceiptExtraction => {
  const root = asRecord(raw) ?? {};
  return {
    merchant: parseMerchant(root['merchant']),
    totalMinor: parseTotalMinor(root['totalMinor'] ?? root['total_minor']),
    currency: parseCurrency(root['currency']),
    txnDate: parseDate(root['txnDate'] ?? root['txn_date']),
    confidence: clampConfidence(root['confidence']),
  };
};

/**
 * Build the full extraction record: parse the trusted-for-meaning fields, stamp
 * provenance, and retain the verbatim response as inert evidence.
 */
export const buildExtractionRecord = (input: {
  readonly raw: Record<string, unknown>;
  readonly extractor: string;
  readonly extractorVersion: string;
}): ExtractionRecord => {
  const parsed = parseReceiptExtraction(input.raw);
  return {
    ...parsed,
    extractor: input.extractor,
    extractorVersion: input.extractorVersion,
    rawEvidence: input.raw,
  };
};
