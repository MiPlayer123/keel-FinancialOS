import {
  decideStatementPromotion,
  sniffStatementBytes,
} from './statement-sniff.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

// A minimal-but-real PDF (magic + trivial body). Extension is irrelevant.
const PDF_BYTES = enc('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const OFX_1X = enc(
  'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>\n',
);
const OFX_2X = enc(
  '<?xml version="1.0"?>\n<?OFX OFXHEADER="200" VERSION="200"?>\n<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>\n',
);
const CSV_BYTES = enc('Date,Description,Amount\n2026-07-01,Coffee Shop,-4.50\n2026-07-02,Refund,12.00\n');
const CSV_SEMICOLON = enc('Date;Description;Amount\n2026-07-01;Grocery;-30,00\n');
const CSV_HEADER_ONLY = enc('Date,Description,Amount\n');

Deno.test('sniffStatementBytes: PDF magic classifies as pdf', () => {
  assert(sniffStatementBytes(PDF_BYTES).kind === 'pdf');
});

Deno.test('sniffStatementBytes: OFX 1.x SGML header classifies as ofx', () => {
  assert(sniffStatementBytes(OFX_1X).kind === 'ofx');
});

Deno.test('sniffStatementBytes: OFX 2.x XML classifies as ofx', () => {
  assert(sniffStatementBytes(OFX_2X).kind === 'ofx');
});

Deno.test('sniffStatementBytes: comma CSV classifies as csv', () => {
  assert(sniffStatementBytes(CSV_BYTES).kind === 'csv');
});

Deno.test('sniffStatementBytes: semicolon-delimited CSV classifies as csv', () => {
  assert(sniffStatementBytes(CSV_SEMICOLON).kind === 'csv');
});

Deno.test('sniffStatementBytes: header-only CSV still classifies as csv', () => {
  assert(sniffStatementBytes(CSV_HEADER_ONLY).kind === 'csv');
});

Deno.test('sniffStatementBytes: empty file rejects', () => {
  const r = sniffStatementBytes(new Uint8Array(0));
  assert(r.kind === null && r.reason === 'empty');
});

Deno.test('sniffStatementBytes: truncated (too short) file rejects', () => {
  const r = sniffStatementBytes(bytes(0x25, 0x50)); // "%P" only
  assert(r.kind === null && r.reason === 'too_short');
});

Deno.test('sniffStatementBytes: truncated-but-past-floor PDF still detects pdf magic', () => {
  // %PDF + just enough bytes to clear the 8-byte min floor — magic wins even
  // though the rest of the PDF is missing (a truncated download).
  const r = sniffStatementBytes(enc('%PDF-1.4\n'));
  assert(r.kind === 'pdf');
});

Deno.test('sniffStatementBytes: binary blob (executable) rejects', () => {
  // ELF magic 0x7f 'E' 'L' 'F' + NUL bytes — classic executable, not a statement.
  const exe = bytes(0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00);
  const r = sniffStatementBytes(exe);
  assert(r.kind === null, `expected null, got ${r.kind}`);
});

Deno.test('sniffStatementBytes: free prose (no delimiters) rejects', () => {
  const prose = enc('This is just a paragraph of text with no tabular structure at all here.');
  assert(sniffStatementBytes(prose).kind === null);
});

// ---- promotion decision (the confirm-upload boundary) ----

Deno.test('decideStatementPromotion: hostile .csv-named PDF is NOT promoted as csv', () => {
  // Client claims text/csv, bytes are a PDF. Trust the bytes: mismatch → reject.
  const d = decideStatementPromotion(PDF_BYTES, 'text/csv');
  assert(!d.promote, 'PDF-as-csv must not promote');
  assert(d.sniffedKind === 'pdf');
  assert(d.reason === 'mime_content_mismatch');
});

Deno.test('decideStatementPromotion: real PDF with pdf MIME promotes', () => {
  const d = decideStatementPromotion(PDF_BYTES, 'application/pdf');
  assert(d.promote && d.sniffedKind === 'pdf');
});

Deno.test('decideStatementPromotion: real CSV with text/csv promotes', () => {
  const d = decideStatementPromotion(CSV_BYTES, 'text/csv');
  assert(d.promote && d.sniffedKind === 'csv');
});

Deno.test('decideStatementPromotion: real CSV with ms-excel MIME promotes', () => {
  const d = decideStatementPromotion(CSV_BYTES, 'application/vnd.ms-excel');
  assert(d.promote && d.sniffedKind === 'csv');
});

Deno.test('decideStatementPromotion: real OFX with x-ofx MIME promotes', () => {
  const d = decideStatementPromotion(OFX_1X, 'application/x-ofx');
  assert(d.promote && d.sniffedKind === 'ofx');
});

Deno.test('decideStatementPromotion: octet-stream promotes ONLY when sniffed positively', () => {
  assert(decideStatementPromotion(PDF_BYTES, 'application/octet-stream').promote);
  assert(decideStatementPromotion(CSV_BYTES, 'application/octet-stream').promote);
  assert(decideStatementPromotion(OFX_2X, 'application/octet-stream').promote);
});

Deno.test('decideStatementPromotion: octet-stream over a binary blob is NOT promoted', () => {
  const exe = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00);
  const d = decideStatementPromotion(exe, 'application/octet-stream');
  assert(!d.promote, 'octet-stream executable must not promote');
  assert(d.sniffedKind === null);
});

Deno.test('decideStatementPromotion: .csv-named executable is NOT promoted', () => {
  const exe = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00); // "MZ" DOS header
  const d = decideStatementPromotion(exe, 'text/csv');
  assert(!d.promote);
  assert(d.sniffedKind === null);
});

Deno.test('decideStatementPromotion: empty file is NOT promoted', () => {
  const d = decideStatementPromotion(new Uint8Array(0), 'text/csv');
  assert(!d.promote && d.reason === 'reject_empty');
});

Deno.test('decideStatementPromotion: truncated file is NOT promoted', () => {
  const d = decideStatementPromotion(bytes(0x25, 0x50), 'application/pdf');
  assert(!d.promote && d.reason === 'reject_too_short');
});

Deno.test('decideStatementPromotion: image path requires matching image magic', () => {
  // A .png-named PDF claiming image/png must not ride the image path.
  const d = decideStatementPromotion(PDF_BYTES, 'image/png');
  assert(!d.promote && d.reason === 'image_mismatch');
  // A real JPEG magic with image/jpeg promotes.
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
  assert(decideStatementPromotion(jpeg, 'image/jpeg').promote);
});

Deno.test('decideStatementPromotion: MIME outside statement allowlist is rejected even if sniff positive', () => {
  const d = decideStatementPromotion(CSV_BYTES, 'application/zip');
  assert(!d.promote && d.reason === 'mime_not_allowed');
});
