/**
 * Tool-calling providers for the KEEL agent loop (packages/ai/tool.ts).
 *
 * Two implementations behind one `AgentProvider` interface (INFRA §11:
 * providers swappable by configuration): an OpenAI-compatible
 * /chat/completions client and an Anthropic /v1/messages client. Both are
 * fetch-based on purpose — no provider SDK import keeps this package pure
 * (verify-purity gate). The API key arrives via config from the caller's
 * secret store (Law 12); it is never logged, echoed into errors, or defaulted.
 */
import type {
  AgentProvider,
  AgentTurn,
  ConverseInput,
  ToolCall,
  ToolDefinition,
  TranscriptEntry,
} from './tool.js';
import { AiProviderError } from './provider.js';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asArgsObject = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value);
  return record ?? {};
};

const parseJsonArgs = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    return asArgsObject(JSON.parse(raw));
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// OpenAI-compatible (/chat/completions with tools)
// ---------------------------------------------------------------------------

export interface OpenAiAgentConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

type OpenAiContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | null | readonly OpenAiContentPart[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

const openAiMessages = (system: string, transcript: readonly TranscriptEntry[]): OpenAiMessage[] => {
  const messages: OpenAiMessage[] = [{ role: 'system', content: system }];
  for (const entry of transcript) {
    switch (entry.role) {
      case 'user':
        messages.push(
          entry.image
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: entry.text },
                  { type: 'image_url', image_url: { url: `data:${entry.image.mediaType};base64,${entry.image.dataBase64}` } },
                ],
              }
            : { role: 'user', content: entry.text },
        );
        break;
      case 'assistant_text':
        messages.push({ role: 'assistant', content: entry.text });
        break;
      case 'assistant_tool_calls':
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: entry.calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        break;
      case 'tool_result':
        for (const r of entry.results) {
          messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        }
        break;
    }
  }
  return messages;
};

const openAiTools = (tools: readonly ToolDefinition[]) =>
  tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

export class OpenAiAgentProvider implements AgentProvider {
  private readonly config: OpenAiAgentConfig;

  constructor(config: OpenAiAgentConfig) {
    if (config.baseUrl.length === 0 || config.model.length === 0 || config.apiKey.length === 0) {
      throw new AiProviderError('AI provider is not configured.');
    }
    this.config = config;
  }

  async converse(input: ConverseInput): Promise<AgentTurn> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: openAiMessages(input.system, input.transcript),
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.2,
    };
    if (input.tools.length > 0) {
      payload['tools'] = openAiTools(input.tools);
      payload['tool_choice'] = 'auto';
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
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

    const root = asRecord(body);
    const choices = root?.['choices'];
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
    const message = asRecord(choice?.['message']);
    if (message === null) {
      throw new AiProviderError('AI provider returned a malformed completion.');
    }
    const usageRoot = asRecord(root?.['usage']);
    const usage = {
      inputTokens: asFiniteNumber(usageRoot?.['prompt_tokens']),
      outputTokens: asFiniteNumber(usageRoot?.['completion_tokens']),
    };
    const modelVersion = typeof root?.['model'] === 'string' ? root['model'] : this.config.model;

    const rawToolCalls = message['tool_calls'];
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      const calls: ToolCall[] = [];
      for (const raw of rawToolCalls) {
        const rec = asRecord(raw);
        const fn = asRecord(rec?.['function']);
        const name = fn?.['name'];
        const id = rec?.['id'];
        if (typeof name === 'string' && typeof id === 'string') {
          calls.push({ id, name, args: parseJsonArgs(fn?.['arguments']) });
        }
      }
      if (calls.length > 0) {
        return { kind: 'tool_calls', calls, modelVersion, usage };
      }
    }

    const content = message['content'];
    const text = typeof content === 'string' ? content : '';
    return { kind: 'message', text, modelVersion, usage };
  }
}

// ---------------------------------------------------------------------------
// Anthropic (/v1/messages with tools)
// ---------------------------------------------------------------------------

export interface AnthropicAgentConfig {
  /** e.g. https://api.anthropic.com — from config, never hardcoded by callers. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** anthropic-version header value, e.g. 2023-06-01. */
  readonly anthropicVersion: string;
  readonly fetchImpl?: typeof fetch;
}

type AnthropicBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string };
    }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly AnthropicBlock[];
}

const anthropicMessages = (transcript: readonly TranscriptEntry[]): AnthropicMessage[] => {
  const messages: AnthropicMessage[] = [];
  for (const entry of transcript) {
    switch (entry.role) {
      case 'user':
        messages.push({
          role: 'user',
          content: entry.image
            ? [
                { type: 'text', text: entry.text },
                { type: 'image', source: { type: 'base64', media_type: entry.image.mediaType, data: entry.image.dataBase64 } },
              ]
            : [{ type: 'text', text: entry.text }],
        });
        break;
      case 'assistant_text':
        messages.push({ role: 'assistant', content: [{ type: 'text', text: entry.text }] });
        break;
      case 'assistant_tool_calls':
        messages.push({
          role: 'assistant',
          content: entry.calls.map((c) => ({
            type: 'tool_use' as const,
            id: c.id,
            name: c.name,
            input: c.args,
          })),
        });
        break;
      case 'tool_result':
        messages.push({
          role: 'user',
          content: entry.results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.toolCallId,
            content: r.content,
          })),
        });
        break;
    }
  }
  return messages;
};

const anthropicTools = (tools: readonly ToolDefinition[]) =>
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

export class AnthropicAgentProvider implements AgentProvider {
  private readonly config: AnthropicAgentConfig;

  constructor(config: AnthropicAgentConfig) {
    if (
      config.baseUrl.length === 0 ||
      config.model.length === 0 ||
      config.apiKey.length === 0 ||
      config.anthropicVersion.length === 0
    ) {
      throw new AiProviderError('AI provider is not configured.');
    }
    this.config = config;
  }

  async converse(input: ConverseInput): Promise<AgentTurn> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload: Record<string, unknown> = {
      model: this.config.model,
      system: input.system,
      messages: anthropicMessages(input.transcript),
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.2,
    };
    if (input.tools.length > 0) {
      payload['tools'] = anthropicTools(input.tools);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': this.config.anthropicVersion,
        },
        body: JSON.stringify(payload),
      });
    } catch {
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

    const root = asRecord(body);
    const content = root?.['content'];
    if (!Array.isArray(content)) {
      throw new AiProviderError('AI provider returned a malformed completion.');
    }
    const usageRoot = asRecord(root?.['usage']);
    const usage = {
      inputTokens: asFiniteNumber(usageRoot?.['input_tokens']),
      outputTokens: asFiniteNumber(usageRoot?.['output_tokens']),
    };
    const modelVersion = typeof root?.['model'] === 'string' ? root['model'] : this.config.model;

    const calls: ToolCall[] = [];
    const textParts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      const type = block?.['type'];
      if (type === 'tool_use') {
        const id = block?.['id'];
        const name = block?.['name'];
        if (typeof id === 'string' && typeof name === 'string') {
          calls.push({ id, name, args: asArgsObject(block?.['input']) });
        }
      } else if (type === 'text') {
        const text = block?.['text'];
        if (typeof text === 'string') textParts.push(text);
      }
    }

    if (calls.length > 0) {
      return { kind: 'tool_calls', calls, modelVersion, usage };
    }
    return { kind: 'message', text: textParts.join('\n'), modelVersion, usage };
  }
}
