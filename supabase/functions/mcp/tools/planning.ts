/**
 * Planning: budgets, recurring income/bills (detected series + scheduled
 * bills), and goals — reads plus the same edits the app's planning pages make.
 */
import * as z from 'npm:zod@4.4.3';
import { defineTool, isoDate, minorString, readProc, rowsOf, uuid, writeProc } from '../context.ts';
import { err, money, monthStart, ok, type ToolErr } from '../lib.ts';

const RECURRING_HORIZON_DAYS = 90; // same horizon the app's Review page uses

/** a − b on minor-unit strings (BigInt; null when either is missing). */
const minus = (a: unknown, b: unknown): string | null =>
  typeof a === 'string' && typeof b === 'string' ? (BigInt(a) - BigInt(b)).toString() : null;

/** What recurring_list shows unless asked: items still in play, not ones the user or KEEL set aside. */
const LIVE_RECURRING = new Set(['suggested', 'confirmed', 'paused']);

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
export const budgetsGet = defineTool({
  name: 'budgets_get',
  title: 'Get a month\'s budget',
  description:
    'A month\'s plan: total, expected income, left to budget, and per category the target, spent, rollover carry, available (target plus carry-in) and remaining (available minus spent; negative = over budget). Defaults to the current month.',
  kind: 'read',
  input: z.object({ month: isoDate('Any date in the month').optional() }).strict(),
  run: async (ctx, args) => {
    const month = monthStart(args.month ?? ctx.todayIso);
    const r = await readProc(ctx, 'budgets.month', 'keel_budget_month', { p_month: month });
    if (!r.ok) return r;
    const data = r.data as Record<string, unknown>;
    const total = (data['total'] ?? {}) as Record<string, unknown>;
    const currency = (total['currency'] as string) ?? 'USD';
    const categories = rowsOf(data).map((c) => ({
      category_id: c['categoryLedgerAccountId'],
      category: c['categoryName'],
      parent_id: c['parentLedgerAccountId'] ?? null,
      target: money(c['resolvedMinor'] as string | null, (c['currency'] as string) ?? currency),
      spent: money(c['spentMinor'] as string | null, (c['currency'] as string) ?? currency),
      rollover: c['rollover'] === true,
      carried_in: money(c['carryMinor'] as string | null, (c['currency'] as string) ?? currency),
      available: money(c['availableMinor'] as string | null, (c['currency'] as string) ?? currency),
      remaining: money(minus(c['availableMinor'], c['spentMinor']), (c['currency'] as string) ?? currency),
    }));
    return ok(`Budget for ${month.slice(0, 7)}: ${categories.length} category targets.`, {
      month,
      total: money(total['resolvedMinor'] as string | null, currency),
      expected_income: money(data['expectedIncomeMinor'] as string | null, currency),
      left_to_budget: money(data['leftToBudgetMinor'] as string | null, currency),
      everything_else_spent: money(data['everythingElseSpentMinor'] as string | null, currency),
      categories,
    });
  },
});

export const budgetsSet = defineTool({
  name: 'budgets_set',
  title: 'Set budget amounts',
  description:
    'Sets a month\'s budget: a category target (target_minor, optional rollover), removes a category target (remove_target true), and/or sets the overall total or expected income. Amounts are non-negative minor units. Applies from that month on.',
  kind: 'write',
  destructive: true,
  input: z.object({
    month: isoDate('Any date in the month'),
    category_id: uuid('Category').optional(),
    target_minor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    rollover: z.boolean().optional(),
    remove_target: z.boolean().optional(),
    total_minor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
    expected_income_minor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  }).strict(),
  run: async (ctx, args) => {
    const month = monthStart(args.month);
    const done: string[] = [];
    const fail = (what: string, e: ToolErr) =>
      err(e.code, `${done.length ? `Set ${done.join(', ')}; then ` : ''}${what} failed: ${e.message}`, e.hint);
    if ((args.target_minor !== undefined || args.remove_target) && !args.category_id) {
      return err('invalid_request', 'A category target needs category_id.', 'categories_list has the ids.');
    }
    if (args.category_id && args.remove_target) {
      const r = await ctx.command('budgets.remove_target', { month, categoryLedgerAccountId: args.category_id }, undefined);
      if (!r.ok) return fail('removing the target', r);
      done.push('target removed');
    } else if (args.category_id && args.target_minor !== undefined) {
      const r = await ctx.command('budgets.set_target', {
        month,
        categoryLedgerAccountId: args.category_id,
        kind: 'amount',
        amountMinor: args.target_minor,
        ...(args.rollover !== undefined ? { rollover: args.rollover } : {}),
      }, undefined);
      if (!r.ok) return fail('target', r);
      done.push('category target');
    }
    if (args.total_minor !== undefined) {
      const r = await ctx.command('budgets.set_total', { month, basis: 'amount', amountMinor: args.total_minor }, undefined);
      if (!r.ok) return fail('total', r);
      done.push('total');
    }
    if (args.expected_income_minor !== undefined) {
      const r = await ctx.command('budgets.set_expected_income', { month, amountMinor: args.expected_income_minor }, undefined);
      if (!r.ok) return fail('expected income', r);
      done.push('expected income');
    }
    if (done.length === 0) return err('invalid_request', 'Nothing to set.');
    return ok(`Set ${done.join(', ')} for ${month.slice(0, 7)}.`, { month, changed: done });
  },
});

