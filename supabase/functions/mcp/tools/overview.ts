/**
 * The one-call picture and the time series behind it. Every figure is KEEL's
 * own deterministic read model (Law 1) with its formula version (Law 9).
 */
import * as z from 'npm:zod@4.4.3';
import { defineTool, isoDate, pick, readProc, rowsOf } from '../context.ts';
import { err, money, monthStart, ok } from '../lib.ts';

const SECTIONS = ['net_worth', 'cash_flow', 'budget', 'upcoming', 'review'] as const;

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const overviewGet = defineTool({
  name: 'overview_get',
  title: 'Financial overview',
  description:
    'A one-call snapshot: net worth, this month\'s money in and out, budget status, bills and recurring charges due in the next 14 days, and how many items wait in the review queue. sections limits what is returned.',
  kind: 'read',
  input: z.object({
    sections: z.array(z.enum(SECTIONS)).min(1).optional(),
    month: isoDate('Any date in the month for cash flow and budget').optional(),
  }).strict(),
  run: async (ctx, args) => {
    const want = new Set(args.sections ?? SECTIONS);
    const month = monthStart(args.month ?? ctx.todayIso);
    const monthEnd = args.month ? addDays(monthStart(addDays(month, 32)), -1) : ctx.todayIso;
    const horizon = addDays(ctx.todayIso, 14);
    const out: Record<string, unknown> = {};
    const lines: string[] = [];

    const [netWorth, cashFlow, budget, recurring, bills, suggestions, transfers, receipts] = await Promise.all([
      want.has('net_worth') ? readProc(ctx, 'dashboard.net_worth', 'keel_net_worth_as_of', { p_as_of: ctx.todayIso }) : null,
      want.has('cash_flow') ? readProc(ctx, 'dashboard.cash_flow', 'keel_cash_flow', { p_from: month, p_to: monthEnd }) : null,
      want.has('budget') ? readProc(ctx, 'budgets.month', 'keel_budget_month', { p_month: month }) : null,
      want.has('upcoming') ? readProc(ctx, 'recurring.list', 'keel_list_recurring') : null,
      want.has('upcoming') ? readProc(ctx, null, 'keel_list_schedules') : null,
      want.has('review') ? readProc(ctx, null, 'keel_list_category_suggestions') : null,
      want.has('review') ? readProc(ctx, 'transfers.list', 'keel_list_transfers') : null,
      want.has('review') ? readProc(ctx, 'receipts.inbox', 'keel_receipts_inbox') : null,
    ]);

    if (netWorth?.ok) {
      out['net_worth'] = rowsOf(netWorth.data).map((r) => money(r['netWorthMinor'] as string, r['currency'] as string));
      lines.push(`Net worth ${(out['net_worth'] as { display: string }[]).map((m) => m.display).join(' + ') || 'n/a'}`);
    }
    if (cashFlow?.ok) {
      out['cash_flow'] = {
        from: month,
        to: monthEnd,
        by_currency: rowsOf(cashFlow.data).map((r) => ({
          money_in: money(r['inflowMinor'] as string, r['currency'] as string),
          money_out: money(r['outflowMinor'] as string, r['currency'] as string),
          net: money(r['netMinor'] as string, r['currency'] as string),
        })),
        formula: (cashFlow.data as { formulaVersion?: string }).formulaVersion,
      };
    }
    if (budget?.ok) {
      const b = budget.data as Record<string, unknown>;
      const total = (b['total'] ?? {}) as Record<string, unknown>;
      const spent = rowsOf(b).reduce((sum, r) => sum + BigInt((r['spentMinor'] as string | null) ?? '0'), 0n);
      out['budget'] = {
        month: month.slice(0, 7),
        planned: money(total['resolvedMinor'] as string | null),
        spent_in_budgeted_categories: money(spent),
        left_to_budget: money(b['leftToBudgetMinor'] as string | null),
        targets: rowsOf(b).length,
      };
    }
    if (recurring?.ok || bills?.ok) {
      const due: Record<string, unknown>[] = [];
      for (const s of recurring?.ok ? rowsOf(recurring.data) : []) {
        if (s['status'] !== 'confirmed') continue;
        for (const o of (s['occurrences'] ?? []) as Record<string, unknown>[]) {
          const d = String(o['expectedDate'] ?? '');
          if (o['status'] === 'expected' && d >= ctx.todayIso && d <= horizon) {
            due.push({ date: d, name: s['counterpartyKey'], amount: money(o['expectedAmountMinor'] as string | null, (s['currency'] as string) ?? 'USD'), kind: 'recurring' });
          }
        }
      }
      for (const b of bills?.ok ? rowsOf(bills.data) : []) {
        const d = String(b['nextDueDate'] ?? '');
        if (b['status'] === 'active' && d >= ctx.todayIso && d <= horizon) {
          due.push({ date: d, name: b['description'], amount: money(b['amountMinor'] as string | null, (b['currency'] as string) ?? 'USD'), kind: 'bill' });
        }
      }
      out['upcoming_14_days'] = due.sort((a, b) => String(a['date']).localeCompare(String(b['date'])));
      lines.push(`${due.length} due in 14 days`);
    }
    if (suggestions || transfers || receipts) {
      const pending = {
        category_suggestions: suggestions?.ok ? rowsOf(suggestions.data).filter((r) => (r['status'] ?? 'suggested') === 'suggested').length : null,
        transfer_matches: transfers?.ok ? rowsOf(transfers.data).filter((r) => r['status'] === 'suggested').length : null,
        receipts_to_match: receipts?.ok ? rowsOf(receipts.data).length : null,
      };
      out['review_queue'] = pending;
      lines.push(`${Object.values(pending).reduce((a: number, b) => a + (b ?? 0), 0)} items to review`);
    }
    if (Object.keys(out).length === 0) return err('failed', 'None of the requested sections could be read.');
    return ok(lines.join('; ') + '.', out);
  },
});

