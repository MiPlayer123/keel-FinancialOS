/**
 * Statement extractor implementations behind the StatementExtractor interface
 * (INFRA §11: providers behind one interface).
 *
 * - RecordedStatementExtractor: deterministic, no network. Returns a
 *   pre-recorded StatementExtractionRecord keyed by the document's content
 *   sha256. CI and the worker's default (AI_PROVIDER=fixture) use this — no
 *   model call, no key, no document bytes to a cloud (Law 12).
 * - CloudStatementExtractor: OpenAI-compatible /chat/completions file/vision
 *   call. The document is attached as a separate content block (never inlined
 *   into text); the API key is injected via config and NEVER logged or echoed
 *   into an error (Law 12). Wiring it live is a human ⚑ checkpoint behind the
 *   AI_PROVIDER gate — cloud is NOT enabled by default.
 */
import {
  buildStatementExtractionPrompt,
  coerceStatementFields,
  inertStatementRecord,
  STATEMENT_PROMPT_VERSION,
  type StatementDocument,
  type StatementExtractionResult,
  type StatementExtractor,
} from './statement.js';
import type { StatementExtractionFields } from '@keel/documents/statement';
import { AiProviderError } from './provider.js';

/**
 * Deterministic fixture extractor. Callers register expected fields for a given
 * document key (the content sha256 the worker computed). An unregistered key
 * yields an inert all-null record — never throws — so the pipeline degrades to
 * "no suggestion" rather than crashing. Fully deterministic by sha256.
 */
export class RecordedStatementExtractor implements StatementExtractor {
  private readonly byKey: Map<string, StatementExtractionFields>;
  private readonly keyOf: (doc: StatementDocument) => string;

  constructor(
    recorded: Readonly<Record<string, StatementExtractionFields>>,
    keyOf: (doc: StatementDocument) => string = (doc) => doc.contentSha256,
  ) {
    this.byKey = new Map(Object.entries(recorded));
    this.keyOf = keyOf;
  }

  extract(doc: StatementDocument): Promise<StatementExtractionResult> {
    const key = this.keyOf(doc);
    const fields = this.byKey.get(key);
    if (fields === undefined) {
      return Promise.resolve({
        record: inertStatementRecord('fixture', { source: 'fixture', key }),
      });
    }
    return Promise.resolve({
      record: {
        ...fields,
        extractor: 'fixture',
        extractorVersion: STATEMENT_PROMPT_VERSION,
        model: null,
        promptVersion: null,
        rawEvidence: { source: 'fixture', key },
      },
    });
  }
}

export interface CloudStatementConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** Injectable for tests; defaults to the ambient fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Upper bound on completion tokens (§6 bounded extractor). */
  readonly maxTokens?: number;
}

const parseChatJsonContent = (body: unknown): { text: string; model: string | null } | null => {
  const root = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  if (root === null) return null;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown> | null;
  const message =
    first && typeof first['message'] === 'object'
      ? (first['message'] as Record<string, unknown>)
      : null;
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

const asDataUrl = (doc: StatementDocument): string => {
  if (typeof doc.base64 === 'string' && doc.base64.length > 0) {
    return `data:${doc.mimeType};base64,${doc.base64}`;
  }
  if (doc.bytes !== undefined) {
    return `data:${doc.mimeType};base64,${Buffer.from(doc.bytes).toString('base64')}`;
  }
  return `data:${doc.mimeType};base64,`;
};

/**
 * OpenAI-compatible statement extractor. Fails CLOSED: any transport/parse
 * error throws AiProviderError carrying ONLY an HTTP status — never the request
 * or response bodies, never the key (Law 12). The worker persists a 'failed'
 * extraction on throw.
 */
export class CloudStatementExtractor implements StatementExtractor {
  private readonly config: CloudStatementConfig;

  constructor(config: CloudStatementConfig) {
    if (config.baseUrl.length === 0 || config.model.length === 0 || config.apiKey.length === 0) {
      // Message never carries the (partial) config — nothing leaks (Law 12).
      throw new AiProviderError('Statement extraction provider is not configured.');
    }
    this.config = config;
  }

  async extract(doc: StatementDocument): Promise<StatementExtractionResult> {
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
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 4000,
          temperature: 0,
          messages: [
            { role: 'system', content: buildStatementExtractionPrompt() },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Transcribe this statement into the JSON schema.' },
                {
                  type: 'image_url',
                  image_url: { url: asDataUrl(doc) },
                },
              ],
            },
          ],
        }),
      });
    } catch {
      // Fail closed with a constant message: a transport error can embed the
      // URL, headers (incl. the bearer key), or internal addresses (Law 12).
      throw new AiProviderError('Statement extraction request failed.');
    }
    if (!response.ok) {
      throw new AiProviderError(
        `Statement extraction request failed (HTTP ${String(response.status)}).`,
        response.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new AiProviderError('Statement extraction returned a non-JSON response.');
    }
    const content = parseChatJsonContent(parsed);
    if (content === null) {
      throw new AiProviderError('Statement extraction returned an empty completion.');
    }
    const obj = extractJsonObject(content.text);
    if (obj === null) {
      throw new AiProviderError('Statement extraction did not return a JSON object.');
    }
    const model = content.model ?? this.config.model;
    return {
      record: {
        ...coerceStatementFields(obj),
        extractor: `claude:${model}`,
        extractorVersion: STATEMENT_PROMPT_VERSION,
        model,
        promptVersion: STATEMENT_PROMPT_VERSION,
        // Law 5: the model's raw JSON is retained inert — displayed/stored, never
        // interpreted as an instruction and never a tool trigger.
        rawEvidence: obj,
      },
    };
  }
}