// ---------------------------------------------------------------------------
// Recurring series + scheduled bills
// ---------------------------------------------------------------------------
export const recurringList = defineTool({
  name: 'recurring_list',
  title: 'List recurring items and bills',
  description:
    'Recurring income and charges KEEL detected (subscriptions, rent, paychecks…) with cadence, typical amount, status and next expected date, plus scheduled bills the user set up. By default only items still in play (suggested, confirmed, paused); pass status for one other status, or "all".',
  kind: 'read',
  input: z.object({
    status: z.enum(['suggested', 'confirmed', 'paused', 'cancelled', 'rejected', 'withdrawn', 'all']).optional(),
  }).strict(),
  run: async (ctx, args) => {
    const [series, bills] = await Promise.all([
      readProc(ctx, 'recurring.list', 'keel_list_recurring'),
      readProc(ctx, null, 'keel_list_schedules'),
    ]);
    if (!series.ok) return series;
    const recurring = rowsOf(series.data)
      .filter((s) =>
        args.status === 'all' ? true : args.status ? s['status'] === args.status : LIVE_RECURRING.has(s['status'] as string)
      )
      .map((s) => {
        const currency = (s['currency'] as string) ?? 'USD';
        const next = ((s['occurrences'] ?? []) as Record<string, unknown>[])
          .filter((o) => o['status'] === 'expected' && String(o['expectedDate'] ?? '') >= ctx.todayIso)
          .sort((a, b) => String(a['expectedDate']).localeCompare(String(b['expectedDate'])))[0];
        return {
          series_id: s['seriesId'],
          name: s['counterpartyKey'],
          account_id: s['accountId'],
          direction: s['sign'] === 'inflow' ? 'in' : 'out',
          cadence: s['cadence'],
          typical_amount: money(s['representativeAmountMinor'] as string | null, currency),
          amount_kind: s['amountKind'],
          status: s['status'],
          last_seen: s['lastSeen'] ?? null,
          next_expected: next ? { date: next['expectedDate'], amount: money(next['expectedAmountMinor'] as string | null, currency) } : null,
          occurrences: s['occurrenceCount'] ?? null,
        };
      });
    const scheduled = bills.ok
      ? rowsOf(bills.data).map((b) => ({
          bill_id: b['scheduleId'],
          description: b['description'],
          account_id: b['accountId'],
          amount: money(b['amountMinor'] as string | null, (b['currency'] as string) ?? 'USD'),
          category: b['categoryName'] ?? null,
          frequency: b['frequency'],
          next_due: b['nextDueDate'],
          status: b['status'],
        }))
      : [];
    return ok(`${recurring.length} recurring series, ${scheduled.length} scheduled bills.`, { recurring, bills: scheduled });
  },
});

const TRANSITION: Record<string, string> = {
  confirmed: 'recurring.confirm',
  paused: 'recurring.pause',
  resumed: 'recurring.resume',
  cancelled: 'recurring.cancel',
  rejected: 'recurring.reject',
};

