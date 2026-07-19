/**
 * Defensive statement-extraction types (Law 11: material AI/extractor outputs
 * are records; Law 5: all ingested text is inert data). A statement — a bank or
 * card PDF/CSV/OFX, an investment position list — is parsed by the pure modules
 * in this directory into a `StatementExtractionRecord`. Every meaningful field
 * is nullable: malformed or hostile input becomes an inert `null` plus a
 * `null_reason`, never a thrown exception the caller might paper over with a
 * guess ("throw-into-guess" is forbidden). Money is BIGINT minor units carried
 * as a decimal STRING end-to-end (Law 4: no floats anywhere in the value path).
 *
 * Inputs to the parsers are ONLY `Uint8Array` bytes or already-typed data. This
 * module — and every module in this directory — imports no Supabase client, no
 * `fetch`, no Storage, no network of any kind (Law 1 boundary, enforced by
 * scripts/check-capability-boundary.mjs). The types here are pure descriptions.
 */

/** Statement kind the parser inferred from structure, never trusted as fact. */
export type StatementKindHint = 'bank' | 'card' | 'investment' | 'unknown';

/**
 * Why a field is null. Distinguishes "the source genuinely did not carry this"
 * (`absent`) from "the source carried something we refused to trust"
 * (`unparseable` / `rejected` / `out_of_range` / `hostile`). Surfaced in the
 * UI and stored as inert evidence; never itself an instruction.
 */
export type NullReason =
  | 'absent'
  | 'empty'
  | 'unparseable'
  | 'out_of_range'
  | 'ambiguous'
  | 'rejected'
  | 'hostile'
  | 'truncated';

/**
 * Per-field source provenance. Each locator is optional because a field can
 * originate in different container shapes (a CSV row/col + byte offset, a PDF
 * page + bbox, an OFX element path). `field_confidence` is the parser's or
 * extractor's calibrated self-report in [0,1] (or null when not applicable).
 * `null_reason` is set iff the field it annotates resolved to null.
 */
export interface FieldProvenance {
  /** 1-based PDF page the value was read from, when applicable. */
  readonly src_page: number | null;
  /** PDF bounding box [x0,y0,x1,y1] in page units, when applicable. */
  readonly src_bbox: readonly [number, number, number, number] | null;
  /** 1-based CSV/table row (excluding the header), when applicable. */
  readonly src_row: number | null;
  /** 0-based CSV/table column index, when applicable. */
  readonly src_col: number | null;
  /** Byte offset into the original file where the field's cell began. */
  readonly src_byte_offset: number | null;
  /** OFX/SGML element path, e.g. "STMTTRN.TRNAMT", when applicable. */
  readonly ofx_path: string | null;
  /** Parser/extractor calibrated confidence in [0,1], or null. */
  readonly field_confidence: number | null;
  /** Set iff the annotated field is null; explains why. */
  readonly null_reason: NullReason | null;
}

/** A provenance object with every locator null — the "nothing known" default. */
export const EMPTY_PROVENANCE: FieldProvenance = {
  src_page: null,
  src_bbox: null,
  src_row: null,
  src_col: null,
  src_byte_offset: null,
  ofx_path: null,
  field_confidence: null,
  null_reason: null,
};

/**
 * Build a provenance object from a partial spec, filling the rest with nulls.
 * Pure; never throws.
 */
export const provenance = (parts: Partial<FieldProvenance>): FieldProvenance => ({
  ...EMPTY_PROVENANCE,
  ...parts,
});

/**
 * One statement line (a posted transaction row on a bank/card statement).
 * `amountMinor` is a signed minor-unit decimal STRING (Law 4) or null. Every
 * field carries provenance; `descriptionRaw` is inert data-tier text (Law 5)
 * stored verbatim (subject only to a length cap enforced downstream, not here).
 */
export interface StatementLineRecord {
  /** 1-based order within the statement, assigned by the parser. */
  readonly lineNo: number;
  /** YYYY-MM-DD posted/effective date, or null. */
  readonly lineDate: string | null;
  /** Signed minor-unit amount as a decimal string, or null. */
  readonly amountMinor: string | null;
  /** ISO-4217 currency for this line, or null (falls back to statement currency). */
  readonly currency: string | null;
  /** Verbatim descriptor / memo / payee — inert data-tier text (Law 5). */
  readonly descriptionRaw: string | null;
  /** Provider transaction id (FITID etc.), inert, or null. */
  readonly externalId: string | null;
  /** Per-field provenance for the fields above. */
  readonly provenance: {
    readonly lineDate: FieldProvenance;
    readonly amountMinor: FieldProvenance;
    readonly descriptionRaw: FieldProvenance;
    readonly externalId: FieldProvenance;
  };
}

/**
 * One investment holding (a position on an investment statement). Prices and
 * values are minor-unit decimal STRINGS; `qty` is a decimal string too
 * (fractional shares) but is NOT money and is never summed into the ledger by
 * this layer. CUSIP/ISIN/ticker carried so a later slice can key on a stable
 * identifier, not a display symbol alone.
 */
