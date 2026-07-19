/**
 * Statement content sniffer (KEEL statement ingestion SLICE 4 — [A9]).
 *
 * CLAUDE.md Law 5: every ingested statement byte stream is DATA-TIER. It can
 * never be trusted to describe itself. Neither the file extension nor the
 * client-declared MIME type is evidence — a `.csv`-named file can carry PDF or
 * executable bytes, and `application/octet-stream` is the empty claim. This
 * module inspects the actual bytes (magic numbers + light structural probe)
 * and returns a POSITIVE classification only when the content itself proves
 * the format. Anything it cannot positively identify is `null` → the caller
 * quarantines it and never promotes/serves it.
 *
 * Pure: bytes in, verdict out. No Storage, no fetch, no rpc, no throw-into-
 * guess. Safe to import from the edge function AND unit-test standalone.
 */

export type SniffedKind = 'pdf' | 'ofx' | 'csv';

export interface SniffResult {
  /** Positively identified format, or null when nothing matches. */
  kind: SniffedKind | null;
  /** Short machine reason (never echoes file bytes — Law 12 / Law 5). */
  reason: string;
}

// A statement file must have at least this many bytes to be anything real.
const MIN_STATEMENT_BYTES = 8;
// Structural probe only reads a bounded prefix — never the whole (possibly
// hostile / oversize) buffer. 64KiB is ample to see headers + a few rows.
const SNIFF_PREFIX_BYTES = 64 * 1024;
// CSV structural probe bounds (the FULL row/field caps live in the parser /
// worker — Slice 1/5; these are the coarse "obviously not a CSV" rejects).
const CSV_MIN_ROWS = 1;
const CSV_MAX_PROBE_LINES = 64;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

/**
 * OFX markers. OFX 1.x is SGML with an `OFXHEADER:` header block; OFX 2.x is
 * XML with an `<?OFX ...?>` processing instruction and/or an `<OFX>` root.
 * QFX (Quicken's OFX dialect) carries the same markers. We look for either the
 * header token or the `<OFX>` element start, case-insensitively, in the prefix.
 */
const OFX_MARKERS = ['OFXHEADER', '<OFX>', '<OFX ', '<?OFX'];

const startsWith = (bytes: Uint8Array, magic: number[]): boolean => {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
};

/**
 * Decode a bounded prefix as latin1-ish text for structural probing. We do NOT
 * trust or retain this text — it is used only to test structure, never parsed
 * into ledger data (that is the pure parser's job, Slice 1). Non-UTF8 bytes are
 * tolerated (control bytes are what disqualify a "text" format below).
 */
const prefixText = (bytes: Uint8Array): string => {
  const slice = bytes.subarray(0, SNIFF_PREFIX_BYTES);
  let out = '';
  for (let i = 0; i < slice.length; i += 1) {
    out += String.fromCharCode(slice[i]);
  }
  return out;
};

/**
 * Is this prefix "printable text"? Rejects binary: a NUL byte, or too many
 * non-printable control bytes (excluding tab/CR/LF), means this is not a text
 * format (CSV/OFX). This is what catches a `.csv`-named executable or a
 * `.csv`-named PDF sniffed as octet-stream.
 */
const looksLikeText = (bytes: Uint8Array): boolean => {
  const slice = bytes.subarray(0, SNIFF_PREFIX_BYTES);
  if (slice.length === 0) return false;
  let control = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const b = slice[i];
    if (b === 0x00) return false; // a NUL byte is a hard binary signal
    // allow tab (0x09), LF (0x0a), CR (0x0d); flag other C0 controls
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      control += 1;
    }
    // allow DEL + high bytes (latin1 / utf8 continuation) as text
  }
  // more than 1% control bytes → treat as binary
  return control <= Math.max(1, Math.floor(slice.length * 0.01));
};

const containsAnyCaseInsensitive = (haystackUpper: string, needles: string[]): boolean =>
  needles.some((n) => haystackUpper.includes(n));

/**
 * CSV structural probe: printable text, has at least one line, and the first
 * few non-empty lines contain a recognizable delimiter (comma / semicolon /
 * tab / pipe) and a consistent-ish column count. Deliberately permissive on
 * content (statement CSVs vary wildly) but strict on "is this actually
 * delimited tabular text vs. free prose or binary".
 */
const looksLikeCsv = (bytes: Uint8Array): boolean => {
  if (!looksLikeText(bytes)) return false;
  const text = prefixText(bytes);
  const lines = text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, CSV_MAX_PROBE_LINES);
  if (lines.length < CSV_MIN_ROWS) return false;

  const delimiters = [',', ';', '\t', '|'];
  for (const delim of delimiters) {
    const first = lines[0];
    const firstCols = first.split(delim).length;
    if (firstCols < 2) continue; // a single column is not delimited tabular data
    if (lines.length === 1) return true; // header-only CSV is still a CSV
    // a second line with a comparable column count under the same delimiter
    // confirms tabular structure.
    const second = lines[1];
    const secondCols = second.split(delim).length;
    if (secondCols >= 2 && Math.abs(firstCols - secondCols) <= Math.max(2, firstCols)) {
      return true;
    }
  }
  return false;
};

