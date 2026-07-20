import { describe, expect, it } from 'vitest';

import {
  AiProviderError,
  AnthropicAgentProvider,
  OpenAiAgentProvider,
  type ConverseInput,
  type ToolDefinition,
} from '../src/index.js';

const tools: ToolDefinition[] = [
  {
    name: 'get_balances',
    description: 'balances',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const baseInput: ConverseInput = {
  system: 'sys',
  transcript: [{ role: 'user', text: 'balance?' }],
  tools,
};

type FetchArgs = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured?: FetchArgs[]): typeof fetch {
  return (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured?.push({ url: typeof url === 'string' ? url : 'non-string', init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  };
}

describe('OpenAiAgentProvider', () => {
  it('parses a tool_calls turn and sends tools in the payload', async () => {
    const calls: FetchArgs[] = [];
    const provider = new OpenAiAgentProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-x',
      apiKey: 'sk-secret',
      fetchImpl: fakeFetch(
        200,
        {
          model: 'gpt-x',
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  { id: 'tc1', type: 'function', function: { name: 'get_balances', arguments: '{"householdId":"h1"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3 },
        },
        calls,
      ),
    });
    const turn = await provider.converse(baseInput);
    expect(turn.kind).toBe('tool_calls');
    if (turn.kind === 'tool_calls') {
      expect(turn.calls).toEqual([{ id: 'tc1', name: 'get_balances', args: { householdId: 'h1' } }]);
    }
    const payload = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(payload['tools']).toBeDefined();
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-secret');
  });

  it('parses a plain message turn', async () => {
    const provider = new OpenAiAgentProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-x',
      apiKey: 'k',
      fetchImpl: fakeFetch(200, {
        model: 'gpt-x',
        choices: [{ message: { role: 'assistant', content: 'Balance is $10.' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    });
    const turn = await provider.converse(baseInput);
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Balance is $10.');
  });

  it('fails closed on HTTP error without leaking the key', async () => {
    const provider = new OpenAiAgentProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      apiKey: 'sk-secret',
      fetchImpl: fakeFetch(401, { error: 'bad key sk-secret' }),
    });
    const failure = await provider.converse(baseInput).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect((failure as AiProviderError).message).not.toContain('sk-secret');
  });
});

describe('AnthropicAgentProvider', () => {
  const cfg = {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-x',
    apiKey: 'sk-ant-secret',
    anthropicVersion: '2023-06-01',
  };

  it('parses a tool_use turn and sets anthropic headers', async () => {
    const calls: FetchArgs[] = [];
    const provider = new AnthropicAgentProvider({
      ...cfg,
      fetchImpl: fakeFetch(
        200,
        {
          model: 'claude-x',
          content: [{ type: 'tool_use', id: 'tu1', name: 'get_balances', input: { householdId: 'h1' } }],
          usage: { input_tokens: 9, output_tokens: 1 },
        },
        calls,
      ),
    });
    const turn = await provider.converse(baseInput);
    expect(turn.kind).toBe('tool_calls');
    if (turn.kind === 'tool_calls') {
      expect(turn.calls).toEqual([{ id: 'tu1', name: 'get_balances', args: { householdId: 'h1' } }]);
    }
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('joins text blocks into a message turn', async () => {
    const provider = new AnthropicAgentProvider({
      ...cfg,
      fetchImpl: fakeFetch(200, {
        model: 'claude-x',
        content: [
          { type: 'text', text: 'Balance is $10.' },
          { type: 'text', text: 'Nothing else pending.' },
        ],
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
    });
    const turn = await provider.converse(baseInput);
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Balance is $10.\nNothing else pending.');
  });

  it('omits tools from the payload when none are offered (forced answer)', async () => {
    const calls: FetchArgs[] = [];
    const provider = new AnthropicAgentProvider({
      ...cfg,
      fetchImpl: fakeFetch(
        200,
        { model: 'claude-x', content: [{ type: 'text', text: 'done' }], usage: {} },
        calls,
      ),
    });
    await provider.converse({ ...baseInput, tools: [] });
    const payload = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(payload['tools']).toBeUndefined();
  });

  it('requires full configuration', () => {
    expect(() => new AnthropicAgentProvider({ ...cfg, apiKey: '' })).toThrow(AiProviderError);
    expect(() => new AnthropicAgentProvider({ ...cfg, anthropicVersion: '' })).toThrow(AiProviderError);
  });
});