export interface StatementHoldingRecord {
  /** Display ticker/symbol, inert data-tier, or null. */
  readonly symbol: string | null;
  /** CUSIP identifier, inert, or null. */
  readonly cusip: string | null;
  /** ISIN identifier, inert, or null. */
  readonly isin: string | null;
  /** Security name, inert data-tier text (Law 5), or null. */
  readonly nameRaw: string | null;
  /** Units held as a decimal string (may be fractional), or null. */
  readonly qty: string | null;
  /** Per-unit price in minor units as a decimal string, or null. */
  readonly priceMinor: string | null;
  /** Market value in minor units as a decimal string, or null. */
  readonly valueMinor: string | null;
  /** Cost basis in minor units as a decimal string, or null. */
  readonly costBasisMinor: string | null;
  /** ISO-4217 currency, or null. */
  readonly currency: string | null;
  /** Per-field provenance. */
  readonly provenance: {
    readonly symbol: FieldProvenance;
    readonly qty: FieldProvenance;
    readonly priceMinor: FieldProvenance;
    readonly valueMinor: FieldProvenance;
  };
}

/**
 * The parsed, defensively-typed fields of a statement. Balances are decimal
 * STRINGS (minor units) — never numbers — so no float ever enters the value
 * path. Everything is nullable; a malformed file yields an object with null
 * scalars, empty arrays, and populated `null_reason`s, but still no throw.
 */
export interface StatementExtractionFields {
  /** YYYY-MM-DD statement period start, or null. */
  readonly periodStart: string | null;
  /** YYYY-MM-DD statement period end, or null. */
  readonly periodEnd: string | null;
  /** Opening balance, minor-unit decimal string, or null. */
  readonly openingMinor: string | null;
  /** Ending balance, minor-unit decimal string, or null. */
  readonly endingMinor: string | null;
  /** ISO-4217 statement currency, or null. */
  readonly currency: string | null;
  /** Structural kind inference (never trusted as ownership fact). */
  readonly kindHint: StatementKindHint;
  /** Account identifier read off the statement (ACCTID etc.), inert, or null. */
  readonly accountHint: string | null;
  /** Posted transaction lines (empty when none / all rejected). */
  readonly lines: readonly StatementLineRecord[];
  /** Investment holdings (empty for non-investment statements). */
  readonly holdings: readonly StatementHoldingRecord[];
  /** Whole-extraction confidence in [0,1]. */
  readonly confidence: number;
  /** Per-field provenance for the scalar fields above. */
  readonly provenance: {
    readonly periodStart: FieldProvenance;
    readonly periodEnd: FieldProvenance;
    readonly openingMinor: FieldProvenance;
    readonly endingMinor: FieldProvenance;
    readonly currency: FieldProvenance;
    readonly accountHint: FieldProvenance;
  };
}

/**
 * The full extraction record: parsed fields plus the provenance stamp of what
 * produced them and the verbatim raw evidence. `rawEvidence` is retained inert
 * (Law 5) — displayed and stored, NEVER interpreted as an instruction.
 */
export interface StatementExtractionRecord extends StatementExtractionFields {
  /** 'csv' | 'ofx' | 'pdf' | 'claude:<model>' | 'fixture' — provenance. */
  readonly extractor: string;
  /** Parser/prompt/policy version stamp. */
  readonly extractorVersion: string;
  /** Model identifier when an LLM produced this, else null. */
  readonly model: string | null;
  /** Prompt version when an LLM produced this, else null. */
  readonly promptVersion: string | null;
  /**
   * Verbatim inert evidence (e.g. the raw header row, rejected-cell notes, or a
   * model's raw JSON). Stored/displayed only; never a tool trigger (Law 5).
   */
  readonly rawEvidence: Record<string, unknown>;
}

/** Version stamp carried by the deterministic parsers in this directory. */
export const STATEMENT_PARSER_VERSION = 'keel-statement-parse@v1';

/**
 * An empty, all-null extraction fields object with a supplied kindHint and
 * whole-extraction confidence 0 — the safe base a parser returns when it can
 * read nothing. Never throws.
 */
export const emptyStatementFields = (
  kindHint: StatementKindHint = 'unknown',
): StatementExtractionFields => ({
  periodStart: null,
  periodEnd: null,
  openingMinor: null,
  endingMinor: null,
  currency: null,
  kindHint,
  accountHint: null,
  lines: [],
  holdings: [],
  confidence: 0,
  provenance: {
    periodStart: EMPTY_PROVENANCE,
    periodEnd: EMPTY_PROVENANCE,
    openingMinor: EMPTY_PROVENANCE,
    endingMinor: EMPTY_PROVENANCE,
    currency: EMPTY_PROVENANCE,
    accountHint: EMPTY_PROVENANCE,
  },
});