export const historyGet = defineTool({
  name: 'history_get',
  title: 'Get a time series',
  description:
    'Daily or monthly history: net_worth (daily), account_balance (daily, needs account_id), cash_flow (monthly money in/out/net, transfers excluded), investments_value (daily), or cash_flow_forecast (projected daily balance for the next forecast_days; a projection, not a fact).',
  kind: 'read',
  input: z.object({
    metric: z.enum(['net_worth', 'account_balance', 'cash_flow', 'investments_value', 'cash_flow_forecast']),
    from: isoDate('Start').optional(),
    to: isoDate('End').optional(),
    account_id: z.string().uuid().optional(),
    forecast_days: z.number().int().min(1).max(365).default(30),
  }).strict(),
  run: async (ctx, args) => {
    const to = args.to ?? ctx.todayIso;
    const from = args.from ?? addDays(to, args.metric === 'cash_flow' ? -365 : -90);
    let res;
    switch (args.metric) {
      case 'net_worth':
        res = await readProc(ctx, 'dashboard.net_worth', 'keel_net_worth_daily', { p_from: from, p_to: to });
        break;
      case 'account_balance':
        if (!args.account_id) return err('invalid_request', 'account_balance needs account_id.', 'accounts_list has the ids.');
        res = await readProc(ctx, null, 'keel_account_balance_daily', { p_account_id: args.account_id, p_from: from, p_to: to });
        break;
      case 'cash_flow':
        res = await readProc(ctx, 'dashboard.cash_flow', 'keel_cash_flow_monthly', { p_from: from, p_to: to });
        break;
      case 'investments_value':
        res = await readProc(ctx, 'investments.overview', 'keel_investments_value_daily', { p_from: from, p_to: to });
        break;
      case 'cash_flow_forecast':
        res = await readProc(ctx, 'dashboard.cash_flow_forecast', 'keel_cash_flow_forecast', { p_days: args.forecast_days });
        break;
    }
    if (!res.ok) return res;
    const data = res.data as Record<string, unknown>;
    const series = (rowsOf(data).length > 0 ? rowsOf(data) : ((data['points'] ?? []) as Record<string, unknown>[])).map((p) => {
      const currency = (p['currency'] as string) ?? 'USD';
      const shaped: Record<string, unknown> = { ...(p['date'] ? { date: p['date'] } : {}), ...(p['month'] ? { month: p['month'] } : {}) };
      for (const [k, v] of Object.entries(p)) {
        if (k.endsWith('Minor') && (typeof v === 'string' || typeof v === 'number')) {
          shaped[k.replace(/Minor$/, '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = money(v, currency);
        }
      }
      return shaped;
    });
    return ok(`${series.length} ${args.metric.replace(/_/g, ' ')} points.`, {
      metric: args.metric,
      from,
      to,
      formula: data['formulaVersion'] ?? null,
      ...(args.metric === 'cash_flow_forecast' ? { note: 'Projection from recurring and scheduled items; not a fact.' } : {}),
      series: series.slice(-400),
    });
  },
});

export const investmentsGet = defineTool({
  name: 'investments_get',
  title: 'Get investments',
  description: 'Holdings (symbol, quantity, price, value, cost basis, unrealized gain), allocation, and totals across investment accounts, or for one account.',
  kind: 'read',
  input: z.object({ account_id: z.string().uuid().optional() }).strict(),
  run: async (ctx, args) => {
    const r = await readProc(ctx, 'investments.overview', 'keel_investments_overview');
    if (!r.ok) return r;
    const data = r.data as Record<string, unknown>;
    const holdings = ((data['holdings'] ?? []) as Record<string, unknown>[])
      .filter((h) => !args.account_id || h['accountId'] === args.account_id)
      .map((h) => {
        const c = (h['currency'] as string) ?? 'USD';
        return {
          account: h['accountName'],
          account_id: h['accountId'],
          symbol: h['symbol'],
          name: h['name'],
          quantity: h['qty'],
          price: money(h['priceMinor'] as string | null, c),
          value: money(h['valueMinor'] as string | null, c),
          cost_basis: money(h['costBasisMinor'] as string | null, c),
          unrealized_gain: money(h['unrealizedGainMinor'] as string | null, c),
          as_of: h['asOf'],
        };
      });
    return ok(`${holdings.length} holdings.`, {
      totals: pick(data, ['totalHoldingsValueMinor', 'totalCostBasisMinor', 'totalUnrealizedGainMinor', 'holdingsCount']),
      allocation: data['allocation'] ?? null,
      holdings: holdings.slice(0, 200),
      formula: data['formulaVersion'] ?? null,
    });
  },
});

export const overviewTools = [overviewGet, historyGet, investmentsGet];
