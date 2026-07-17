/**
 * Provider-agnostic chat completion interface + an OpenAI-compatible HTTP
 * implementation (INFRA §11: providers behind one interface).
 *
 * fetch-based on purpose: no provider SDK import, so this package stays pure
 * (verify-purity gate) and the provider is swappable by configuration alone.
 * The API key arrives via config from the caller's secret store (Law 12);
 * it is never logged, never echoed into errors, never defaulted.
 */
import type { ChatMessage } from './prompt.js';

export interface ChatCompleteOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ChatUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ChatCompletion {
  readonly text: string;
  /** Provider-reported model id when available, else the configured model. */
  readonly modelVersion: string;
  readonly usage: ChatUsage;
}

export interface ChatProvider {
  complete(messages: readonly ChatMessage[], opts?: ChatCompleteOptions): Promise<ChatCompletion>;
}

/** Typed failure — carries HTTP status only, never request/response bodies. */
export class AiProviderError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
  }
}

export interface OpenAiCompatibleConfig {
  /** e.g. https://api.openai.com/v1 — always from config, never hardcoded by callers. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** Injectable for tests; defaults to the ambient fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface CompletionWire {
  readonly text: string;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Narrow the /chat/completions response shape without trusting it. */
const parseCompletionBody = (body: unknown): CompletionWire | null => {
  const root = asRecord(body);
  if (root === null) return null;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = asRecord(asRecord(choices[0])?.['message']);
  const content = message?.['content'];
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  const usage = asRecord(root['usage']);
  return {
    text: content,
    model: typeof root['model'] === 'string' ? root['model'] : null,
    inputTokens: asFiniteNumber(usage?.['prompt_tokens']),
    outputTokens: asFiniteNumber(usage?.['completion_tokens']),
  };
};

/**
 * OpenAI-compatible /chat/completions client. Works against OpenAI and any
 * compatible gateway (base URL + model + key all injected).
 */
export class OpenAiCompatibleChatProvider implements ChatProvider {
  private readonly config: OpenAiCompatibleConfig;

  constructor(config: OpenAiCompatibleConfig) {
    if (config.baseUrl.length === 0 || config.model.length === 0 || config.apiKey.length === 0) {
      throw new AiProviderError('AI provider is not configured.');
    }
    this.config = config;
  }

  async complete(
    messages: readonly ChatMessage[],
    opts?: ChatCompleteOptions,
  ): Promise<ChatCompletion> {
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
          messages,
          max_tokens: opts?.maxTokens ?? 700,
          temperature: opts?.temperature ?? 0.2,
        }),
      });
    } catch {
      // Fail closed with a constant message: transport errors can embed URLs
      // and headers, and nothing from this request may leak (Law 12).
      throw new AiProviderError('AI provider request failed.');
    }

    if (!response.ok) {
      throw new AiProviderError(
        `AI provider request failed (HTTP ${String(response.status)}).`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiProviderError('AI provider returned a non-JSON response.');
    }

    const wire = parseCompletionBody(body);
    if (wire === null) {
      throw new AiProviderError('AI provider returned an empty or malformed completion.');
    }

    return {
      text: wire.text,
      modelVersion: wire.model ?? this.config.model,
      usage: { inputTokens: wire.inputTokens, outputTokens: wire.outputTokens },
    };
  }
}
