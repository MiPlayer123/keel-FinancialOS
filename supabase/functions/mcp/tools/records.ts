/**
 * The review queue, transfers, notes and tasks, the activity log, and the
 * remaining read-only ledgers (paychecks, reimbursements, statements).
 */
import * as z from 'npm:zod@4.4.3';
import { capped, defineTool, readProc, rowsOf, uuid, writeProc } from '../context.ts';
import { err, money, ok } from '../lib.ts';

/** Internal bookkeeping keys a model never needs (detector fingerprints, raw evidence). */
const NOISE = new Set(['evidence', 'statusEvents', 'inputFingerprint', 'detectorVersion', 'confidenceVersion', 'normalizerVersion', 'candidateVersionHash']);
const compact = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !NOISE.has(k)));

const listTool = (name: string, title: string, description: string, procs: readonly { key: string; action: string | null; proc: string }[]) =>
  defineTool({
    name,
    title,
    description: `${description} Amounts are integer minor units.`,
    kind: 'read',
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
    run: async (ctx, args) => {
      const results = await Promise.all(procs.map((p) => readProc(ctx, p.action, p.proc)));
      const out: Record<string, unknown> = {};
      const counts: string[] = [];
      for (const [i, p] of procs.entries()) {
        const r = results[i]!;
        if (!r.ok) return r;
        const rows = rowsOf(r.data).map(compact);
        out[p.key] = capped(rows, args.limit);
        counts.push(`${rows.length} ${p.key.replace(/_/g, ' ')}`);
      }
      return ok(`${counts.join(', ')}.`, out);
    },
  });

export const paychecksList = listTool(
  'paychecks_list',
  'List paychecks',
  'Recorded paychecks with gross-to-net components, saved templates, and detected paychecks not yet reviewed.',
  [
    { key: 'paychecks', action: 'paychecks.list', proc: 'keel_list_paychecks' },
    { key: 'templates', action: 'paychecks.templates', proc: 'keel_list_paycheck_templates' },
    { key: 'split_suggestions', action: 'paychecks.split_suggestions', proc: 'keel_list_paycheck_split_suggestions' },
  ],
);

export const reimbursementsList = listTool(
  'reimbursements_list',
  'List reimbursements',
  'Reimbursement claims (money owed back to the user, settled or open) and expected reimbursements.',
  [
    { key: 'claims', action: 'reimbursements.list', proc: 'keel_list_reimbursements' },
    { key: 'expected', action: 'expected_reimbursements.list', proc: 'keel_list_expected_reimbursements' },
  ],
);

export const statementsList = listTool(
  'statements_list',
  'List statements',
  'Account statements and reconciliations, plus statement drafts waiting for review.',
  [
    { key: 'statements', action: 'statements.list', proc: 'keel_list_statements' },
    { key: 'drafts', action: 'statements.drafts', proc: 'keel_list_statement_drafts' },
  ],
);

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------
export const reviewList = defineTool({
  name: 'review_list',
  title: 'List the review queue',
  description:
    'What KEEL is waiting on the user to decide: suggested categories for transactions and suggested transfer matches between accounts. Decide them with review_decide.',
  kind: 'read',
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
  run: async (ctx, args) => {
    const [suggestions, transfers] = await Promise.all([
      readProc(ctx, null, 'keel_list_category_suggestions'),
      readProc(ctx, 'transfers.list', 'keel_list_transfers'),
    ]);
    if (!suggestions.ok) return suggestions;
    if (!transfers.ok) return transfers;
    const cats = rowsOf(suggestions.data)
      .filter((s) => (s['status'] ?? 'suggested') === 'suggested')
      .map((s) => ({
        item_type: 'category_suggestion',
        item_id: s['suggestionId'] ?? s['id'],
        transaction_id: s['transactionId'] ?? s['canonicalTransactionId'],
        transaction: s['description'] ?? null,
        amount: money(s['amountMinor'] as string | null, (s['currency'] as string) ?? 'USD'),
        date: s['effectiveDate'] ?? null,
        suggested_category: s['suggestedCategoryName'] ?? s['categoryName'] ?? null,
        reason: s['reasonCode'] ?? null,
      }));
    const pairs = rowsOf(transfers.data)
      .filter((t) => t['status'] === 'suggested')
      .map((t) => ({
        item_type: 'transfer_match',
        item_id: t['linkId'],
        date: t['effectiveDate'],
        amount: money(t['amountMinor'] as string | null, (t['currency'] as string) ?? 'USD'),
        from: { account: t['outAccountName'], description: t['outDescription'], transaction_id: t['outTxnId'] },
        to: { account: t['inAccountName'], description: t['inDescription'], transaction_id: t['inTxnId'] },
        days_apart: t['dayGap'],
      }));
    return ok(`${cats.length} category suggestions, ${pairs.length} transfer matches.`, {
      category_suggestions: capped(cats, args.limit),
      transfer_matches: capped(pairs, args.limit),
    });
  },
});

