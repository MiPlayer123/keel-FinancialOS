/**
 * Transactions: walk the full history (filters + cursor), read one in full,
 * get KEEL-computed totals, and make the same edits the app's register does.
 */
import * as z from 'npm:zod@4.4.3';
import {
  defineTool,
  idempotencyKey,
  isoDate,
  minorString,
  readProc,
  rowsOf,
  uuid,
  writeProc,
  type ToolContext,
} from '../context.ts';
import { decodeCursor, encodeCursor, err, money, ok, type ToolErr } from '../lib.ts';
import { computeSplitLegs, summarize, type GroupBy, type TxnRow } from '../summarize.ts';

// ---------------------------------------------------------------------------
// Shared filter contract (list + summarize)
// ---------------------------------------------------------------------------
const filterShape = {
  account_id: uuid('Account').optional(),
  category_id: uuid('Category').optional(),
  tag_id: uuid('Tag').optional(),
  entity_id: uuid('Entity').optional(),
  from: isoDate('First date, inclusive').optional(),
  to: isoDate('End date, exclusive').optional(),
  direction: z.enum(['in', 'out']).optional().describe('Money into or out of the account.'),
  min_amount_minor: z.number().int().nonnegative().optional().describe('Minimum absolute amount, minor units.'),
  max_amount_minor: z.number().int().nonnegative().optional().describe('Maximum absolute amount, minor units.'),
  status: z.enum(['pending', 'posted']).optional(),
  uncategorized: z.boolean().optional().describe('true = only uncategorized; false = only categorized.'),
  search: z.string().min(1).max(200).optional().describe('Matches description, original bank text or account name.'),
};

type Filters = { [K in keyof typeof filterShape]?: z.infer<(typeof filterShape)[K]> };

const toProcFilters = (f: Filters, ids?: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (f.account_id) out['accountId'] = f.account_id;
  if (f.category_id) out['categoryId'] = f.category_id;
  if (f.tag_id) out['tagId'] = f.tag_id;
  if (f.entity_id) out['entityId'] = f.entity_id;
  if (f.from) out['from'] = f.from;
  if (f.to) out['to'] = f.to;
  if (f.direction) out['direction'] = f.direction;
  if (f.min_amount_minor !== undefined) out['minAmountMinor'] = f.min_amount_minor;
  if (f.max_amount_minor !== undefined) out['maxAmountMinor'] = f.max_amount_minor;
  if (f.status) out['status'] = f.status;
  if (f.uncategorized !== undefined) out['uncategorized'] = f.uncategorized;
  if (f.search) out['search'] = f.search;
  if (ids) out['transactionIds'] = ids;
  return out;
};

const queryPage = (
  ctx: ToolContext,
  filters: Record<string, unknown>,
  limit: number,
  cursor: { date: string; id: string } | null,
) =>
  readProc(ctx, 'transactions.rich_page', 'keel_query_transactions', {
    p_filters: filters,
    p_limit: limit,
    p_cursor_date: cursor?.date ?? null,
    p_cursor_id: cursor?.id ?? null,
  });

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------
type Row = TxnRow & Record<string, unknown>;

export const shapeTransaction = (r: Row, detail: 'summary' | 'full'): Record<string, unknown> => {
  const currency = r.currency ?? 'USD';
  const base = {
    id: r.transactionId,
    date: r.effectiveDate,
    description: r.description,
    amount: money(r.amountMinor, currency),
    account: r.accountName,
    category: r.categoryName ?? null,
    status: r['status'],
  };
  if (detail === 'summary') return base;
  const splits = (r.splits ?? []).map((s) => ({
    category_id: s.categoryLedgerAccountId ?? null,
    category: s.name,
    kind: s.kind,
    // Shown from the account's side, like `amount` (splits add up to it).
    amount: money(-BigInt(s.amountMinor ?? '0'), currency),
  }));
  return {
    ...base,
    original_description: r['originalDescription'],
    note: r['note'] ?? null,
    account_id: r.accountId,
    category_id: r.categoryLedgerAccountId ?? null,
    category_kind: r.categoryKind ?? null,
    category_source: r['categorySource'] ?? null,
    splits: splits.length > 0 ? splits : null,
    tags: (r.tags ?? []).map((t) => ({ id: t.tagId, name: t.name })),
    entity_id: r.entityId ?? null,
    transfer: r.transferStatus
      ? {
          status: r.transferStatus,
          link_id: r['transferLinkId'],
          counterparty_account: r['counterpartyAccountName'] ?? null,
          counterparty_transaction_id: r['counterpartyTransactionId'] ?? null,
          booked: r['transferBooked'] === true,
        }
      : null,
    reconciled: r['reconciled'] === true,
    source: r['source'],
  };
};

