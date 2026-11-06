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
  RECEIPT_PROMPT_VERSION,
  type CandidateTransaction,
  type ReceiptExtractor,
} from '../_shared/vendor/keel-domain.mjs';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface ReceiptJobResult {
  ok: boolean;
  detail: string;
}

/** Cheapest current OpenAI model with image input (checked 2026-11-06). */
export const DEFAULT_RECEIPT_MODEL = 'gpt-6-luna';
/** Model reads per household per calendar month (UTC) before reading pauses. */
export const DEFAULT_RECEIPT_MONTHLY_LIMIT = 200;

export type ReceiptExtractorMode = 'openai' | 'fixture' | 'off';

/**
 * Which extractor runs, from server-only env (Law 12). Receipts have their own
 * switch so they don't fight the chat assistant over AI_PROVIDER:
 *   RECEIPT_EXTRACTOR=openai  model reads (needs OPENAI_API_KEY) — the ⚑ switch
 *   RECEIPT_EXTRACTOR=off     kill switch: nothing is read, uploads still file
 *   RECEIPT_EXTRACTOR=fixture deterministic test extractor
 * Unset keeps the old behaviour (AI_PROVIDER=cloud + key → openai, else fixture).
 * openai without a key reads nothing rather than silently faking a read.
 */
export const receiptExtractorMode = (): ReceiptExtractorMode => {
  const explicit = (Deno.env.get('RECEIPT_EXTRACTOR') ?? '').trim().toLowerCase();
  const hasKey = (Deno.env.get('OPENAI_API_KEY') ?? '').length > 0;
  if (explicit === 'off') return 'off';
  if (explicit === 'fixture') return 'fixture';
  if (explicit === 'openai') return hasKey ? 'openai' : 'off';
  return Deno.env.get('AI_PROVIDER') === 'cloud' && hasKey ? 'openai' : 'fixture';
};

export const receiptModel = (): string =>
  Deno.env.get('RECEIPT_MODEL') ?? Deno.env.get('OPENAI_VISION_MODEL') ?? DEFAULT_RECEIPT_MODEL;

export const receiptMonthlyLimit = (): number => {
  const raw = Number(Deno.env.get('RECEIPT_MONTHLY_LIMIT') ?? '');
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_RECEIPT_MONTHLY_LIMIT;
};

/** Provenance label for rows written without a model answer. */
const extractorLabel = (mode: ReceiptExtractorMode): string =>
  mode === 'openai' ? `openai:${receiptModel()}` : mode;

/**
 * Build the extractor from server-only env (Law 12). Default = fixture (no key,
 * no network, deterministic). RECEIPT_EXTRACTOR=openai + a configured key
 * switches to the vision model — that switch is the human ⚑ checkpoint.
 */
export const buildReceiptExtractor = (recorded: Record<string, unknown> = {}): ReceiptExtractor => {
  if (receiptExtractorMode() === 'openai') {
    const reasoningEffort = Deno.env.get('RECEIPT_REASONING_EFFORT');
    return new CloudVisionReceiptExtractor({
      baseUrl: Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: receiptModel(),
      apiKey: Deno.env.get('OPENAI_API_KEY') ?? '',
      provider: 'openai',
      ...(reasoningEffort ? { reasoningEffort } : {}),
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

const persistFailure = async (
  admin: AdminClient,
  householdId: string,
  documentVersionId: string,
  extractor: string,
  errorCode: string,
): Promise<void> => {
  await admin.rpc('keel_worker_persist_extraction', {
    p_household_id: householdId,
    p_document_version_id: documentVersionId,
    p_status: 'failed',
    p_extractor: extractor,
    p_extractor_version: RECEIPT_PROMPT_VERSION,
    p_merchant: null,
    p_amount_minor: null,
    p_currency: null,
    p_txn_date: null,
    p_confidence: null,
    p_raw_evidence: {},
    // Only a short code — never the provider body/key (Law 12).
    p_error_code: errorCode,
  });
};

/** Model reads this household already used this UTC month (failed ones too). */
const modelReadsThisMonth = async (admin: AdminClient, householdId: string): Promise<number> => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count, error } = await admin
    .from('document_extractions')
    .select('id', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .like('extractor', 'openai:%')
    .gte('created_at', monthStart);
  // Fail closed: if we can't count, assume the cap is reached.
  if (error || typeof count !== 'number') return Number.POSITIVE_INFINITY;
  return count;
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

  const mode = receiptExtractorMode();
  if (mode === 'off') {
    await persistFailure(admin, householdId, documentVersionId, 'off', 'extraction_off');
    return { ok: true, detail: 'receipt reading is off; filed without a read' };
  }
  if (mode === 'openai' && (await modelReadsThisMonth(admin, householdId)) >= receiptMonthlyLimit()) {
    await persistFailure(admin, householdId, documentVersionId, 'limit', 'monthly_limit_reached');
    return { ok: true, detail: 'monthly receipt-reading limit reached; filed without a read' };
  }

  // Download the immutable object (server-side only).
  const { data: file, error: downloadError } = await admin.storage
    .from(version.storage_bucket)
    .download(version.storage_path);
  if (downloadError || !file) {
    // Persist a 'failed' extraction so the inbox can show the reason.
    await persistFailure(admin, householdId, documentVersionId, extractorLabel(mode), 'object_download_failed');
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
    result = await extractor.extract(mode === 'openai' ? cloudImage : image);
  } catch (e) {
    await persistFailure(admin, householdId, documentVersionId, extractorLabel(mode), 'extraction_failed');
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
    hasAttachment?: boolean;
  }>;
  // A transaction that already holds a receipt is not offered again.
  const candidates: CandidateTransaction[] = rawRows.filter((r) => r.hasAttachment !== true).map((r) => ({
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
