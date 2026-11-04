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

Deno.test('transactions_split books a paycheck: gross, withholding and a 401(k) leg into another account', async () => {
  const INCOME = '44444444-4444-4444-8444-444444444444';
  const TAX = '55555555-5555-4555-8555-555555555555';
  const K401 = '66666666-6666-4666-8666-666666666666';
  const { ctx, commands } = stubContext('write', {
    keel_query_transactions: { rows: [{ transactionId: TXN, amountMinor: '26619', currency: 'USD' }], nextCursor: null },
  });
  const res = await runTool(tool('transactions_split'), ctx, {
    transaction_id: TXN,
    mode: 'amounts',
    splits: [
      { category_id: INCOME, amount_minor: '71250' },
      { category_id: TAX, amount_minor: '-9006' },
      { account_id: K401, amount_minor: '-35625' },
    ],
  });
  // Debit-positive legs summing to −26619: income credited, tax debited, the 401(k) receives 356.25.
  assertEquals(commands[0]!.payload['splits'], [
    { categoryLedgerAccountId: INCOME, amountMinor: '-71250' },
    { categoryLedgerAccountId: TAX, amountMinor: '9006' },
    { accountId: K401, amountMinor: '35625' },
  ]);
  const body = JSON.parse(res.content[0]!.text);
  assertEquals(body.splits.map((s: { share: { amount_minor: string } }) => s.share.amount_minor), ['71250', '-9006', '-35625']);
  assertEquals(body.splits[2].account_id, K401);

  // Shares that do not add up to the deposit never reach KEEL.
  const before = commands.length;
  const bad = await runTool(tool('transactions_split'), ctx, {
    transaction_id: TXN,
    mode: 'amounts',
    splits: [{ category_id: INCOME, amount_minor: '71250' }, { account_id: K401, amount_minor: '-35625' }],
  });
  assertEquals(JSON.parse(bad.content[0]!.text).error.code, 'invalid_split');
  // A leg names a category or an account, not both.
  const both = await runTool(tool('transactions_split'), ctx, {
    transaction_id: TXN,
    mode: 'amounts',
    splits: [{ category_id: INCOME, account_id: K401, amount_minor: '26619' }],
  });
  assertEquals(JSON.parse(both.content[0]!.text).error.code, 'invalid_split');
  assertEquals(commands.length, before);
});

Deno.test('catalog size stays in the 35–45 band (18 read, 24 write)', () => {
  assertEquals(toolsFor('read').length, 18);
  assertEquals(ALL_TOOLS.length, 42);
});

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;
const callsTo = (calls: { proc: string; args: Record<string, unknown> }[], proc: string) => calls.filter((c) => c.proc === proc);

Deno.test('receipts: inbox items carry what KEEL read and the suggested match; attach and decide use the app commands', async () => {
  const { ctx, commands } = stubContext('write', {
    keel_receipts_inbox: [
      {
        documentId: 'doc-1', originalFilename: 'market.jpg', createdAt: '2026-11-02T10:00:00Z',
        extraction: { status: 'succeeded', merchant: 'Harbor Market', amountMinor: '4500', currency: 'USD', txnDate: '2026-11-02', confidence: 0.92 },
        match: { matchId: 'match-1', status: 'suggested', transactionId: TXN, txnDescription: 'HARBOR MARKET', txnAmountMinor: '-4500', txnDate: '2026-11-02', txnAccountName: 'Card', score: 0.9 },
      },
      { documentId: 'doc-2', originalFilename: 'done.jpg', createdAt: '2026-11-01T10:00:00Z', extraction: null, match: { matchId: 'm2', status: 'confirmed' } },
    ],
  });
  const review = await runTool(tool('review_list'), ctx, { limit: 50 });
  const body = JSON.parse(review.content[0]!.text);
  assertEquals(body.receipts.rows.length, 1, 'confirmed (attached) receipts are not pending');
  assertEquals(body.receipts.rows[0].read_from_receipt.total.display, '$45.00');
  assertEquals(body.receipts.rows[0].suggested_match.item_id, 'match-1');

  await runTool(tool('review_decide'), ctx, { item_type: 'receipt_match', item_id: '66666666-6666-4666-8666-666666666666', accept: true });
  await runTool(tool('receipts_attach'), ctx, { document_id: '77777777-7777-4777-8777-777777777777', transaction_id: TXN });
  assertEquals(commands.map((c) => c.command), ['receipts.decide_match', 'documents.attach']);
  assertEquals(commands[0]!.payload, { matchId: '66666666-6666-4666-8666-666666666666', confirm: true });
  assertEquals(commands[1]!.payload, { documentId: '77777777-7777-4777-8777-777777777777', targetType: 'transaction', targetId: TXN });
});