export const recurringUpdate = defineTool({
  name: 'recurring_update',
  title: 'Update a recurring item',
  description:
    'Confirms, pauses, resumes, cancels or rejects a detected recurring series, and/or sets its expected amount (signed, negative = money out) from today on.',
  kind: 'write',
  destructive: true,
  input: z.object({
    series_id: uuid('Recurring series'),
    status: z.enum(['confirmed', 'paused', 'resumed', 'cancelled', 'rejected']).optional(),
    amount_minor: minorString('Expected amount (negative = money out)').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const done: string[] = [];
    if (args.status) {
      const command = TRANSITION[args.status]!;
      const r = await ctx.command(command, {
        seriesId: args.series_id,
        effectiveDate: ctx.todayIso,
        ...(command === 'recurring.confirm' || command === 'recurring.resume' ? { horizonDays: RECURRING_HORIZON_DAYS } : {}),
      }, undefined);
      if (!r.ok) return r;
      done.push(args.status);
    }
    if (args.amount_minor) {
      const r = await ctx.command('recurring.set_amount', {
        seriesId: args.series_id,
        amountMinor: args.amount_minor,
        effectiveDate: ctx.todayIso,
        horizonDays: RECURRING_HORIZON_DAYS,
      }, undefined);
      if (!r.ok) return err(r.code, `${done.length ? `Marked ${done[0]}; then ` : ''}setting the amount failed: ${r.message}`, r.hint);
      done.push('amount');
    }
    if (done.length === 0) return err('invalid_request', 'Nothing to change.');
    return ok(`Updated the series: ${done.join(', ')}.`, { series_id: args.series_id, changed: done });
  },
});

const FREQUENCIES = ['once', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'semiannual', 'annual'] as const;

export const billsSave = defineTool({
  name: 'bills_save',
  title: 'Create, edit, pause or end a scheduled bill',
  description:
    'Creates (omit bill_id) or edits a scheduled bill or recurring manual entry on an account: amount (signed, negative = money out), category, frequency, next due date, and status (active, paused or ended; nothing is deleted). When editing, only the fields you pass change. auto_enter_days > 0 records it automatically that many days before it is due.',
  kind: 'write',
  destructive: true,
  input: z.object({
    bill_id: uuid('Bill').optional(),
    account_id: uuid('Account').optional(),
    description: z.string().min(1).max(140).optional(),
    amount_minor: minorString('Amount (negative = money out)').optional(),
    category_id: uuid('Category').nullable().optional(),
    frequency: z.enum(FREQUENCIES).optional(),
    next_due: isoDate('Next due date').optional(),
    auto_enter_days: z.number().int().min(0).max(30).nullable().optional(),
    day_of_month: z.number().int().min(1).max(31).nullable().optional(),
    second_day_of_month: z.number().int().min(1).max(31).nullable().optional().describe('Semimonthly only.'),
    status: z.enum(['active', 'paused', 'ended']).optional(),
  }).strict(),
  run: async (ctx, args) => {
    if (args.amount_minor === '0') return err('invalid_money', 'Amount cannot be zero.');
    const fieldKeys = ['account_id', 'description', 'amount_minor', 'category_id', 'frequency', 'next_due', 'auto_enter_days', 'day_of_month', 'second_day_of_month'] as const;
    const editsFields = fieldKeys.some((k) => args[k] !== undefined);
    let current: Record<string, unknown> = {};
    // Reactivate first: keel_list_schedules hides ended bills, so an edit that
    // also brings an ended bill back could not find it otherwise.
    const reactivateFirst = args.bill_id !== undefined && args.status === 'active' && editsFields;
    if (reactivateFirst) {
      const r = await writeProc(ctx, null, 'keel_schedule_set_status', { p_schedule_id: args.bill_id, p_status: 'active' });
      if (!r.ok) return r;
    }
    if (args.bill_id && editsFields) {
      const list = await readProc(ctx, null, 'keel_list_schedules');
      if (!list.ok) return list;
      const row = rowsOf(list.data).find((b) => b['scheduleId'] === args.bill_id);
      if (!row) return err('not_found', 'No such bill in this household.', 'recurring_list has the bill ids.');
      current = row;
    } else if (!args.bill_id) {
      const missing = (['account_id', 'description', 'amount_minor', 'frequency', 'next_due'] as const).filter((k) => args[k] === undefined);
      if (missing.length) return err('invalid_request', `A new bill needs ${missing.join(', ')}.`);
    }
    let billId = args.bill_id ?? null;
    if (!args.bill_id || editsFields) {
      const pickArg = <T>(v: T | undefined, fallback: unknown) => (v !== undefined ? v : (fallback ?? null));
      // Days of month are anchors only for semimonthly bills; for every other
      // frequency keel_schedule_save re-anchors on the new due date when the
      // anchor is null (as the app sends), so never echo a stored one back.
      const frequency = pickArg(args.frequency, current['frequency']);
      const semimonthly = frequency === 'semimonthly';
      const r = await writeProc(ctx, null, 'keel_schedule_save', {
        p_schedule_id: args.bill_id ?? null,
        p_account_id: pickArg(args.account_id, current['accountId']),
        p_description: pickArg(args.description, current['description']),
        p_amount_minor: pickArg(args.amount_minor, current['amountMinor']),
        p_category_ledger_account_id: pickArg(args.category_id, current['categoryLedgerAccountId']),
        p_frequency: frequency,
        p_next_due_date: pickArg(args.next_due, current['nextDueDate']),
        p_auto_enter_days: pickArg(args.auto_enter_days, current['autoEnterDays']),
        p_anchor_day: semimonthly ? pickArg(args.day_of_month, current['anchorDay']) : (args.day_of_month ?? null),
        p_anchor_day_2: semimonthly ? pickArg(args.second_day_of_month, current['anchorDay2']) : null,
      });
      if (!r.ok) return r;
      billId ??= typeof r.data === 'string' ? r.data : null;
    }
    if (args.status && billId && !reactivateFirst) {
      const r = await writeProc(ctx, null, 'keel_schedule_set_status', { p_schedule_id: billId, p_status: args.status });
      if (!r.ok) return err(r.code, `${editsFields || !args.bill_id ? 'Saved the bill; then ' : ''}setting status failed: ${r.message}`, r.hint);
    }
    if (args.bill_id && !editsFields && !args.status) return err('invalid_request', 'Nothing to change.');
    return ok(args.bill_id ? 'Updated the bill.' : 'Scheduled the bill.', { bill_id: billId });
  },
});

export const billsEnter = defineTool({
  name: 'bills_enter',
  title: 'Record a bill now',
  description:
    'Records the next occurrence of a scheduled bill as a transaction today (or skips it with skip true) and advances the bill to its following due date.',
  kind: 'write',
  destructive: false,
  input: z.object({
    bill_id: uuid('Bill'),
    due_date: isoDate('The due date being recorded (from recurring_list next_due)'),
    skip: z.boolean().default(false),
  }).strict(),
  run: async (ctx, args) => {
    const r = args.skip
      ? await writeProc(ctx, null, 'keel_schedule_advance', { p_schedule_id: args.bill_id, p_from_due: args.due_date, p_reason: 'skipped' })
      : await writeProc(ctx, null, 'keel_schedule_enter', { p_schedule_id: args.bill_id, p_from_due: args.due_date });
    if (!r.ok) return r;
    return ok(args.skip ? 'Skipped this occurrence.' : 'Recorded the bill.', { bill_id: args.bill_id, result: r.data });
  },
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------
export const goalsList = defineTool({
  name: 'goals_list',
  title: 'List goals',
  description: 'Savings and debt-payoff goals with target, progress, target date and status.',
  kind: 'read',
  input: z.object({}).strict(),
  run: async (ctx) => {
    const r = await readProc(ctx, 'goals.list', 'keel_list_goals');
    if (!r.ok) return r;
    const goals = rowsOf(r.data).map((g) => {
      const c = (g['currency'] as string) ?? 'USD';
      return {
        goal_id: g['goalId'],
        name: g['name'],
        kind: g['kind'],
        tracking: g['tracking'],
        status: g['status'],
        target: money(g['targetMinor'] as string | null, c),
        target_date: g['targetDate'] ?? null,
        account_id: g['accountId'] ?? null,
        // Progress as KEEL computes it: saved (savings, manual), paid (debt), or the tracked account balance.
        saved: money(g['savedMinor'] as string | null, c),
        paid: money(g['paidMinor'] as string | null, c),
        tracked_balance: money((g['trackedBalanceMinor'] ?? g['currentBalanceMinor']) as string | null, c),
      };
    });
    return ok(`${goals.length} goals.`, { goals });
  },
});

export const goalsSave = defineTool({
  name: 'goals_save',
  title: 'Create or edit a goal',
  description:
    'Creates (omit goal_id) or edits a savings or debt goal. tracking "account_balance" follows a linked account; "manual" counts contributions. status sets active or archived (KEEL marks a goal reached on its own). When editing, only the fields you pass change.',
  kind: 'write',
  destructive: true,
  input: z.object({
    goal_id: uuid('Goal').optional(),
    name: z.string().min(1).max(120).optional(),
    kind: z.enum(['savings', 'debt']).optional(),
    target_minor: z.string().regex(/^[1-9][0-9]*$/).optional(),
    target_date: isoDate('Target date').nullable().optional(),
    tracking: z.enum(['manual', 'account_balance']).optional(),
    account_id: uuid('Linked account').nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  }).strict(),
  run: async (ctx, args) => {
    const editsFields = (['name', 'kind', 'target_minor', 'target_date', 'tracking', 'account_id'] as const).some((k) => args[k] !== undefined);
    let current: Record<string, unknown> = {};
    if (args.goal_id && editsFields) {
      const list = await readProc(ctx, 'goals.list', 'keel_list_goals');
      if (!list.ok) return list;
      const row = rowsOf(list.data).find((g) => g['goalId'] === args.goal_id);
      if (!row) return err('not_found', 'No such goal in this household.', 'goals_list has the ids.');
      current = row;
    } else if (!args.goal_id && (!args.name || !args.kind || !args.target_minor)) {
      return err('invalid_request', 'A new goal needs name, kind and target_minor.');
    }
    let goalId = args.goal_id ?? null;
    if (!args.goal_id || editsFields) {
      const r = await writeProc(ctx, null, 'keel_goal_save', {
        p_goal_id: args.goal_id ?? null,
        p_name: args.name ?? current['name'],
        p_target_minor: args.target_minor ?? current['targetMinor'],
        p_target_date: args.target_date !== undefined ? args.target_date : (current['targetDate'] ?? null),
        p_account_id: args.account_id !== undefined ? args.account_id : (current['accountId'] ?? null),
        p_kind: args.kind ?? current['kind'],
        p_tracking: args.tracking ?? current['tracking'] ?? 'manual',
      });
      if (!r.ok) return r;
      goalId ??= typeof r.data === 'string' ? r.data : (r.data as { goalId?: string } | null)?.goalId ?? null;
    }
    if (args.status && goalId) {
      const s = await writeProc(ctx, null, 'keel_goal_set_status', { p_goal_id: goalId, p_status: args.status });
      if (!s.ok) return err(s.code, `${editsFields || !args.goal_id ? 'Saved the goal, but s' : 'S'}etting status failed: ${s.message}`, s.hint);
    }
    if (args.goal_id && !editsFields && !args.status) return err('invalid_request', 'Nothing to change.');
    return ok(args.goal_id ? 'Updated the goal.' : 'Created the goal.', { goal_id: goalId });
  },
});

export const goalsContribute = defineTool({
  name: 'goals_contribute',
  title: 'Log a goal contribution',
  description: 'Records a contribution toward a manually tracked goal (positive minor units).',
  kind: 'write',
  destructive: false,
  input: z.object({
    goal_id: uuid('Goal'),
    amount_minor: z.string().regex(/^[1-9][0-9]*$/),
    date: isoDate('Contribution date').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const r = await writeProc(ctx, null, 'keel_goal_contribute', {
      p_goal_id: args.goal_id, p_amount_minor: args.amount_minor, p_contributed_on: args.date ?? ctx.todayIso,
    });
    if (!r.ok) return r;
    return ok('Logged the contribution.', { goal_id: args.goal_id });
  },
});

export const planningTools = [
  budgetsGet,
  budgetsSet,
  recurringList,
  recurringUpdate,
  billsSave,
  billsEnter,
  goalsList,
  goalsSave,
  goalsContribute,
];