export const reviewDecide = defineTool({
  name: 'review_decide',
  title: 'Accept or reject a review item',
  description:
    'Accepts or rejects one item from review_list: a category suggestion (accepting applies the category) or a transfer match (accepting pairs the two transactions as a transfer).',
  kind: 'write',
  destructive: true,
  input: z.object({
    item_type: z.enum(['category_suggestion', 'transfer_match']),
    item_id: uuid('Review item'),
    accept: z.boolean(),
  }).strict(),
  run: async (ctx, args) => {
    const r = args.item_type === 'category_suggestion'
      ? await ctx.command('categorization.decide_suggestion', { suggestionId: args.item_id, accept: args.accept }, undefined)
      : await writeProc(ctx, null, 'keel_decide_transfer', { p_link_id: args.item_id, p_confirm: args.accept });
    if (!r.ok) return r;
    return ok(args.accept ? 'Accepted.' : 'Rejected.', { item_type: args.item_type, item_id: args.item_id });
  },
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
export const transfersLink = defineTool({
  name: 'transfers_link',
  title: 'Mark a transfer',
  description:
    'Marks a transaction as a transfer between the user\'s own accounts so it is not counted as income or spending. Pair it with the matching transaction on the other account (counterpart_transaction_id), or, when the other account is manual and has no matching entry (e.g. an ATM withdrawal into a "Cash" account), book the other side there (counterparty_account_id).',
  kind: 'write',
  destructive: false,
  input: z.object({
    transaction_id: uuid('Transaction'),
    counterpart_transaction_id: uuid('Matching transaction').optional(),
    counterparty_account_id: uuid('Manual account to book the other side in').optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/).optional(),
  }).strict(),
  run: async (ctx, args) => {
    if (!!args.counterpart_transaction_id === !!args.counterparty_account_id) {
      return err('invalid_request', 'Give either counterpart_transaction_id or counterparty_account_id.');
    }
    const r = args.counterpart_transaction_id
      ? await writeProc(ctx, null, 'keel_link_and_confirm_transfer', { p_txn_a: args.transaction_id, p_txn_b: args.counterpart_transaction_id })
      : await writeProc(ctx, null, 'keel_book_transfer_counterparty', {
          p_source_txn_id: args.transaction_id,
          p_counterparty_account_id: args.counterparty_account_id,
          p_attempt_key: args.idempotency_key ?? crypto.randomUUID(),
        });
    if (!r.ok) return r;
    const linkId = (r.data as { linkId?: string } | null)?.linkId ?? (typeof r.data === 'string' ? r.data : null);
    return ok('Marked as a transfer.', {
      link_id: linkId,
      undo: linkId ? { tool: 'transfers_unlink', args: { link_id: linkId } } : null,
    });
  },
});

export const transfersUnlink = defineTool({
  name: 'transfers_unlink',
  title: 'Undo a transfer',
  description: 'Undoes a transfer pairing (and reverses a booked other side, if KEEL booked one). link_id comes from transactions_get.',
  kind: 'write',
  destructive: true,
  input: z.object({ link_id: uuid('Transfer link') }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_undo_transfer', { p_link_id: args.link_id });
    if (!r.ok) return r;
    return ok('Undid the transfer.', { link_id: args.link_id });
  },
});

// ---------------------------------------------------------------------------
// Notes and tasks
// ---------------------------------------------------------------------------
export const notesList = defineTool({
  name: 'notes_list',
  title: 'List notes and tasks',
  description: 'The household\'s notes and tasks (open, done or dismissed), newest first.',
  kind: 'read',
  input: z.object({ include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  run: async (ctx, args) => {
    const r = await readProc(ctx, 'notes_tasks.list', 'keel_list_notes_tasks');
    if (!r.ok) return r;
    const rows = rowsOf(r.data).filter((x) => args.include_archived || !x['archivedAt']);
    return ok(`${rows.length} notes and tasks.`, capped(rows, args.limit));
  },
});

export const notesSave = defineTool({
  name: 'notes_save',
  title: 'Write a note',
  description: 'Creates a household note (omit note_id) or replaces an existing note\'s text.',
  kind: 'write',
  destructive: false,
  input: z.object({
    note_id: uuid('Note').optional(),
    body: z.string().min(1).max(1000),
    pinned: z.boolean().default(false),
  }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, 'notes.save', 'keel_note_save', { p_note_id: args.note_id ?? null, p_body: args.body, p_pinned: args.pinned });
    if (!r.ok) return r;
    const id = args.note_id ?? (typeof r.data === 'string' ? r.data : null);
    return ok(args.note_id ? 'Updated the note.' : 'Saved the note.', {
      note_id: id,
      undo: !args.note_id && id ? { tool: 'notes_archive', args: { note_id: id, archived: true } } : null,
    });
  },
});

export const notesArchive = defineTool({
  name: 'notes_archive',
  title: 'Archive or restore a note',
  description: 'Archives a note (archived true) or restores it (false). Nothing is deleted.',
  kind: 'write',
  destructive: true,
  input: z.object({ note_id: uuid('Note'), archived: z.boolean() }).strict(),
  run: async (ctx, args) => {
    const r = args.archived
      ? await writeProc(ctx, 'notes.archive', 'keel_note_archive', { p_note_id: args.note_id })
      : await writeProc(ctx, 'notes.unarchive', 'keel_note_unarchive', { p_note_id: args.note_id });
    if (!r.ok) return r;
    return ok(args.archived ? 'Archived the note.' : 'Restored the note.', { note_id: args.note_id });
  },
});

export const tasksSave = defineTool({
  name: 'tasks_save',
  title: 'Create or edit a task',
  description: 'Creates a to-do (omit task_id) or edits one: title, details, due date and priority.',
  kind: 'write',
  destructive: false,
  input: z.object({
    task_id: uuid('Task').optional(),
    title: z.string().min(1).max(160),
    description: z.string().max(1000).optional(),
    due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, 'tasks.save', 'keel_task_save', {
      p_task_id: args.task_id ?? null,
      p_title: args.title,
      p_description: args.description ?? null,
      p_due_on: args.due_on ?? null,
      p_priority: args.priority,
    });
    if (!r.ok) return r;
    const id = args.task_id ?? (typeof r.data === 'string' ? r.data : null);
    return ok(args.task_id ? 'Updated the task.' : 'Added the task.', { task_id: id });
  },
});

export const tasksSetStatus = defineTool({
  name: 'tasks_set_status',
  title: 'Complete, reopen or dismiss a task',
  description: 'Sets a task to done, open or dismissed.',
  kind: 'write',
  destructive: true,
  input: z.object({ task_id: uuid('Task'), status: z.enum(['open', 'done', 'dismissed']) }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, 'tasks.set_status', 'keel_task_set_status', { p_task_id: args.task_id, p_status: args.status });
    if (!r.ok) return r;
    return ok(`Task is now ${args.status}.`, { task_id: args.task_id });
  },
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
export const activityList = defineTool({
  name: 'activity_list',
  title: 'List recent activity',
  description:
    'The household\'s change log, newest first: what changed, when, and whether the user or a connected app (like this one) did it. Page with before_id.',
  kind: 'read',
  input: z.object({
    limit: z.number().int().min(1).max(100).default(30),
    before_id: z.number().int().positive().optional().describe('next_before_id from the previous page.'),
  }).strict(),
  run: async (ctx, args) => {
    if (!(await ctx.authorize('audit.read'))) return err('not_authorized', 'Your role in this household cannot read the activity log.');
    let q = ctx.db
      .from('audit_log')
      .select('id, action, object_type, object_id, actor, at')
      .eq('household_id', ctx.householdId)
      .order('id', { ascending: false })
      .limit(args.limit);
    if (args.before_id) q = q.lt('id', args.before_id);
    const { data, error } = await q;
    if (error) return err('failed', 'Could not read the activity log.');
    const rows = (data ?? []) as { id: number; action: string; object_type: string; object_id: string | null; actor: Record<string, unknown>; at: string }[];
    return ok(`${rows.length} changes.`, {
      activity: rows.map((r) => ({
        at: r.at,
        action: r.action,
        object: { type: r.object_type, id: r.object_id },
        by: (r.actor?.['via'] as { clientId?: string } | undefined)?.clientId
          ? { kind: 'connected_app', client_id: (r.actor['via'] as { clientId: string }).clientId }
          : { kind: r.actor?.['kind'] ?? 'unknown' },
      })),
      next_before_id: rows.length === args.limit ? rows[rows.length - 1]!.id : null,
    });
  },
});

export const recordTools = [
  reviewList,
  reviewDecide,
  transfersLink,
  transfersUnlink,
  notesList,
  notesSave,
  notesArchive,
  tasksSave,
  tasksSetStatus,
  paychecksList,
  reimbursementsList,
  statementsList,
  activityList,
];
