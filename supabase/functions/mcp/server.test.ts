import { createMcpHandler } from 'npm:@modelcontextprotocol/server@2.4.0';
import type { Access, DbResult, ToolContext } from './context.ts';
import { ALL_TOOLS, buildServer, INSTRUCTIONS, runTool, toolsFor } from './server.ts';

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};
const assert: (c: unknown, m?: string) => asserts c = (c, m = 'assertion failed') => {
  if (!c) throw new Error(m);
};

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const TXN = '22222222-2222-4222-8222-222222222222';

/** A stub context: records every proc call and command, answers from `answers`. */
const stubContext = (access: Access, answers: Record<string, unknown> = {}) => {
  const calls: { proc: string; args: Record<string, unknown> }[] = [];
  const commands: { command: string; payload: Record<string, unknown>; key?: string }[] = [];
  const ctx: ToolContext = {
    userId: 'u1',
    clientId: 'client-1',
    householdId: HOUSEHOLD,
    access,
    nowIso: '2026-11-04T12:00:00.000Z',
    todayIso: '2026-11-04',
    db: {},
    rpc: (proc, args): Promise<DbResult> => {
      calls.push({ proc, args });
      return Promise.resolve({ data: answers[proc] ?? { rows: [] }, error: null });
    },
    authorize: () => Promise.resolve(true),
    command: (command, payload, key) => {
      commands.push({ command, payload, ...(key ? { key } : {}) });
      return Promise.resolve({ ok: true, data: { effects: { canonicalTransactionId: TXN } } });
    },
  };
  return { ctx, calls, commands };
};

// ---------------------------------------------------------------------------
// Catalog contract
// ---------------------------------------------------------------------------
Deno.test('catalog: unique snake_case names, titles, plain descriptions', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assertEquals(new Set(names).size, names.length, 'duplicate tool name');
  for (const t of ALL_TOOLS) {
    assert(/^[a-z]+(_[a-z]+)+$/.test(t.name) && t.name.length <= 64, `bad name ${t.name}`);
    assert(t.title.length > 0 && t.description.length > 20, `${t.name} needs a title and description`);
    assert(!/\b(you must|always call|ignore|system prompt)\b/i.test(t.description), `${t.name} description instructs the model`);
  }
});

Deno.test('catalog: read-only grants see only reads; write grants see everything', () => {
  const read = toolsFor('read');
  const write = toolsFor('write');
  assert(read.length >= 15 && read.every((t) => t.kind === 'read'));
  assertEquals(write.length, ALL_TOOLS.length);
  assert(write.findIndex((t) => t.kind === 'write') > read.length - 1, 'reads listed first');
  for (const name of ['overview_get', 'accounts_list', 'accounts_get', 'transactions_list', 'transactions_get', 'transactions_summarize', 'categories_list']) {
    assert(read.some((t) => t.name === name), `missing read ${name}`);
  }
  for (const name of ['accounts_create', 'transactions_create', 'transactions_split', 'transactions_update', 'transactions_categorize', 'categories_create', 'rules_save', 'budgets_set']) {
    assert(write.some((t) => t.name === name && t.kind === 'write'), `missing write ${name}`);
  }
});

Deno.test('catalog: nothing that moves money, connects banks or exports exists', () => {
  for (const t of ALL_TOOLS) {
    assert(!/(payment|pay_|transfer_money|send|plaid|connect|disconnect|export)/.test(t.name), `forbidden capability ${t.name}`);
  }
});