/**
 * Classify raw bytes. Returns a positive kind ONLY when the content proves it;
 * otherwise `{ kind: null }`. Order matters: binary magic (PDF) first, then
 * OFX markers, then the CSV structural probe last (it is the most permissive).
 */
export const sniffStatementBytes = (bytes: Uint8Array): SniffResult => {
  if (!bytes || bytes.length === 0) {
    return { kind: null, reason: 'empty' };
  }
  if (bytes.length < MIN_STATEMENT_BYTES) {
    return { kind: null, reason: 'too_short' };
  }

  // PDF: exact leading magic. A `.csv`-named PDF lands here → classified pdf,
  // NOT csv, so extension is irrelevant.
  if (startsWith(bytes, PDF_MAGIC)) {
    return { kind: 'pdf', reason: 'pdf_magic' };
  }

  // OFX / QFX: header token or <OFX> element in the (text) prefix.
  if (looksLikeText(bytes)) {
    const upper = prefixText(bytes).toUpperCase();
    if (containsAnyCaseInsensitive(upper, OFX_MARKERS)) {
      return { kind: 'ofx', reason: 'ofx_marker' };
    }
  }

  // CSV: structural probe (printable + delimited tabular). Last because it is
  // the most permissive positive.
  if (looksLikeCsv(bytes)) {
    return { kind: 'csv', reason: 'csv_structure' };
  }

  return { kind: null, reason: 'unrecognized' };
};

/**
 * Decide whether a downloaded statement object may be PROMOTED to the canonical
 * `statements` bucket.
 *
 * @param bytes           the exact downloaded object bytes
 * @param declaredMime    the MIME Storage reports (attacker-influenced — used
 *                        only to reject an out-of-allowlist claim cheaply; a
 *                        positive sniff is still required to promote)
 *
 * Rules (Law 5):
 *  - A file that sniffs to none of pdf|ofx|csv is REJECTED (quarantined).
 *  - application/octet-stream promotes ONLY when the sniff positively
 *    identifies pdf|ofx|csv (never on the MIME claim alone).
 *  - A concrete MIME claim (e.g. text/csv) that DISAGREES with the sniffed
 *    kind is rejected — we trust the bytes, and a mismatch is a red flag.
 */
export interface PromotionDecision {
  promote: boolean;
  sniffedKind: SniffedKind | null;
  reason: string;
}

// The concrete (non-octet-stream) MIME claims we allow, mapped to the kind the
// bytes must sniff as. image/* is allowed for statements (scanned PDF-adjacent
// images), but those are handled by the receipt-style image path, not sniffed
// here — a statement upload of an image keeps its declared image MIME and we
// do not force a sniff kind for it.
const STATEMENT_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const MIME_TO_EXPECTED_KIND: Record<string, SniffedKind> = {
  'application/pdf': 'pdf',
  'application/x-ofx': 'ofx',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'csv',
};

export const decideStatementPromotion = (
  bytes: Uint8Array,
  declaredMime: string,
): PromotionDecision => {
  // Images keep their declared type; they are validated by magic-byte checks
  // upstream (bucket allowlist) and are served as attachments. No content
  // sniff into pdf/ofx/csv applies.
  if (STATEMENT_IMAGE_MIMES.has(declaredMime)) {
    // Confirm the bytes are actually an image (magic) so a `.png`-named PDF or
    // executable cannot ride the image path. JPEG FFD8, PNG 89504E47, WEBP RIFF….
    const isJpeg = startsWith(bytes, [0xff, 0xd8, 0xff]);
    const isPng = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
    const isWebp =
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
    if (declaredMime === 'image/jpeg' && isJpeg) {
      return { promote: true, sniffedKind: null, reason: 'image_jpeg' };
    }
    if (declaredMime === 'image/png' && isPng) {
      return { promote: true, sniffedKind: null, reason: 'image_png' };
    }
    if (declaredMime === 'image/webp' && isWebp) {
      return { promote: true, sniffedKind: null, reason: 'image_webp' };
    }
    return { promote: false, sniffedKind: null, reason: 'image_mismatch' };
  }

  const sniff = sniffStatementBytes(bytes);
  if (sniff.kind === null) {
    return { promote: false, sniffedKind: null, reason: `reject_${sniff.reason}` };
  }

  if (declaredMime === 'application/octet-stream') {
    // octet-stream: the empty claim. Promote purely on the positive sniff.
    return { promote: true, sniffedKind: sniff.kind, reason: `octet_stream_sniffed_${sniff.kind}` };
  }

  const expected = MIME_TO_EXPECTED_KIND[declaredMime];
  if (!expected) {
    // A MIME outside the statement allowlist (and not octet-stream) → reject
    // even if the sniff is positive; the bucket allowlist should have blocked
    // it, so treat it as adversarial.
    return { promote: false, sniffedKind: sniff.kind, reason: 'mime_not_allowed' };
  }
  if (expected !== sniff.kind) {
    // Declared MIME disagrees with the bytes → trust the bytes, reject the file.
    return { promote: false, sniffedKind: sniff.kind, reason: 'mime_content_mismatch' };
  }
  return { promote: true, sniffedKind: sniff.kind, reason: `sniffed_${sniff.kind}` };
};
