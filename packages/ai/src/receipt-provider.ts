/**
 * Receipt extractor implementations behind the ReceiptExtractor interface
 * (INFRA §11: providers behind one interface).
 *
 * - RecordedReceiptExtractor: deterministic, no network. Returns pre-recorded
 *   fields keyed by image hash. CI and the worker's default (AI_PROVIDER=fixture)
 *   use this — no model call, no key, no PII to a cloud (Law 12).
 * - CloudVisionReceiptExtractor: OpenAI-compatible /chat/completions vision call.
 *   The image is attached as an image_url content block and a PDF as a file
 *   content block (never inlined into text); the API key is injected via config
 *   and never logged (Law 12). Wiring it live is a human ⚑ checkpoint.
 */
import {
  buildReceiptExtractionPrompt,
  coerceReceiptFields,
  RECEIPT_PROMPT_VERSION,
  type RawReceiptFields,
  type ReceiptExtractionResult,
  type ReceiptExtractor,
  type ReceiptImage,
} from './receipt.js';
import { AiProviderError } from './provider.js';

/**
 * Deterministic fixture extractor. Callers register expected fields for a given
 * image key (e.g. the content sha256 the worker computed). An unregistered key
 * yields an inert all-null extraction — never throws — so the pipeline degrades
 * to "no suggestion" rather than crashing.
 */
export class RecordedReceiptExtractor implements ReceiptExtractor {
  private readonly byKey: Map<string, RawReceiptFields>;
  private readonly keyOf: (image: ReceiptImage) => string;

  constructor(
    recorded: Readonly<Record<string, RawReceiptFields>>,
    keyOf: (image: ReceiptImage) => string,
  ) {
    this.byKey = new Map(Object.entries(recorded));
    this.keyOf = keyOf;
  }

  extract(image: ReceiptImage): Promise<ReceiptExtractionResult> {
    const key = this.keyOf(image);
    const fields: RawReceiptFields = this.byKey.get(key) ?? {
      merchant: null,
      totalMinor: null,
      currency: null,
      txnDate: null,
      confidence: 0,
    };
    return Promise.resolve({
      fields,
      extractor: 'fixture',
      extractorVersion: RECEIPT_PROMPT_VERSION,
      rawEvidence: { source: 'fixture', key, ...fields },
    });
  }
}

export interface CloudVisionConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** Provenance prefix on every extraction, e.g. 'openai' → 'openai:<model>'. */
  readonly provider?: string;
  /**
   * Reasoning effort for reasoning models (gpt-5*, gpt-6*, o*). Transcribing a
   * receipt needs none; the lowest setting keeps cost to the visible output.
   * Ignored for non-reasoning models.
   */
  readonly reasoningEffort?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Reasoning-model families take reasoning_effort and reject temperature. */
const isReasoningModel = (model: string): boolean => /^(gpt-5|gpt-6|o\d)/u.test(model);

/** Lowest effort each family accepts (gpt-5 has no 'none'). */
const defaultEffortFor = (model: string): string => (model.startsWith('gpt-5') ? 'minimal' : 'none');

/** Request body for one receipt. Exported for tests (no network). */
export const buildReceiptVisionRequest = (
  config: Pick<CloudVisionConfig, 'model' | 'reasoningEffort'>,
  image: ReceiptImage,
): Record<string, unknown> => {
  const attachment =
    image.mimeType === 'application/pdf'
      ? {
          type: 'file',
          file: { filename: 'receipt.pdf', file_data: `data:application/pdf;base64,${image.base64}` },
        }
      : { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } };
  const tuning = isReasoningModel(config.model)
    ? { reasoning_effort: config.reasoningEffort ?? defaultEffortFor(config.model) }
    : { temperature: 0 };
  return {
    model: config.model,
    // Counts reasoning + visible output on reasoning models; the JSON answer
    // is ~100 tokens, so this is headroom, not spend.
    max_completion_tokens: 1500,
    ...tuning,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildReceiptExtractionPrompt() },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Transcribe this receipt into the JSON schema.' }, attachment],
      },
    ],
  };
};

const parseChatJsonContent = (body: unknown): { text: string; model: string | null } | null => {
  const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  if (root === null) return null;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | null;
  const message = first && typeof first['message'] === 'object' ? (first['message'] as Record<string, unknown>) : null;
  const content = message?.['content'];
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  return { text: content, model: typeof root['model'] === 'string' ? root['model'] : null };
};

/** Pull the first JSON object out of a model response, tolerating stray prose. */
const extractJsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * OpenAI-compatible vision extractor. Fails CLOSED: any transport/parse error
 * throws AiProviderError carrying only an HTTP status (never request/response
 * bodies, never the key). The worker persists a 'failed' extraction on throw.
 */
export class CloudVisionReceiptExtractor implements ReceiptExtractor {
  private readonly config: CloudVisionConfig;

  constructor(config: CloudVisionConfig) {
    if (config.baseUrl.length === 0 || config.model.length === 0 || config.apiKey.length === 0) {
      throw new AiProviderError('Receipt vision provider is not configured.');
    }
    this.config = config;
  }

  async extract(image: ReceiptImage): Promise<ReceiptExtractionResult> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(buildReceiptVisionRequest(this.config, image)),
      });
    } catch {
      throw new AiProviderError('Receipt vision request failed.');
    }
    if (!response.ok) {
      throw new AiProviderError(
        `Receipt vision request failed (HTTP ${String(response.status)}).`,
        response.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new AiProviderError('Receipt vision returned a non-JSON response.');
    }
    const content = parseChatJsonContent(parsed);
    if (content === null) {
      throw new AiProviderError('Receipt vision returned an empty completion.');
    }
    const obj = extractJsonObject(content.text);
    if (obj === null) {
      throw new AiProviderError('Receipt vision did not return a JSON object.');
    }
    return {
      fields: coerceReceiptFields(obj),
      extractor: `${this.config.provider ?? 'openai'}:${content.model ?? this.config.model}`,
      extractorVersion: RECEIPT_PROMPT_VERSION,
      rawEvidence: obj,
    };
  }
}