Deno.test('server instructions stay short with essentials first', () => {
  assert(INSTRUCTIONS.length < 1500, 'instructions too long');
  assert(INSTRUCTIONS.slice(0, 512).includes('KEEL'), 'first 512 chars must say what KEEL is');
  assert(INSTRUCTIONS.includes('cannot move money'));
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
Deno.test('a write under a read-only grant is refused before it runs', async () => {
  const { ctx, commands } = stubContext('read');
  const tool = ALL_TOOLS.find((t) => t.name === 'transactions_void')!;
  const res = await runTool(tool, ctx, { transaction_id: TXN, reason: 'dup' });
  assertEquals(res.isError, true);
  assertEquals(JSON.parse(res.content[0]!.text).error.code, 'read_only');
  assertEquals(commands.length, 0);
});

Deno.test('a throwing tool returns a generic error, not internals', async () => {
  const { ctx } = stubContext('write');
  const boom = { ...ALL_TOOLS[0]!, run: () => Promise.reject(new Error('relation secret_table does not exist')) };
  const res = await runTool(boom, ctx, {});
  assertEquals(res.isError, true);
  assert(!res.content[0]!.text.includes('secret_table'));
});

Deno.test('transactions_list passes typed filters and walks the cursor', async () => {
  const { ctx, calls } = stubContext('read', {
    keel_query_transactions: {
      rows: [{ transactionId: TXN, effectiveDate: '2026-06-01', description: 'HARBOR MARKET', amountMinor: '-3000', currency: 'USD', accountName: 'Card', categoryName: 'Groceries', status: 'posted' }],
      nextCursor: { effectiveDate: '2026-06-01', transactionId: TXN },
    },
  });
  const tool = ALL_TOOLS.find((t) => t.name === 'transactions_list')!;
  const res = await runTool(tool, ctx, { from: '2026-01-01', direction: 'out', min_amount_minor: 1000, page_size: 50, detail: 'summary' });
  const body = JSON.parse(res.content[0]!.text);
  assertEquals(calls[0]!.args['p_filters'], { from: '2026-01-01', direction: 'out', minAmountMinor: 1000 });
  assertEquals(calls[0]!.args['p_household_id'], HOUSEHOLD);
  assertEquals(body.transactions[0].amount.display, '-$30.00');
  assertEquals(body.has_more, true);
  await runTool(tool, ctx, { cursor: body.next_cursor, page_size: 50, detail: 'summary' });
  assertEquals(calls[1]!.args['p_cursor_id'], TXN, 'next page starts after the cursor');
});

Deno.test('transactions_create turns a category into a balanced leg and keys idempotency', async () => {
  const { ctx, commands } = stubContext('write');
  const tool = ALL_TOOLS.find((t) => t.name === 'transactions_create')!;
  const res = await runTool(tool, ctx, {
    account_id: '33333333-3333-4333-8333-333333333333',
    date: '2026-11-03',
    description: 'Farmers market',
    amount_minor: '-2400',
    category_id: '44444444-4444-4444-8444-444444444444',
    status: 'posted',
    idempotency_key: 'market-2026-11-03',
  });
  assert(res.isError !== true, res.content[0]!.text);
  assertEquals(commands[0]!.command, 'transactions.manual_create');
  assertEquals(commands[0]!.payload['splits'], [{ categoryLedgerAccountId: '44444444-4444-4444-8444-444444444444', amountMinor: '2400' }]);
  assertEquals(commands[0]!.key, 'market-2026-11-03');
});

Deno.test('transactions_split uses the live amount as the stale-view guard', async () => {
  const { ctx, commands } = stubContext('write', {
    keel_query_transactions: { rows: [{ transactionId: TXN, amountMinor: '-9000', currency: 'USD' }], nextCursor: null },
  });
  const tool = ALL_TOOLS.find((t) => t.name === 'transactions_split')!;
  await runTool(tool, ctx, {
    transaction_id: TXN,
    mode: 'equal',
    splits: [{ category_id: '44444444-4444-4444-8444-444444444444' }, { category_id: '55555555-5555-4555-8555-555555555555' }],
  });
  assertEquals(commands[0]!.payload, {
    transactionId: TXN,
    amountMinor: '-9000',
    splits: [
      { categoryLedgerAccountId: '44444444-4444-4444-8444-444444444444', amountMinor: '4500' },
      { categoryLedgerAccountId: '55555555-5555-4555-8555-555555555555', amountMinor: '4500' },
    ],
  });
});

// ---------------------------------------------------------------------------
// Real MCP round trip through the SDK (2025-era client, what Claude/Codex speak)
// ---------------------------------------------------------------------------
Deno.test('MCP round trip: initialize, tools/list per grant, tools/call', async () => {
  const handlerFor = (access: Access) => {
    const { ctx } = stubContext(access);
    return createMcpHandler(() => buildServer(ctx), { responseMode: 'json' });
  };
  const post = async (handler: ReturnType<typeof handlerFor>, body: unknown) => {
    const res = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
  };

  const readOnly = handlerFor('read');
  const init = await post(readOnly, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assertEquals(init.result.serverInfo.name, 'keel');
  assert(String(init.result.instructions).startsWith('KEEL is'));

  const listed = await post(readOnly, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = listed.result.tools as { name: string; annotations: Record<string, unknown> }[];
  assertEquals(tools.length, toolsFor('read').length);
  assert(tools.every((t) => t.annotations['readOnlyHint'] === true && t.annotations['destructiveHint'] === false));

  const writeTools = (await post(handlerFor('write'), { jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools as { name: string; annotations: Record<string, unknown> }[];
  const voidTool = writeTools.find((t) => t.name === 'transactions_void')!;
  assertEquals(voidTool.annotations, { title: 'Void a manual transaction', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });

  const call = await post(readOnly, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'categories_list', arguments: {} } });
  assertEquals(call.result.structuredContent.summary, '0 categories.');
  const bad = await post(readOnly, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'categories_list', arguments: { bogus: 1 } } });
  assertEquals(bad.result.isError, true, 'unknown arguments are rejected with a readable error');
  const hidden = await post(readOnly, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'transactions_void', arguments: {} } });
  assert(hidden.error || hidden.result?.isError, 'a write tool does not exist for a read-only grant');
});
