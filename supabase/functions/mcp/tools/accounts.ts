/**
 * Accounts: every account with its balance, one account in full, and the
 * same manual-account actions the app offers (add, rename, move entity, set
 * starting balance, re-anchor to the bank, archive).
 *
 * Balances match the app: the ledger balance per account (assets positive,
 * debts negative — they add up to net worth), with market value for
 * investment accounts and the bank-reported balance alongside when synced.
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
import { dbError, err, money, ok, type ToolErr } from '../lib.ts';

interface AccountRow {
  id: string;
  name: string;
  subtype: string;
  currency: string;
  entity_id: string | null;
  connection_id: string | null;
  mask: string | null;
  archived_at: string | null;
  ledger_account_id: string;
}

const loadAccounts = async (ctx: ToolContext, includeArchived: boolean) => {
  if (!(await ctx.authorize('ledger.trial_balance'))) {
    return err('not_authorized', 'Your role in this household cannot read balances.') as ToolErr;
  }
  let q = ctx.db
    .from('accounts')
    .select('id, name, subtype, currency, entity_id, connection_id, mask, archived_at, ledger_account_id')
    .eq('household_id', ctx.householdId)
    .order('name');
  if (!includeArchived) q = q.is('archived_at', null);
  const [accounts, ledgers, connections, entities, trial, latest, investments] = await Promise.all([
    q,
    ctx.db.from('ledger_accounts').select('id, kind').eq('household_id', ctx.householdId).eq('is_category', false),
    ctx.db.from('connections').select('id, display_name, status, last_successful_sync_at').eq('household_id', ctx.householdId),
    ctx.db.from('entities').select('id, name').eq('household_id', ctx.householdId),
    ctx.rpc('keel_trial_balance', { p_household_id: ctx.householdId }),
    ctx.rpc('keel_latest_balances', { p_household_id: ctx.householdId }),
    ctx.rpc('keel_investments_overview', { p_household_id: ctx.householdId }),
  ]);
  if (accounts.error) return dbError(accounts.error);
  if (trial.error) return dbError(trial.error);

  const kindOf = new Map((ledgers.data ?? []).map((l: { id: string; kind: string }) => [l.id, l.kind]));
  const connOf = new Map<unknown, Record<string, unknown>>(
    (connections.data ?? []).map((c: Record<string, unknown>) => [c['id'], c]),
  );
  const entityOf = new Map((entities.data ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));
  const ledgerBalance = new Map(rowsOf(trial.data).map((r) => [r['ledgerAccountId'], r['balanceMinor'] as string]));
  const bank = new Map(
    (Array.isArray(latest.data) ? latest.data : []).map((b: Record<string, unknown>) => [b['accountId'], b]),
  );
  const marketValue = new Map<string, bigint>();
  for (const h of ((investments.data as { holdings?: Record<string, unknown>[] } | null)?.holdings ?? [])) {
    const id = h['accountId'] as string;
    marketValue.set(id, (marketValue.get(id) ?? 0n) + BigInt((h['valueMinor'] as string | null) ?? '0'));
  }

  const shaped = ((accounts.data ?? []) as AccountRow[]).map((a) => {
    const conn = a.connection_id ? connOf.get(a.connection_id) : undefined;
    const reported = bank.get(a.id) as Record<string, unknown> | undefined;
    return {
      id: a.id,
      name: a.name,
      type: a.subtype,
      kind: kindOf.get(a.ledger_account_id) ?? null,
      mask: a.mask,
      entity: a.entity_id ? { id: a.entity_id, name: entityOf.get(a.entity_id) ?? null } : null,
      // Archived accounts leave KEEL's trial balance: report no balance rather than an invented $0.
      balance: ledgerBalance.has(a.ledger_account_id)
        ? money(ledgerBalance.get(a.ledger_account_id)!, a.currency)
        : a.archived_at ? null : money('0', a.currency),
      ...(marketValue.has(a.id) ? { market_value: money(marketValue.get(a.id)!, a.currency) } : {}),
      ...(reported
        ? {
            bank_reported: {
              current: money(reported['currentMinor'] as string, a.currency),
              available: money(reported['availableMinor'] as string | null, a.currency),
              credit_limit: money(reported['limitMinor'] as string | null, a.currency),
              as_of: reported['asOf'],
            },
          }
        : {}),
      source: conn
        ? { kind: 'bank_sync', institution: conn['display_name'] ?? null, status: conn['status'], last_synced: conn['last_successful_sync_at'] ?? null }
        : { kind: 'manual' },
      archived: a.archived_at !== null,
    };
  });
  return { ok: true as const, accounts: shaped, entities: [...entityOf].map(([id, name]) => ({ id, name })) };
};

export const accountsList = defineTool({
  name: 'accounts_list',
  title: 'List accounts',
  description:
    'Every account in the household: type, institution or manual, sync status, ledger balance (assets positive, debts negative; they add up to net worth), market value for investment accounts, bank-reported balance when synced, and entity. Also lists the household\'s entities.',
  kind: 'read',
  input: z.object({ include_archived: z.boolean().default(false) }).strict(),
  run: async (ctx, args) => {
    const res = await loadAccounts(ctx, args.include_archived);
    if (!res.ok) return res;
    return ok(`${res.accounts.length} account${res.accounts.length === 1 ? '' : 's'}.`, {
      accounts: res.accounts,
      entities: res.entities,
    });
  },
});

export const accountsGet = defineTool({
  name: 'accounts_get',
  title: 'Get an account',
  description:
    'One account in full: balance, bank-reported balance, daily balance history for a date range (default last 90 days), holdings for investment accounts, and scheduled bills on it.',
  kind: 'read',
  input: z.object({
    account_id: uuid('Account'),
    from: isoDate('History start').optional(),
    to: isoDate('History end').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const all = await loadAccounts(ctx, true);
    if (!all.ok) return all;
    const account = all.accounts.find((a) => a.id === args.account_id);
    if (!account) return err('not_found', 'No such account in this household.', 'Find ids with accounts_list.');
    const to = args.to ?? ctx.todayIso;
    const from = args.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
    const [history, holdings, bills] = await Promise.all([
      readProc(ctx, null, 'keel_account_balance_daily', { p_account_id: args.account_id, p_from: from, p_to: to }),
      readProc(ctx, 'holdings.list', 'keel_list_holdings', { p_account_id: args.account_id }),
      readProc(ctx, null, 'keel_list_schedules'),
    ]);
    const points = history.ok ? ((history.data as { points?: Record<string, unknown>[] } | null)?.points ?? rowsOf(history.data)) : [];
    return ok(`${account.name}: ${account.balance?.display ?? 'no balance'}.`, {
      account,
      balance_history: {
        from,
        to,
        points: points.map((p) => ({ date: p['date'], balance: money(p['balanceMinor'] as string, (p['currency'] as string) ?? 'USD') })),
      },
      holdings: holdings.ok ? rowsOf(holdings.data).slice(0, 100) : [],
      bills: bills.ok ? rowsOf(bills.data).filter((b) => b['accountId'] === args.account_id).slice(0, 50) : [],
    });
  },
});

const MANUAL_TYPES = {
  cash: 'asset',
  checking: 'asset',
  savings: 'asset',
  investment: 'asset',
  property: 'asset',
  vehicle: 'asset',
  other_asset: 'asset',
  credit_card: 'liability',
  loan: 'liability',
  other_liability: 'liability',
} as const;

export const accountsCreate = defineTool({
  name: 'accounts_create',
  title: 'Add a manual account',
  description:
    'Adds an account KEEL tracks by hand (cash, property, a car, a loan, an unlinked card…), optionally with a starting balance. starting_balance_minor is the real-world amount: money held for assets, amount owed for debts.',
  kind: 'write',
  destructive: false,
  input: z.object({
    name: z.string().min(1).max(200),
    type: z.enum(Object.keys(MANUAL_TYPES) as [keyof typeof MANUAL_TYPES, ...(keyof typeof MANUAL_TYPES)[]]),
    entity_id: uuid('Entity (from accounts_list entities)').optional().describe('Defaults to the household\'s personal entity.'),
    currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
    starting_balance_minor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional().describe('Real-world amount in minor units.'),
    starting_balance_date: isoDate('Date of the starting balance').optional().describe('Defaults to today.'),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    let entityId = args.entity_id;
    if (!entityId) {
      const { data } = await ctx.db.from('entities').select('id, kind').eq('household_id', ctx.householdId).is('archived_at', null);
      const list = (data ?? []) as { id: string; kind: string }[];
      entityId = (list.find((e) => e.kind === 'personal') ?? (list.length === 1 ? list[0] : undefined))?.id;
      if (!entityId) return err('invalid_request', 'Pick an entity for this account.', 'accounts_list returns the entities.');
    }
    const created = await ctx.command('accounts.create', {
      entityId,
      name: args.name,
      kind: MANUAL_TYPES[args.type],
      subtype: args.type,
      currency: args.currency,
    }, args.idempotency_key);
    if (!created.ok) return created;
    const accountId = ((created.data as { effects?: { accountId?: string } } | null)?.effects?.accountId) ?? null;
    if (accountId && args.starting_balance_minor && args.starting_balance_minor !== '0') {
      const opening = await ctx.command('accounts.set_opening_balance', {
        accountId,
        balanceMinor: args.starting_balance_minor,
        asOfDate: args.starting_balance_date ?? ctx.todayIso,
      }, args.idempotency_key ? `${args.idempotency_key}.opening` : undefined);
      if (!opening.ok) {
        return err(opening.code, `The account was added (id ${accountId}) but the starting balance failed: ${opening.message}`, 'Retry with accounts_update starting_balance_minor.');
      }
    }
    return ok(`Added ${args.name}.`, { account_id: accountId });
  },
});

export const accountsUpdate = defineTool({
  name: 'accounts_update',
  title: 'Edit an account',
  description:
    'Renames an account, moves it to another entity, sets its starting balance ("as of this date the balance was X"; real-world amount, owed for debts), re-anchors a bank-synced account\'s balance to what the bank reports, or archives / restores a manual account (archived hides it from lists and net worth; nothing is deleted; bank-synced accounts are removed by disconnecting the bank in the app).',
  kind: 'write',
  destructive: true,
  input: z.object({
    account_id: uuid('Account'),
    name: z.string().min(1).max(200).optional(),
    entity_id: uuid('Entity').optional(),
    starting_balance_minor: minorString('Real-world starting balance').optional(),
    starting_balance_date: isoDate('Date of the starting balance').optional(),
    reanchor_to_bank: z.boolean().optional().describe('true = match the latest bank-reported balance.'),
    archived: z.boolean().optional().describe('true archives a manual account, false restores it.'),
    idempotency_key: idempotencyKey,
  }).strict(),
  run: async (ctx, args) => {
    const done: string[] = [];
    const fail = (what: string, e: ToolErr) =>
      err(e.code, `${done.length ? `Changed ${done.join(', ')}; then ` : ''}${what} failed: ${e.message}`, e.hint);
    if (args.name) {
      const r = await writeProc(ctx, null, 'keel_rename_account', { p_account_id: args.account_id, p_name: args.name });
      if (!r.ok) return fail('rename', r);
      done.push('name');
    }
    if (args.entity_id) {
      const r = await writeProc(ctx, null, 'keel_reassign_account_entity', { p_account_id: args.account_id, p_entity_id: args.entity_id });
      if (!r.ok) return fail('entity', r);
      done.push('entity');
    }
    if (args.starting_balance_minor !== undefined) {
      const r = await ctx.command('accounts.set_opening_balance', {
        accountId: args.account_id,
        balanceMinor: args.starting_balance_minor,
        asOfDate: args.starting_balance_date ?? ctx.todayIso,
      }, args.idempotency_key);
      if (!r.ok) return fail('starting balance', r);
      done.push('starting balance');
    }
    if (args.reanchor_to_bank) {
      const r = await ctx.command('accounts.reanchor_balance', { accountId: args.account_id },
        args.idempotency_key ? `${args.idempotency_key}.reanchor` : undefined);
      if (!r.ok) return fail('re-anchor', r);
      done.push('balance re-anchored');
    }
    if (args.archived !== undefined) {
      const r = await writeProc(ctx, null, 'keel_set_account_archived', { p_account_id: args.account_id, p_archived: args.archived });
      if (!r.ok) return fail(args.archived ? 'archive' : 'restore', r);
      done.push(args.archived ? 'archived' : 'restored');
    }
    if (done.length === 0) return err('invalid_request', 'Nothing to change.', 'Pass at least one field to change.');
    return ok(`Updated ${done.join(', ')}.`, {
      account_id: args.account_id,
      changed: done,
      ...(args.archived !== undefined ? { undo: { tool: 'accounts_update', args: { account_id: args.account_id, archived: !args.archived } } } : {}),
    });
  },
});

export const accountTools = [accountsList, accountsGet, accountsCreate, accountsUpdate];