Deno.test('edits keep the fields they do not change (tasks, notes, bills)', async () => {
  const TASK = '88888888-8888-4888-8888-888888888888';
  const NOTE = '99999999-9999-4999-8999-999999999999';
  const BILL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const { ctx, calls } = stubContext('write', {
    keel_list_notes_tasks: { rows: [
      { type: 'task', id: TASK, title: 'Call the bank', description: 'About the fee', dueOn: '2026-11-10', priority: 'high' },
      { type: 'note', id: NOTE, body: 'Pinned note', pinned: true },
    ] },
    keel_list_schedules: { rows: [{ scheduleId: BILL }] },
  });
  await runTool(tool('tasks_save'), ctx, { task_id: TASK, title: 'Call the bank today' });
  assertEquals(callsTo(calls, 'keel_task_save')[0]!.args, {
    p_household_id: HOUSEHOLD, p_task_id: TASK, p_title: 'Call the bank today', p_description: 'About the fee', p_due_on: '2026-11-10', p_priority: 'high',
  });
  await runTool(tool('tasks_save'), ctx, { task_id: TASK, status: 'done' });
  assertEquals(callsTo(calls, 'keel_task_save').length, 1, 'a status-only change does not rewrite the task');
  assertEquals(callsTo(calls, 'keel_task_set_status')[0]!.args['p_status'], 'done');

  await runTool(tool('notes_save'), ctx, { note_id: NOTE, body: 'Edited' });
  assertEquals(callsTo(calls, 'keel_note_save')[0]!.args['p_pinned'], true, 'editing the text keeps the pin');
  await runTool(tool('notes_save'), ctx, { note_id: NOTE, archived: true });
  assertEquals(callsTo(calls, 'keel_note_archive').length, 1);

  await runTool(tool('bills_save'), ctx, { bill_id: BILL, status: 'paused' });
  assertEquals(callsTo(calls, 'keel_schedule_save').length, 0, 'pausing does not rewrite the bill');
  assertEquals(callsTo(calls, 'keel_schedule_set_status')[0]!.args['p_status'], 'paused');
});

Deno.test('bills: moving the due date re-anchors (stored anchors are echoed only for semimonthly)', async () => {
  const BILL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { ctx, calls } = stubContext('write', {
    keel_list_schedules: { rows: [{
      scheduleId: BILL, accountId: '33333333-3333-4333-8333-333333333333', description: 'Rent', amountMinor: '-150000',
      categoryLedgerAccountId: null, frequency: 'monthly', nextDueDate: '2026-11-15', autoEnterDays: null, anchorDay: 15, anchorDay2: null,
    }] },
  });
  await runTool(tool('bills_save'), ctx, { bill_id: BILL, next_due: '2026-11-20' });
  const saved = callsTo(calls, 'keel_schedule_save')[0]!.args;
  assertEquals([saved['p_next_due_date'], saved['p_anchor_day'], saved['p_description'], saved['p_amount_minor']], ['2026-11-20', null, 'Rent', '-150000']);
});

