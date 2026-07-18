/**
 * Receipt extraction + deterministic matching worker job (AI class B).
 *
 * Flow for one newly-uploaded receipt document_version:
 *   1. resolve the version + owning household/entity (never trust the message).
 *   2. download the immutable object from Storage (server-side; the browser
 *      never sees the model).
 *   3. run the extractor (fixture by default; cloud vision only when a key is
 *      configured — live wiring is a human ⚑). The receipt image/OCR text is
 *      DATA (Law 5): the prompt fences it and no field it returns is ever
 *      treated as an instruction.
 *   4. persist a typed document_extractions row (idempotent per
 *      version+extractor+version).
 *   5. deterministic candidate generation (SQL blocking) → @keel/documents
 *      matcher (pure TS arithmetic, Law 1) → on a single high-confidence
 *      suggestion, write ONE document_transaction_matches 'suggested' row.
 *
 * Idempotent: re-delivery of the same job re-persists the same extraction
 * (unique key no-ops) and re-suggests the same pair (unique + active-guard
 * no-ops). No writes to the ledger anywhere — matches are an evidence overlay.
 */
import {
  buildExtractionRecord,
  decideMatch,
  DEFAULT_MATCHER_CONFIG,
  MATCHER_VERSION,
  CloudVisionReceiptExtractor,
  RecordedReceiptExtractor,
  type CandidateTransaction,
  type ReceiptExtractor,
} from '../_shared/vendor/keel-domain.mjs';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface ReceiptJobResult {
  ok: boolean;
  detail: string;
}

/**
 * Build the extractor from server-only env (Law 12). Default = fixture (no key,
 * no network, deterministic). AI_PROVIDER=cloud + a configured key switches to
 * the vision model — that switch is the human ⚑ checkpoint.
 */
