import { describe, expect, it } from 'vitest';

import {
  AiProviderError,
  OpenAiCompatibleChatProvider,
  type ChatMessage,
} from '../src/index.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'q' },
];

const okBody = {
  model: 'test-model-001',
  choices: [{ message: { role: 'assistant', content: 'answer text' } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
};

type FetchArgs = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured?: FetchArgs[]): typeof fetch {
  return (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured?.push({ url: typeof url === 'string' ? url : 'non-string-url', init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

describe('OpenAiCompatibleChatProvider', () => {
  it('posts to {baseUrl}/chat/completions with the configured model and key', async () => {
    const calls: FetchArgs[] = [];
    const provider = new OpenAiCompatibleChatProvider({
      baseUrl: 'https://gateway.example/v1/',
      model: 'test-model-001',
      apiKey: 'sk-secret',
      fetchImpl: fakeFetch(200, okBody, calls),
    });
    const completion = await provider.complete(messages, { maxTokens: 99 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gateway.example/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-secret');
    const payload = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(payload['model']).toBe('test-model-001');
    expect(payload['max_tokens']).toBe(99);

    expect(completion.text).toBe('answer text');
    expect(completion.modelVersion).toBe('test-model-001');
    expect(completion.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it('fails closed on HTTP errors without echoing the body or the key', async () => {
    const provider = new OpenAiCompatibleChatProvider({
      baseUrl: 'https://gateway.example/v1',
      model: 'm',
      apiKey: 'sk-secret',
      fetchImpl: fakeFetch(429, { error: { message: 'rate limited, key sk-secret' } }),
    });
    const failure = await provider.complete(messages).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).status).toBe(429);
    expect((failure as AiProviderError).message).not.toContain('sk-secret');
    expect((failure as AiProviderError).message).not.toContain('rate limited');
  });

  it('fails closed on transport errors with a constant message (Law 12)', async () => {
    const provider = new OpenAiCompatibleChatProvider({
      baseUrl: 'https://gateway.example/v1',
      model: 'm',
      apiKey: 'sk-secret',
      fetchImpl: () =>
        Promise.reject(new Error('connect failed: https://gateway.example/v1?key=sk-secret')),
    });
    const failure = await provider.complete(messages).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).message).toBe('AI provider request failed.');
  });

  it('fails closed on empty or malformed completions', async () => {
    for (const body of [
      {},
      { choices: [] },
      { choices: [{ message: { content: '' } }] },
      { choices: [{ message: { content: '   ' } }] },
      { choices: [{ message: {} }] },
    ]) {
      const provider = new OpenAiCompatibleChatProvider({
        baseUrl: 'https://gateway.example/v1',
        model: 'm',
        apiKey: 'k',
        fetchImpl: fakeFetch(200, body),
      });
      await expect(provider.complete(messages)).rejects.toBeInstanceOf(AiProviderError);
    }
  });

  it('rejects construction with missing configuration (never a silent default key)', () => {
    expect(
      () => new OpenAiCompatibleChatProvider({ baseUrl: '', model: 'm', apiKey: 'k' }),
    ).toThrow(AiProviderError);
    expect(
      () => new OpenAiCompatibleChatProvider({ baseUrl: 'https://x', model: 'm', apiKey: '' }),
    ).toThrow(AiProviderError);
  });
});
