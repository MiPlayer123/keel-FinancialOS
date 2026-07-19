/**
 * Statement extraction worker job (AI class B — suggest+approve).
 *
 * statement-ingestion-v2 §1 [A1] / §8 [A12]. This handler processes ONE
 * `statement_extract` job: a document_version uploaded in `mode:'ingest'` that
 * a Slice-6 confirm-upload (or the Slice-5 outbox sweeper) enqueued. The job
 * message is UNTRUSTED — every scope claim is re-verified server-side.
 *
 * Capability boundary [A1]: the `StatementJobIO` port defined here is the ONLY
 * surface that touches Supabase / Storage / rpc. `processStatementExtractJob`
 * composes resolve → download → route(mime) → parse → persist. It calls NO
 * `.rpc`/`.from`/`.storage`/`fetch` directly — every side effect goes through
 * the injected port, so a spy over the port sees the complete IO surface. The
 * pure parsers (`@keel/documents` statement parsers) and the fixture extractor
 * receive ONLY bytes / typed data (Law 1/5). The ONLY rpc the port ever issues
 * to persist is `keel_worker_persist_statement_extraction` (Law 5 allowlist).
 *
 * Law 5: every string a statement carries (CSV cell, OFX MEMO, PDF text) is
 * inert DATA. It is transcribed verbatim into the extraction record and can
 * never become a tool, write, or fetch. The only writes are the single
 * allowlisted persist proc.
 *
 * Law 9: idempotent. Re-delivery of the same job re-persists the same
 * extraction (the proc's unique key no-ops and skips child inserts), so a stuck
 * draft re-enqueued by the sweeper produces exactly one extraction, never a
 * duplicate.
 *
 * Law 12: on any failure the port persists `status='failed'` with a SHORT
 * `error_code` only — never a provider body, response text, URL, or key.
 */
import {
  MAX_CSV_ROWS,
  STATEMENT_PARSER_VERSION,
  parseCsvStatement,
  parseOfxStatement,
  RecordedStatementExtractor,
  CloudStatementExtractor,
  type StatementExtractionRecord,
  type StatementExtractor,
} from '../_shared/vendor/keel-domain.mjs';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface StatementJobResult {
  ok: boolean;
  detail: string;
  /** true → transient; leave the message for the visibility-timeout retry. */
  retry?: boolean;
}

/** The immutable object + verified scope resolved for one job. */
export interface ResolvedStatementVersion {
  readonly documentVersionId: string;
  readonly householdId: string;
  readonly accountId: string;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly mimeType: string;
  readonly contentSha256: string;
}

/** The typed args the port persists — mirrors the allowlisted proc exactly. */
export interface PersistStatementArgs {
  readonly householdId: string;
  readonly documentVersionId: string;
  readonly accountId: string;
  readonly status: 'extracted' | 'failed';
  readonly record: StatementExtractionRecord | null;
  readonly errorCode: string | null;
}

/**
 * The typed IO port [A1]. Everything that touches Supabase/Storage/rpc lives
 * behind these four methods; the handler composes them and does no IO itself.
 * Tests substitute a fake port and assert the complete side-effect set.
 */