Deno.test('notes: edit before archive; restoring an active note is a no-op restore', async () => {
  const NOTE = '99999999-9999-4999-8999-999999999999';
  const { ctx, calls } = stubContext('write', { keel_list_notes_tasks: { rows: [{ type: 'note', id: NOTE, body: 'Old', pinned: true }] } });
  await runTool(tool('notes_save'), ctx, { note_id: NOTE, body: 'New', archived: true });
  assertEquals(calls.map((c) => c.proc).filter((p) => p !== 'keel_list_notes_tasks'), ['keel_note_save', 'keel_note_archive']);
  const before = calls.length;
  const res = await runTool(tool('notes_save'), ctx, { note_id: NOTE, archived: false });
  assert(res.isError !== true);
  assertEquals(calls.slice(before).filter((c) => c.proc === 'keel_note_unarchive').length, 0, 'an active note is not "restored"');
  const nothing = await runTool(tool('notes_save'), ctx, { note_id: NOTE });
  assertEquals(nothing.isError, true);
});

Deno.test('review_list leaves out receipts already attached (by a match or receipts_attach)', async () => {
  const { ctx } = stubContext('read', {
    keel_receipts_inbox: [
      { documentId: 'doc-a', originalFilename: 'a.jpg', extraction: null, match: { matchId: 'm-a', status: 'suggested' } },
      { documentId: 'doc-b', originalFilename: 'b.jpg', extraction: null, match: null },
    ],
    keel_documents_list_household: { rows: [{ documentId: 'doc-a', attachmentCount: 1 }, { documentId: 'doc-b', attachmentCount: 0 }] },
  });
  const body = JSON.parse((await runTool(tool('review_list'), ctx, { limit: 50 })).content[0]!.text);
  assertEquals(body.receipts.rows.map((r: { document_id: string }) => r.document_id), ['doc-b']);
});

/** A chainable stand-in for supabase-js table reads: every filter returns the table's rows. */
const fakeDb = (tables: Record<string, unknown[]>) => ({
  from: (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'is']) query[method] = () => query;
    query['then'] = (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null });
    return query;
  },
});

Deno.test('accounts_list values a synced investment account at the bank figure, like the app and net worth', async () => {
  const account = (id: string, name: string, subtype: string, ledger: string, connection: string | null) => ({
    id, name, subtype, currency: 'USD', entity_id: null, connection_id: connection, mask: null, archived_at: null, ledger_account_id: ledger,
  });
  const { ctx } = stubContext('read', {
    keel_trial_balance: { rows: [
      { ledgerAccountId: 'L1', balanceMinor: '5000' },
      { ledgerAccountId: 'L2', balanceMinor: '700' },
      { ledgerAccountId: 'L3', balanceMinor: '100' },
    ] },
    keel_latest_balances: [
      { accountId: 'a1', currentMinor: '9000', availableMinor: null, limitMinor: null, asOf: '2026-11-01' },
      { accountId: 'a3', currentMinor: '150', availableMinor: '150', limitMinor: null, asOf: '2026-11-01' },
    ],
    keel_investments_overview: { holdings: [{ accountId: 'a1', valueMinor: '4000' }] },
  });
  const withDb: ToolContext = {
    ...ctx,
    db: fakeDb({
      accounts: [
        account('a1', 'Brokerage', 'brokerage', 'L1', 'c1'),
        account('a2', 'Roth (manual)', 'retirement', 'L2', null),
        account('a3', 'Checking', 'checking', 'L3', 'c1'),
      ],
      ledger_accounts: [{ id: 'L1', kind: 'asset' }, { id: 'L2', kind: 'asset' }, { id: 'L3', kind: 'asset' }],
      connections: [{ id: 'c1', display_name: 'Bank', status: 'active', last_successful_sync_at: null }],
      entities: [],
    }),
  };
  const body = JSON.parse((await runTool(tool('accounts_list'), withDb, {})).content[0]!.text);
  const byId = Object.fromEntries(body.accounts.map((a: { id: string }) => [a.id, a]));
  assertEquals(byId.a1.balance.amount_minor, '9000', 'synced investment: bank-reported value');
  assertEquals(byId.a1.holdings_value.amount_minor, '4000', 'holdings alongside');
  assertEquals(byId.a2.balance.amount_minor, '700', 'manual investment: ledger');
  assertEquals(byId.a3.balance.amount_minor, '100', 'non-investment: ledger, even when the bank differs');
});