export const buildReceiptExtractor = (recorded: Record<string, unknown> = {}): ReceiptExtractor => {
  const provider = Deno.env.get('AI_PROVIDER') ?? 'fixture';
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
  if (provider === 'cloud' && apiKey.length > 0) {
    return new CloudVisionReceiptExtractor({
      baseUrl: Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: Deno.env.get('OPENAI_VISION_MODEL') ?? 'gpt-4o-mini',
      apiKey,
    });
  }
  // Fixture path: recorded fields keyed by the object's content hash. Anything
  // not pre-recorded extracts to an inert all-null result (no crash).
  return new RecordedReceiptExtractor(
    recorded as Record<string, never>,
    // The worker keys recorded fixtures by content sha256.
    (img: { base64: string }) => img.base64,
  );
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

export const processReceiptExtractJob = async (
  admin: AdminClient,
  refs: Record<string, string>,
  extractorFactory: (recorded?: Record<string, unknown>) => ReceiptExtractor = buildReceiptExtractor,
): Promise<ReceiptJobResult> => {
  const documentVersionId = refs['documentVersionId'];
  const householdId = refs['householdId'];
  if (!documentVersionId || !householdId) {
    return { ok: false, detail: 'receipt extract refs missing' };
  }

  // Resolve the version + its storage pointer + owning household (defence in
  // depth: the household on the message must match the document's).
  const { data: version, error: versionError } = await admin
    .from('document_versions')
    .select('id, storage_bucket, storage_path, mime_type, content_sha256, document_id')
    .eq('id', documentVersionId)
    .single();
  if (versionError || !version) {
    return { ok: false, detail: `document version ${documentVersionId} not found` };
  }
  const { data: doc, error: docError } = await admin
    .from('documents')
    .select('id, household_id, kind')
    .eq('id', version.document_id)
    .single();
  if (docError || !doc) return { ok: false, detail: 'document not found' };
  if (doc.household_id !== householdId) {
    return { ok: false, detail: 'household mismatch on receipt extract' };
  }
  if (doc.kind !== 'receipt') {
    return { ok: true, detail: 'not a receipt; skipped' };
  }

  // Download the immutable object (server-side only).
  const { data: file, error: downloadError } = await admin.storage
    .from(version.storage_bucket)
    .download(version.storage_path);
  if (downloadError || !file) {
    // Persist a 'failed' extraction so the inbox can show the reason.
    await admin.rpc('keel_worker_persist_extraction', {
      p_household_id: householdId,
      p_document_version_id: documentVersionId,
      p_status: 'failed',
      p_extractor: Deno.env.get('AI_PROVIDER') === 'cloud' ? 'cloud' : 'fixture',
      p_extractor_version: MATCHER_VERSION,
      p_merchant: null,
      p_amount_minor: null,
      p_currency: null,
      p_txn_date: null,
      p_confidence: null,
      p_raw_evidence: {},
      p_error_code: 'object_download_failed',
    });
    return { ok: false, detail: 'receipt object download failed' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Fixture key = content sha256 (the worker's stable per-object handle).
  const image = { base64: version.content_sha256 as string, mimeType: version.mime_type as string };
  const cloudImage = { base64: toBase64(bytes), mimeType: version.mime_type as string };

  const extractor = extractorFactory();
  let result;
  try {
    // The cloud extractor needs the real bytes; the fixture keys by hash. Pass
    // the hash-keyed image to fixtures and real bytes to cloud — decided by the
    // provider env so we never send bytes to a fixture or a hash to a model.
    const useCloud = Deno.env.get('AI_PROVIDER') === 'cloud' && (Deno.env.get('OPENAI_API_KEY') ?? '').length > 0;
    result = await extractor.extract(useCloud ? cloudImage : image);
  } catch (e) {
    await admin.rpc('keel_worker_persist_extraction', {
      p_household_id: householdId,
      p_document_version_id: documentVersionId,
      p_status: 'failed',
      p_extractor: 'cloud',
      p_extractor_version: MATCHER_VERSION,
      p_merchant: null,
      p_amount_minor: null,
      p_currency: null,
      p_txn_date: null,
      p_confidence: null,
      p_raw_evidence: {},
      // Only a short code — never the provider body/key (Law 12).
      p_error_code: 'extraction_failed',
    });
    return { ok: false, detail: `receipt extraction failed: ${e instanceof Error ? e.message : 'error'}` };
  }

  // Build the typed record — re-validates the model's fields defensively; the
  // extracted values are inert DATA (Law 5).
  const record = buildExtractionRecord({
    raw: result.rawEvidence as Record<string, unknown>,
    extractor: result.extractor,
    extractorVersion: result.extractorVersion,
  });
  // Prefer the provider's already-coerced fields (they went through the same
  // narrowing); fall back to the record's parse.
  const merchant = result.fields.merchant ?? record.merchant;
  const totalMinor = result.fields.totalMinor ?? record.totalMinor;
  const currency = (result.fields.currency ?? record.currency)?.toUpperCase() ?? null;
  const txnDate = result.fields.txnDate ?? record.txnDate;
  const confidence = result.fields.confidence;

  const { error: persistError } = await admin.rpc('keel_worker_persist_extraction', {
    p_household_id: householdId,
    p_document_version_id: documentVersionId,
    p_status: 'extracted',
    p_extractor: result.extractor,
    p_extractor_version: result.extractorVersion,
    p_merchant: merchant,
    p_amount_minor: totalMinor,
    p_currency: currency,
    p_txn_date: txnDate,
    p_confidence: confidence,
    p_raw_evidence: result.rawEvidence,
    p_error_code: null,
  });
  if (persistError) {
    return { ok: false, detail: `extraction persist failed: ${persistError.message}` };
  }

  // Nothing to match on if the model couldn't read the money/date/currency.
  if (totalMinor === null || txnDate === null || currency === null) {
    return { ok: true, detail: 'extracted (no suggestion — insufficient fields)' };
  }

  // Deterministic candidate generation (SQL blocking) + pure matcher.
  const { data: candData, error: candError } = await admin.rpc('keel_worker_receipt_candidates', {
    p_household_id: householdId,
    p_currency: currency,
    p_txn_date: txnDate,
    p_amount_minor: totalMinor,
    p_date_before: DEFAULT_MATCHER_CONFIG.dateBeforeDays,
    p_date_after: DEFAULT_MATCHER_CONFIG.dateAfterDays,
    p_tip_bps: DEFAULT_MATCHER_CONFIG.tipToleranceBps,
  });
  if (candError) return { ok: false, detail: `candidate fetch failed: ${candError.message}` };

  const rawRows = ((candData as { rows?: unknown[] })?.rows ?? []) as Array<{
    transactionId: string;
    amountMinor: string;
    currency: string;
    effectiveDate: string;
    description: string;
    hasConfirmedMatch: boolean;
  }>;
  const candidates: CandidateTransaction[] = rawRows.map((r) => ({
    transactionId: r.transactionId,
    amountMinor: r.amountMinor,
    currency: r.currency,
    effectiveDate: r.effectiveDate,
    description: r.description,
    hasConfirmedMatch: r.hasConfirmedMatch,
    // Rejected pairs are excluded at suggestion-write time (proc guard); the
    // matcher treats every candidate as eligible here.
    previouslyRejected: false,
  }));

  const outcome = decideMatch(
    { merchant, totalMinor, currency, txnDate, confidence },
    candidates,
  );

  // Precision-first: only write a suggestion for a SINGLE high-confidence match.
  // Multi/none produce no suggestion row — the inbox shows the receipt as
  // unmatched and the user can attach manually.
  if (outcome.kind !== 'suggest') {
    return { ok: true, detail: `extracted (${outcome.kind}; no single suggestion written)` };
  }

  const { error: suggestError } = await admin.rpc('keel_worker_suggest_match', {
    p_household_id: householdId,
    p_document_version_id: documentVersionId,
    p_canonical_transaction_id: outcome.candidate.transactionId,
    p_score: outcome.candidate.score,
    p_reason_codes: outcome.candidate.reasonCodes,
    p_matcher_version: MATCHER_VERSION,
  });
  if (suggestError) return { ok: false, detail: `suggest match failed: ${suggestError.message}` };

  return { ok: true, detail: `extracted + suggested match (score ${String(outcome.candidate.score)})` };
};