export interface StatementJobIO {
  /** One household-verified `.from` read resolving the version + its object. */
  resolveVersion(
    documentVersionId: string,
    householdId: string,
  ): Promise<ResolvedStatementVersion | null>;
  /** One immutable Storage read → the raw object bytes. */
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  /** The extractor factory (fixture by default, cloud behind the ⚑ gate). */
  buildExtractor(): StatementExtractor;
  /** The ONLY rpc: keel_worker_persist_statement_extraction. */
  persist(args: PersistStatementArgs): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Build the statement extractor from server-only env (Law 12). Default =
 * fixture (no key, no network, deterministic, keyed by content sha256).
 * AI_PROVIDER=cloud + a configured key switches to the cloud extractor — that
 * switch is the human ⚑ checkpoint, the same posture as receipts.
 */
export const buildStatementExtractor = (): StatementExtractor => {
  const provider = Deno.env.get('AI_PROVIDER') ?? 'fixture';
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
  if (provider === 'cloud' && apiKey.length > 0) {
    return new CloudStatementExtractor({
      baseUrl: Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o-mini',
      apiKey,
      // §6 bounded extractor: cap completion tokens so a hostile/huge PDF can
      // never run the model unbounded.
      maxTokens: 4000,
    });
  }
  // Fixture path: recorded fields keyed by content sha256; unknown → inert.
  return new RecordedStatementExtractor({});
};

/**
 * The Supabase-backed StatementJobIO. This is the single concrete place that
 * touches Supabase/Storage/rpc; the capability-boundary CI check treats the
 * handler + parsers as pure, and this adapter as the intentional IO seam.
 */
export const makeStatementJobIO = (admin: AdminClient): StatementJobIO => ({
  async resolveVersion(documentVersionId, householdId) {
    // One .from read chain: version → its document (household check). Never
    // trust the message's household — it must match the document's.
    const { data: version, error: versionError } = await admin
      .from('document_versions')
      .select('id, storage_bucket, storage_path, mime_type, content_sha256, document_id')
      .eq('id', documentVersionId)
      .single();
    if (versionError || !version) return null;
    const { data: doc, error: docError } = await admin
      .from('documents')
      .select('id, household_id')
      .eq('id', version.document_id)
      .single();
    if (docError || !doc || doc.household_id !== householdId) return null;
    // The draft carries the authoritative account scope (statement_drafts.account_id
    // is NON-NULL). Resolve it here so the pure handler never guesses ownership.
    const { data: draft, error: draftError } = await admin
      .from('statement_drafts')
      .select('account_id')
      .eq('household_id', householdId)
      .eq('document_version_id', documentVersionId)
      .single();
    if (draftError || !draft || !draft.account_id) return null;
    return {
      documentVersionId,
      householdId,
      accountId: draft.account_id as string,
      storageBucket: version.storage_bucket as string,
      storagePath: version.storage_path as string,
      mimeType: (version.mime_type as string) ?? 'application/octet-stream',
      contentSha256: version.content_sha256 as string,
    };
  },
  async download(bucket, path) {
    const { data: file, error } = await admin.storage.from(bucket).download(path);
    if (error || !file) return null;
    return new Uint8Array(await file.arrayBuffer());
  },
  buildExtractor: buildStatementExtractor,
  async persist(args) {
    const rec = args.record;
    const { error } = await admin.rpc('keel_worker_persist_statement_extraction', {
      p_household_id: args.householdId,
      p_document_version_id: args.documentVersionId,
      p_account_id: args.accountId,
      p_status: args.status,
      p_kind_hint: rec?.kindHint ?? null,
      p_period_start: rec?.periodStart ?? null,
      p_period_end: rec?.periodEnd ?? null,
      p_opening_minor: rec?.openingMinor ?? null,
      p_ending_minor: rec?.endingMinor ?? null,
      p_currency: rec?.currency ?? null,
      p_extractor: rec?.extractor ?? (Deno.env.get('AI_PROVIDER') === 'cloud' ? 'cloud' : 'fixture'),
      p_extractor_version: rec?.extractorVersion ?? STATEMENT_PARSER_VERSION,
      p_model_version: rec?.model ?? null,
      p_prompt_version: rec?.promptVersion ?? null,
      p_confidence: rec?.confidence ?? null,
      // Law 5: the raw evidence is stored INERT — never interpreted.
      p_raw_evidence: rec?.rawEvidence ?? {},
      p_error_code: args.errorCode,
      // Money strings stay strings all the way into the proc (::bigint there).
      p_lines: rec ? statementLinesJson(rec) : null,
      p_holdings: rec ? statementHoldingsJson(rec) : null,
    });
    if (error) return { ok: false, detail: `statement persist failed: ${error.message}` };
    return { ok: true, detail: 'persisted' };
  },
});

/** Map the typed line records to the proc's snake_case jsonb array. */
const statementLinesJson = (rec: StatementExtractionRecord): unknown[] =>
  rec.lines.map((l) => ({
    line_no: l.lineNo,
    line_date: l.lineDate,
    amount_minor: l.amountMinor,
    currency: l.currency,
    description_raw: l.descriptionRaw,
    ofx_path: l.provenance?.amountMinor?.ofx_path ?? null,
    src_row: l.provenance?.amountMinor?.src_row ?? null,
    src_col: l.provenance?.amountMinor?.src_col ?? null,
    src_page: l.provenance?.amountMinor?.src_page ?? null,
    src_byte_offset: l.provenance?.amountMinor?.src_byte_offset ?? null,
    field_confidence: l.provenance?.amountMinor?.field_confidence ?? null,
    null_reason: l.provenance?.amountMinor?.null_reason ?? null,
  }));

/** Map the typed holding records to the proc's snake_case jsonb array. */
const statementHoldingsJson = (rec: StatementExtractionRecord): unknown[] =>
  rec.holdings.map((h) => ({
    symbol: h.symbol,
    cusip: h.cusip,
    isin: h.isin,
    name: h.nameRaw,
    qty: h.qty,
    price_minor: h.priceMinor,
    value_minor: h.valueMinor,
    cost_basis_minor: h.costBasisMinor,
    currency: h.currency,
    ofx_path: h.provenance?.valueMinor?.ofx_path ?? null,
    src_page: h.provenance?.valueMinor?.src_page ?? null,
    field_confidence: h.provenance?.valueMinor?.field_confidence ?? null,
    null_reason: h.provenance?.valueMinor?.null_reason ?? null,
  }));

/** PDF magic bytes: "%PDF" (0x25 50 44 46). */
const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

/**
 * Route the sniffed content to the right parser. The mime type is a hint; the
 * bytes are authoritative (a `.csv` carrying PDF magic bytes routes to the PDF
 * extractor, never the CSV parser — §6 magic-byte sniff). The parsers are pure
 * and receive ONLY bytes (Law 1/5, [A1]).
 */
export const routeStatementExtraction = async (
  mimeType: string,
  bytes: Uint8Array,
  extractor: StatementExtractor,
  contentSha256: string,
): Promise<StatementExtractionRecord> => {
  const mime = (mimeType ?? '').toLowerCase();
  // Magic-byte sniff first: a real PDF always goes to the model path regardless
  // of the declared mime (a hostile ".csv" that is actually a PDF cannot smuggle
  // PDF bytes into the CSV parser).
  if (looksLikePdf(bytes)) {
    const result = await extractor.extract({
      bytes,
      mimeType: 'application/pdf',
      contentSha256,
    });
    return result.record;
  }
  if (mime.includes('csv') || mime.includes('excel') || mime.includes('text/plain')) {
    return parseCsvStatement(bytes);
  }
  if (mime.includes('ofx') || mime.includes('qfx') || mime.includes('sgml') || mime.includes('xml')) {
    return parseOfxStatement(bytes);
  }
  if (mime.includes('pdf')) {
    const result = await extractor.extract({ bytes, mimeType: 'application/pdf', contentSha256 });
    return result.record;
  }
  // Unknown declared type + no PDF magic: try OFX (entity-safe, tolerant), then
  // CSV. Both are pure and degrade to an inert all-null record, never throw.
  const ofx = parseOfxStatement(bytes);
  if (ofx.lines.length > 0 || ofx.holdings.length > 0 || ofx.openingMinor !== null) return ofx;
  return parseCsvStatement(bytes);
};

/**
 * Process one statement_extract job through the typed IO port [A1]. The handler
 * itself performs NO IO — resolve/download/persist all route through `io`.
 */
export const processStatementExtractJob = async (
  io: StatementJobIO,
  refs: Record<string, string>,
): Promise<StatementJobResult> => {
  const documentVersionId = refs['documentVersionId'];
  const householdId = refs['householdId'];
  if (!documentVersionId || !householdId) {
    return { ok: false, detail: 'statement extract refs missing' };
  }

  // Resolve + verify scope (household + account) via ONE port read. A mismatch
  // (foreign household, missing draft) refuses WITHOUT any persist — we cannot
  // safely persist an extraction we cannot scope.
  const version = await io.resolveVersion(documentVersionId, householdId);
  if (version === null) {
    return { ok: false, detail: 'statement version not resolvable / household mismatch' };
  }

  // Download the immutable object (server-side only).
  const bytes = await io.download(version.storageBucket, version.storagePath);
  if (bytes === null) {
    // Persist a 'failed' extraction so the draft flips pending→failed and the
    // inbox can show a reason. Short code only — never a provider body (Law 12).
    await io.persist({
      householdId: version.householdId,
      documentVersionId,
      accountId: version.accountId,
      status: 'failed',
      record: null,
      errorCode: 'object_download_failed',
    });
    return { ok: false, detail: 'statement object download failed' };
  }

  // Resource guard [A9]: reject an oversized CSV BEFORE the parser builds a
  // line array. The parser also caps at MAX_CSV_ROWS, but failing closed here
  // keeps a hostile file from ever reaching the (larger) parse path.
  if (!looksLikePdf(bytes) && bytes.length > MAX_CSV_ROWS * 4096) {
    await io.persist({
      householdId: version.householdId,
      documentVersionId,
      accountId: version.accountId,
      status: 'failed',
      record: null,
      errorCode: 'object_too_large',
    });
    return { ok: false, detail: 'statement object exceeds size bound' };
  }

  // Route by sniffed type → pure parser or (PDF) the env-gated extractor. The
  // parsers never throw; the cloud extractor may throw (fails closed, Law 12).
  let record: StatementExtractionRecord;
  try {
    const extractor = io.buildExtractor();
    record = await routeStatementExtraction(
      version.mimeType,
      bytes,
      extractor,
      version.contentSha256,
    );
  } catch {
    // Only a constant reason — the thrown AiProviderError already scrubs its
    // message, but we do not echo even that into the persisted row (Law 12).
    await io.persist({
      householdId: version.householdId,
      documentVersionId,
      accountId: version.accountId,
      status: 'failed',
      record: null,
      errorCode: 'extraction_failed',
    });
    return { ok: false, detail: 'statement extraction failed' };
  }

  const persisted = await io.persist({
    householdId: version.householdId,
    documentVersionId,
    accountId: version.accountId,
    status: 'extracted',
    record,
    errorCode: null,
  });
  if (!persisted.ok) return { ok: false, detail: persisted.detail };

  return {
    ok: true,
    detail: `extracted (${record.extractor}; ${String(record.lines.length)} lines, ${String(record.holdings.length)} holdings)`,
  };
};