Deno.test('budgets_get says what is left: remaining = available − spent (negative when over)', async () => {
  const { ctx } = stubContext('read', {
    keel_budget_month: {
      total: { resolvedMinor: '50000', currency: 'USD' },
      rows: [
        { categoryLedgerAccountId: 'c1', categoryName: 'Transport', resolvedMinor: '13000', spentMinor: '997', availableMinor: '13000', rollover: false, currency: 'USD' },
        { categoryLedgerAccountId: 'c2', categoryName: 'Food', resolvedMinor: '10000', spentMinor: '12550', availableMinor: '10000', rollover: false, currency: 'USD' },
      ],
    },
  });
  const body = JSON.parse((await runTool(tool('budgets_get'), ctx, {})).content[0]!.text);
  assertEquals(body.categories.map((c: { remaining: { amount_minor: string } }) => c.remaining.amount_minor), ['12003', '-2550']);
});

Deno.test('budgets_get passes through the parent rollup (rolled_up, group totals)', async () => {
  const { ctx } = stubContext('read', {
    keel_budget_month: {
      total: { resolvedMinor: '50000', currency: 'USD' },
      rows: [
        { categoryLedgerAccountId: 'p', categoryName: 'Food', resolvedMinor: '35000', spentMinor: '79883', availableMinor: '35000', rollover: false, currency: 'USD',
          groupResolvedMinor: '50000', groupSpentMinor: '91339', rolledUpCategoryNames: ['Bars', 'Restaurants'] },
        { categoryLedgerAccountId: 'c', categoryName: 'Groceries', parentLedgerAccountId: 'p', resolvedMinor: '15000', spentMinor: '11456', availableMinor: '15000', rollover: false, currency: 'USD' },
      ],
    },
  });
  const body = JSON.parse((await runTool(tool('budgets_get'), ctx, {})).content[0]!.text);
  const [food, groceries] = body.categories;
  assertEquals(food.rolled_up, ['Bars', 'Restaurants']);
  assertEquals(food.group_target.amount_minor, '50000');
  assertEquals(food.group_spent.amount_minor, '91339');
  assertEquals(groceries.rolled_up, null);
  assertEquals(groceries.group_target, null);
});

Deno.test('recurring_list shows live items by default; status widens it', async () => {
  const series = (status: string) => ({ seriesId: status, counterpartyKey: status, status, sign: 'outflow', occurrences: [] });
  const { ctx } = stubContext('read', {
    keel_list_recurring: { rows: ['confirmed', 'suggested', 'paused', 'rejected', 'withdrawn', 'cancelled'].map(series) },
  });
  const statuses = async (args: Record<string, unknown>) =>
    JSON.parse((await runTool(tool('recurring_list'), ctx, args)).content[0]!.text).recurring.map((s: { status: string }) => s.status);
  assertEquals(await statuses({}), ['confirmed', 'suggested', 'paused']);
  assertEquals(await statuses({ status: 'rejected' }), ['rejected']);
  assertEquals((await statuses({ status: 'all' })).length, 6);
});

Deno.test('archive lives on the update tools', async () => {
  const { ctx, calls } = stubContext('write');
  await runTool(tool('accounts_update'), ctx, { account_id: '33333333-3333-4333-8333-333333333333', archived: true });
  assertEquals(callsTo(calls, 'keel_set_account_archived')[0]!.args['p_archived'], true);
  await runTool(tool('categories_update'), ctx, { category_id: '44444444-4444-4444-8444-444444444444', archived: true });
  assertEquals(callsTo(calls, 'keel_archive_category').length, 1);
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