const loadOne = async (ctx: ToolContext, id: string): Promise<{ ok: true; row: Row } | ToolErr> => {
  const page = await queryPage(ctx, { transactionIds: [id] }, 1, null);
  if (!page.ok) return page;
  const row = rowsOf(page.data)[0] as Row | undefined;
  return row ? { ok: true, row } : err('not_found', 'No such transaction in this household.', 'Find ids with transactions_list.');
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const transactionsList = defineTool({
  name: 'transactions_list',
  title: 'List transactions',
  description:
    'Lists transactions newest first, with optional filters. Returns one page plus next_cursor; pass next_cursor back as cursor until has_more is false to walk the full history. amount is signed from the account\'s side (negative = money out). detail "full" adds ids, notes, splits, tags and transfer info.',
  kind: 'read',
  input: z.object({
    ...filterShape,
    page_size: z.number().int().min(1).max(200).default(50),
    cursor: z.string().max(400).optional().describe('next_cursor from the previous page.'),
    detail: z.enum(['summary', 'full']).default('summary'),
  }).strict(),
  run: async (ctx, args) => {
    const cursor = decodeCursor(args.cursor);
    if (cursor === 'invalid') return err('invalid_cursor', 'That cursor is not valid.', 'Pass next_cursor exactly as returned, or omit it to start over.');
    const page = await queryPage(ctx, toProcFilters(args), args.page_size, cursor);
    if (!page.ok) return page;
    const rows = rowsOf(page.data) as Row[];
    const next = encodeCursor((page.data as { nextCursor?: { effectiveDate: string; transactionId: string } | null }).nextCursor ?? null);
    return ok(`${rows.length} transaction${rows.length === 1 ? '' : 's'}${next ? ' (more available)' : ''}.`, {
      transactions: rows.map((r) => shapeTransaction(r, args.detail)),
      has_more: next !== null,
      next_cursor: next,
    });
  },
});

export const transactionsGet = defineTool({
  name: 'transactions_get',
  title: 'Get a transaction',
  description:
    'Everything about one transaction: display and original bank description, note, category and how it was set, splits, tags, transfer pairing, attached documents, and its change history.',
  kind: 'read',
  input: z.object({ transaction_id: uuid('Transaction') }).strict(),
  run: async (ctx, args) => {
    const one = await loadOne(ctx, args.transaction_id);
    if (!one.ok) return one;
    const [docs, history] = await Promise.all([
      readProc(ctx, 'documents.list_for_target', 'keel_documents_list_for_target', {
        p_target_type: 'transaction',
        p_target_id: args.transaction_id,
      }),
      ctx.db
        .from('audit_log')
        .select('action, actor, at, after')
        .eq('household_id', ctx.householdId)
        .eq('object_id', args.transaction_id)
        .order('at', { ascending: false })
        .limit(25),
    ]);
    const shaped = shapeTransaction(one.row, 'full');
    return ok(`${String(shaped['date'])} ${String(shaped['description'])} ${(shaped['amount'] as { display?: string } | null)?.display ?? ''}`.trim(), {
      transaction: shaped,
      documents: docs.ok
        ? rowsOf(docs.data).map((d) => ({ id: d['documentId'] ?? d['id'], name: d['fileName'] ?? d['name'], kind: d['kind'] }))
        : [],
      history: ((history.data ?? []) as { action: string; actor: Record<string, unknown>; at: string }[]).map((h) => ({
        action: h.action,
        at: h.at,
        by: (h.actor?.['via'] as { clientId?: string } | undefined)?.clientId ? 'connected app' : (h.actor?.['kind'] ?? 'unknown'),
      })),
    });
  },
});

const MAX_SUMMARY_PAGES = 50; // 50 × 200 = 10,000 transactions per summary

export const transactionsSummarize = defineTool({
  name: 'transactions_summarize',
  title: 'Summarize transactions',
  description:
    'KEEL-computed totals for any slice of history, grouped by category, merchant, account, month, tag or entity: money in, money out, net and count per group, plus overall totals. Transfers between the user\'s own accounts are excluded unless include_transfers is true. Use this instead of adding up transactions_list rows.',
  kind: 'read',
  input: z.object({
    ...filterShape,
    group_by: z.enum(['category', 'merchant', 'account', 'month', 'tag', 'entity']),
    include_transfers: z.boolean().default(false),
    max_groups: z.number().int().min(1).max(200).default(50),
  }).strict(),
  run: async (ctx, args) => {
    const filters = toProcFilters(args);
    const rows: Row[] = [];
    let cursor: { date: string; id: string } | null = null;
    let truncated = false;
    for (let i = 0; i < MAX_SUMMARY_PAGES; i++) {
      const page = await queryPage(ctx, filters, 200, cursor);
      if (!page.ok) return page;
      rows.push(...(rowsOf(page.data) as Row[]));
      const next = (page.data as { nextCursor?: { effectiveDate: string; transactionId: string } | null }).nextCursor;
      if (!next) break;
      cursor = { date: next.effectiveDate, id: next.transactionId };
      if (i === MAX_SUMMARY_PAGES - 1) truncated = true;
    }
    const result = summarize(rows, args.group_by as GroupBy, { includeTransfers: args.include_transfers });
    const shown = result.groups.slice(0, args.max_groups);
    return ok(
      `${result.transactionCount} transactions in ${result.groups.length} ${args.group_by} groups.`,
      {
        group_by: args.group_by,
        groups: shown.map((g) => ({
          key: g.key,
          label: g.label,
          money_in: money(g.inflowMinor, g.currency),
          money_out: money(g.outflowMinor, g.currency),
          net: money(g.netMinor, g.currency),
          count: g.count,
        })),
        totals: result.totals.map((t) => ({
          money_in: money(t.inflowMinor, t.currency),
          money_out: money(t.outflowMinor, t.currency),
          net: money(t.netMinor, t.currency),
          count: t.count,
        })),
        transfers_excluded: result.transfersExcluded,
        ...(result.groups.length > shown.length ? { more_groups: result.groups.length - shown.length } : {}),
        ...(truncated ? { truncated: { scanned: rows.length, hint: 'Add a date range to cover the rest.' } } : {}),
      },
    );
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
const splitPart = z.object({
  category_id: uuid('Category'),
  amount_minor: z.string().regex(/^[1-9][0-9]*$/).optional().describe('Positive share in minor units (mode "amounts").'),
  basis_points: z.number().int().min(1).max(10000).optional().describe('Share in basis points, 1% = 100 (mode "percent").'),
}).strict();

const splitArgs = (parts: readonly z.infer<typeof splitPart>[]) =>
  parts.map((p) => ({
    categoryId: p.category_id,
    ...(p.amount_minor ? { amountMinor: p.amount_minor } : {}),
    ...(p.basis_points ? { basisPoints: p.basis_points } : {}),
  }));

const effects = (data: unknown): Record<string, unknown> =>
  ((data as { effects?: Record<string, unknown> } | null)?.effects ?? {}) as Record<string, unknown>;

export const transactionsCreate = defineTool({
  name: 'transactions_create',
  title: 'Add a transaction',
  description:
    'Records a manual transaction in a manual account (for example cash spending). amount_minor is signed from the account\'s side: negative = money out. Give one category_id, or splits (mode "amounts", "percent" or "equal"; KEEL computes and checks the amounts).',
  kind: 'write',
  destructive: false,
  input: z.object({
    account_id: uuid('Account'),
    date: isoDate('Transaction date'),
    description: z.string().min(1).max(500),
    amount_minor: minorString('Signed amount (negative = money out)'),
    category_id: uuid('Category').optional(),
    split_mode: z.enum(['amounts', 'percent', 'equal']).optional(),
    splits: z.array(splitPart).min(2).max(30).optional(),
    status: z.enum(['pending', 'posted']).default('posted'),
    note: z.string().max(2000).optional(),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    if (!!args.category_id === !!args.splits) {
      return err('invalid_request', 'Give either category_id or splits.', 'Call categories_list for category ids.');
    }
    const legs = args.splits
      ? computeSplitLegs(args.amount_minor, args.split_mode ?? 'amounts', splitArgs(args.splits))
      : computeSplitLegs(args.amount_minor, 'equal', [{ categoryId: args.category_id! }]);
    if (!legs.ok) return err('invalid_split', legs.message);
    const res = await ctx.command('transactions.manual_create', {
      accountId: args.account_id,
      description: args.description,
      effectiveDate: args.date,
      amountMinor: args.amount_minor,
      status: args.status,
      splits: legs.legs,
    }, args.idempotency_key);
    if (!res.ok) return res;
    const id = effects(res.data)['canonicalTransactionId'] as string | undefined;
    if (id && args.note) {
      const noted = await writeProc(ctx, null, 'keel_set_transaction_override', {
        p_txn_id: id, p_display_description: null, p_note: args.note,
      });
      if (!noted.ok) return err(noted.code, `The transaction was added (id ${id}) but the note failed: ${noted.message}`);
    }
    return ok(`Added ${args.description}.`, {
      transaction_id: id ?? null,
      undo: id ? { tool: 'transactions_void', args: { transaction_id: id, reason: 'undo' } } : null,
    });
  },
});

export const transactionsUpdate = defineTool({
  name: 'transactions_update',
  title: 'Edit a transaction',
  description:
    'Changes one transaction: category, display name, note, date, or tags. Only the fields you pass change. The original bank description is always kept. Each change is logged and can be undone by setting the old value again (see transactions_get history).',
  kind: 'write',
  destructive: true,
  input: z.object({
    transaction_id: uuid('Transaction'),
    category_id: uuid('Category').optional(),
    display_name: z.string().max(140).optional().describe('Empty string restores the bank description.'),
    note: z.string().max(2000).optional().describe('Empty string clears the note.'),
    date: isoDate('New date').optional(),
    add_tag_ids: z.array(uuid('Tag')).max(20).optional(),
    remove_tag_ids: z.array(uuid('Tag')).max(20).optional(),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    const id = args.transaction_id;
    const done: string[] = [];
    const fail = (what: string, e: ToolErr) =>
      err(e.code, `${done.length ? `Changed ${done.join(', ')}; then ` : ''}${what} failed: ${e.message}`, e.hint);

    if (args.category_id) {
      const r = await writeProc(ctx, 'transactions.categorize', 'keel_categorize_transaction', {
        p_txn_id: id, p_category_ledger_account_id: args.category_id,
      });
      if (!r.ok) return fail('category', r);
      done.push('category');
    }
    if (args.display_name !== undefined || args.note !== undefined) {
      const { data: current } = await ctx.db
        .from('transaction_overrides')
        .select('display_description, note')
        .eq('canonical_transaction_id', id)
        .maybeSingle();
      const r = await writeProc(ctx, null, 'keel_set_transaction_override', {
        p_txn_id: id,
        p_display_description: args.display_name ?? current?.display_description ?? null,
        p_note: args.note ?? current?.note ?? null,
      });
      if (!r.ok) return fail('name/note', r);
      done.push(args.display_name !== undefined && args.note !== undefined ? 'name and note' : args.note !== undefined ? 'note' : 'name');
    }
    if (args.date) {
      const r = await ctx.command('transactions.set_date', { transactionId: id, effectiveDate: args.date },
        args.idempotency_key ? `${args.idempotency_key}.date` : undefined);
      if (!r.ok) return fail('date', r);
      done.push('date');
    }
    for (const [tagIds, assigned] of [[args.add_tag_ids ?? [], true], [args.remove_tag_ids ?? [], false]] as const) {
      for (const tagId of tagIds) {
        const r = await writeProc(ctx, null, 'keel_tag_assign', { p_txn_id: id, p_tag_id: tagId, p_assigned: assigned });
        if (!r.ok) return fail('tags', r);
      }
      if (tagIds.length) done.push(assigned ? 'tags added' : 'tags removed');
    }
    if (done.length === 0) return err('invalid_request', 'Nothing to change.', 'Pass at least one field to change.');
    return ok(`Updated ${done.join(', ')}.`, { transaction_id: id, changed: done });
  },
});

export const transactionsSplit = defineTool({
  name: 'transactions_split',
  title: 'Split a transaction',
  description:
    'Splits one transaction across categories (or re-splits it). mode "amounts": positive shares that add up to the transaction; "percent": basis points adding to 10000; "equal": divide evenly. KEEL computes and validates the exact amounts. A single category un-splits it.',
  kind: 'write',
  destructive: true,
  input: z.object({
    transaction_id: uuid('Transaction'),
    mode: z.enum(['amounts', 'percent', 'equal']),
    splits: z.array(splitPart).min(1).max(30),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    const one = await loadOne(ctx, args.transaction_id);
    if (!one.ok) return one;
    const amount = String(one.row.amountMinor ?? '0');
    const legs = computeSplitLegs(amount, args.mode, splitArgs(args.splits));
    if (!legs.ok) return err('invalid_split', legs.message, 'transactions_get shows the exact amount.');
    const res = await ctx.command('transactions.set_splits', {
      transactionId: args.transaction_id,
      amountMinor: amount,
      splits: legs.legs,
    }, args.idempotency_key);
    if (!res.ok) return res;
    return ok(`Split into ${legs.legs.length} categor${legs.legs.length === 1 ? 'y' : 'ies'}.`, {
      transaction_id: args.transaction_id,
      splits: legs.legs.map((l) => ({ category_id: l.categoryLedgerAccountId, amount: money(-BigInt(l.amountMinor), one.row.currency ?? 'USD') })),
    });
  },
});

export const transactionsCategorize = defineTool({
  name: 'transactions_categorize',
  title: 'Recategorize transactions',
  description:
    'Sets the same category on up to 100 transactions at once (for example every transaction from one merchant). Find the ids with transactions_list first.',
  kind: 'write',
  destructive: true,
  input: z.object({
    transaction_ids: z.array(uuid('Transaction')).min(1).max(100),
    category_id: uuid('Category'),
  }).strict(),
  run: async (ctx, args) => {
    if (!(await ctx.authorize('transactions.categorize'))) {
      return err('not_authorized', 'Your role in this household cannot recategorize.');
    }
    const failed: { transaction_id: string; error: string }[] = [];
    let changed = 0;
    for (const id of new Set(args.transaction_ids)) {
      const r = await writeProc(ctx, null, 'keel_categorize_transaction', {
        p_txn_id: id, p_category_ledger_account_id: args.category_id,
      });
      if (r.ok) changed++;
      else failed.push({ transaction_id: id, error: r.message });
    }
    return ok(`Recategorized ${changed} transaction${changed === 1 ? '' : 's'}${failed.length ? `; ${failed.length} failed` : ''}.`, {
      changed,
      failed,
    });
  },
});

export const transactionsVoid = defineTool({
  name: 'transactions_void',
  title: 'Void a manual transaction',
  description:
    'Voids a transaction the user entered by hand (bank-synced transactions cannot be voided). The record is kept and reversed, not deleted.',
  kind: 'write',
  destructive: true,
  input: z.object({
    transaction_id: uuid('Transaction'),
    reason: z.string().min(1).max(500),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    const res = await ctx.command('transactions.manual_void', {
      transactionId: args.transaction_id,
      reason: args.reason,
    }, args.idempotency_key);
    if (!res.ok) return res;
    return ok('Voided the transaction.', { transaction_id: args.transaction_id });
  },
});

export const transactionTools = [
  transactionsList,
  transactionsGet,
  transactionsSummarize,
  transactionsCreate,
  transactionsUpdate,
  transactionsSplit,
  transactionsCategorize,
  transactionsVoid,
];
