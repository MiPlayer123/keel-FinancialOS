/**
 * KEEL agent read-tool catalog + executor (slice 1: engine + full reads).
 *
 * Every tool the model can call routes through the SAME authorized path as the
 * UI (Law 7 — no privileged side door): `authorize(action)` on the fail-closed
 * compiler, then the existing SECURITY DEFINER read proc through the user's
 * client so `auth.uid()` re-checks membership in the database.
 *
 * The household scope is FIXED per session and injected server-side — the model
 * never passes a householdId, so it cannot read across households (Law 9).
 * Tool results are data-tier (Law 5): the loop feeds them back as tool messages
 * and the system prompt forbids treating them as instructions. Results are
 * bounded so a large ledger cannot blow the context budget.
 */
// Self-contained by convention: _shared modules never import the vendored
// domain bundle (its type-only exports are erased by esbuild, and deno test
// type-checks this file). The one domain dependency — the fail-closed authz
// compiler — is INJECTED by the caller (index.ts, which already imports it),
// keeping this catalog pure and unit-testable.

/** A JSON-Schema object describing a tool's arguments (mirrors @keel/ai). */
type JsonSchema = Readonly<Record<string, unknown>>;

/** One callable tool exposed to the model (mirrors @keel/ai ToolDefinition). */
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

/** A tool invocation the model asked for (mirrors @keel/ai ToolCall). */
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** The authz action name each read tool is gated on. */
type ActionName = string;

/** The fail-closed authorization compiler, injected from the domain bundle. */
export type AuthorizeFn = (
  ctx: unknown,
  action: ActionName,
  scope: { readonly kind: 'household'; readonly householdId: string },
) => { readonly allowed: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/** How many chars of tool output we will feed back to the model, at most. */
const MAX_TOOL_RESULT_CHARS = 14_000;
/** Default row cap for list-shaped results. */
const DEFAULT_ROW_CAP = 60;

type ProcArgs = Record<string, unknown>;
type BuildResult = ProcArgs | { readonly __error: string };

interface ReadToolSpec {
  readonly name: string;
  readonly description: string;
  readonly action: ActionName;
  readonly proc: string;
  readonly parameters: JsonSchema;
  /** Build proc args from model args + fixed session context. */
  readonly buildArgs: (args: Record<string, unknown>, householdId: string, todayIso: string) => BuildResult;
  /** Optional result shaping/bounding before it reaches the model. */
  readonly capResult?: (data: unknown) => unknown;
}

const NO_PARAMS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

const householdOnly = (_a: Record<string, unknown>, householdId: string): BuildResult => ({
  p_household_id: householdId,
});

/** Slice `rows` (if present) so list results stay bounded. */
const capRows = (limit = DEFAULT_ROW_CAP) =>
  (data: unknown): unknown => {
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const rec = data as Record<string, unknown>;
      if (Array.isArray(rec['rows'])) {
        return { ...rec, rows: rec['rows'].slice(0, limit) };
      }
    }
    if (Array.isArray(data)) return data.slice(0, limit);
    return data;
  };

/**
 * The read surface. Broad by design ("read everything") but each entry is an
 * explicit, authorized action. Add new reads here — never let the agent reach a
 * proc that is not in this table.
 */
const READ_TOOL_SPECS: readonly ReadToolSpec[] = [
  {
    name: 'list_entities',
    description: 'List the legal/logical entities (people, businesses) in the current household.',
    action: 'entities.list',
    proc: 'keel_list_entities',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'get_account_balances',
    description: 'Get every account and its current deterministic ledger balance (trial balance). Use this for "how much do I have" questions.',
    action: 'ledger.trial_balance',
    proc: 'keel_trial_balance',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'list_transactions',
    description: 'List recent transactions, optionally filtered. Returns one bounded page (newest first).',
    action: 'transactions.rich_page',
    proc: 'keel_list_transactions_rich_page',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows (default 40).' },
        search: { type: 'string', maxLength: 200, description: 'Free-text filter over description/merchant.' },
        accountId: { type: 'string', description: 'Restrict to one account (uuid).' },
        categoryId: { type: 'string', description: 'Restrict to one category (uuid).' },
      },
    },
    buildArgs: (args, householdId) => {
      const out: ProcArgs = { p_household_id: householdId };
      if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
        out.p_limit = Math.min(Math.max(Math.trunc(args['limit']), 1), 100);
      } else {
        out.p_limit = 40;
      }
      if (typeof args['search'] === 'string' && args['search'].length <= 200) out.p_search = args['search'];
      if (typeof args['accountId'] === 'string' && UUID_RE.test(args['accountId'])) out.p_account_id = args['accountId'];
      if (typeof args['categoryId'] === 'string' && UUID_RE.test(args['categoryId'])) out.p_category_id = args['categoryId'];
      return out;
    },
    capResult: capRows(100),
  },
  {
    name: 'search_transactions',
    description: 'Search transactions by keyword (merchant, memo). Use when the user names a payee or description.',
    action: 'transactions.search',
    proc: 'keel_search_transactions',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['search'],
      properties: {
        search: { type: 'string', maxLength: 200, description: 'Search term.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    buildArgs: (args, householdId) => {
      if (typeof args['search'] !== 'string' || args['search'].trim().length === 0) {
        return { __error: 'search term required' };
      }
      const out: ProcArgs = { p_household_id: householdId, p_search: args['search'].slice(0, 200) };
      if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
        out.p_limit = Math.min(Math.max(Math.trunc(args['limit']), 1), 50);
      }
      return out;
    },
    capResult: capRows(50),
  },
  {
    name: 'list_categories',
    description: 'List the household spending/income categories.',
    action: 'categories.list',
    proc: 'keel_list_categories',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(200),
  },
  {
    name: 'get_budget_month',
    description: 'Get the budget plan for a month (targets, expected income, spent-so-far). Defaults to the current month.',
    action: 'budgets.month',
    proc: 'keel_budget_month',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { month: { type: 'string', description: 'First-of-month ISO date, e.g. 2026-07-01.' } },
    },
    buildArgs: (args, householdId, todayIso) => {
      if (args['month'] !== undefined && isoDate(args['month']) === null) {
        return { __error: 'month must be an ISO date (YYYY-MM-DD)' };
      }
      return { p_household_id: householdId, p_month: isoDate(args['month']) ?? `${todayIso.slice(0, 7)}-01` };
    },
  },
  {
    name: 'list_budgets',
    description: 'List per-category budget rows for a month (budgeted vs spent). Defaults to the current month.',
    action: 'budgets.list',
    proc: 'keel_list_budgets',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { month: { type: 'string', description: 'First-of-month ISO date.' } },
    },
    buildArgs: (args, householdId, todayIso) => {
      if (args['month'] !== undefined && isoDate(args['month']) === null) {
        return { __error: 'month must be an ISO date (YYYY-MM-DD)' };
      }
      return { p_household_id: householdId, p_month: isoDate(args['month']) ?? `${todayIso.slice(0, 7)}-01` };
    },
    capResult: capRows(200),
  },
  {
    name: 'list_reimbursements',
    description: 'List reimbursement claims and settlements (who owes whom, and what is settled).',
    action: 'reimbursements.list',
    proc: 'keel_list_reimbursements',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_notes_and_tasks',
    description: 'List household notes and tasks/reminders.',
    action: 'notes_tasks.list',
    proc: 'keel_list_notes_tasks',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_recurring',
    description: 'List detected/confirmed recurring series (subscriptions, bills, income).',
    action: 'recurring.list',
    proc: 'keel_list_recurring',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_paychecks',
    description: 'List paychecks and their decomposition.',
    action: 'paychecks.list',
    proc: 'keel_list_paychecks',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_statements',
    description: 'List imported financial statements.',
    action: 'statements.list',
    proc: 'keel_list_statements',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_transfers',
    description: 'List transfers between the household’s own accounts.',
    action: 'transfers.list',
    proc: 'keel_list_transfers',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_holdings',
    description: 'List investment holdings (positions), optionally for one account.',
    action: 'holdings.list',
    proc: 'keel_list_holdings',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { accountId: { type: 'string', description: 'Restrict to one investment account (uuid).' } },
    },
    buildArgs: (args, householdId) => {
      const out: ProcArgs = { p_household_id: householdId };
      if (typeof args['accountId'] === 'string' && UUID_RE.test(args['accountId'])) out.p_account_id = args['accountId'];
      return out;
    },
    capResult: capRows(120),
  },
  {
    name: 'get_investments_overview',
    description: 'Investment portfolio overview (total value, allocation).',
    action: 'investments.overview',
    proc: 'keel_investments_overview',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'get_net_worth',
    description: 'Net worth as of a date (assets minus liabilities). Defaults to today.',
    action: 'dashboard.net_worth',
    proc: 'keel_net_worth_as_of',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { asOf: { type: 'string', description: 'ISO date; defaults to today.' } },
    },
    buildArgs: (args, householdId, todayIso) => ({
      p_household_id: householdId,
      p_as_of: isoDate(args['asOf']) ?? todayIso,
    }),
  },
  {
    name: 'get_cash_flow',
    description: 'Income vs spending over a date range. Defaults to the last 30 days.',
    action: 'dashboard.cash_flow',
    proc: 'keel_cash_flow',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', description: 'ISO start date.' },
        to: { type: 'string', description: 'ISO end date.' },
      },
    },
    buildArgs: (args, householdId, todayIso) => {
      const past = new Date(`${todayIso}T00:00:00Z`);
      past.setUTCDate(past.getUTCDate() - 30);
      return {
        p_household_id: householdId,
        p_from: isoDate(args['from']) ?? past.toISOString().slice(0, 10),
        p_to: isoDate(args['to']) ?? todayIso,
      };
    },
  },
  {
    name: 'get_cash_flow_forecast',
    description: 'Forward cash-flow forecast for the next N days (preview only — Class C).',
    action: 'dashboard.cash_flow_forecast',
    proc: 'keel_cash_flow_forecast',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'integer', minimum: 1, maximum: 120, description: 'Horizon (default 30).' } },
    },
    buildArgs: (args, householdId) => {
      const days = typeof args['days'] === 'number' ? Math.trunc(args['days']) : 30;
      return { p_household_id: householdId, p_days: Math.min(Math.max(days, 1), 120) };
    },
  },
  {
    name: 'list_goals',
    description: 'List savings/financial goals and their progress.',
    action: 'goals.list',
    proc: 'keel_list_goals',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_rules',
    description: 'List categorization/automation rules.',
    action: 'rules.list',
    proc: 'keel_list_rules',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_tags',
    description: 'List tags used across transactions.',
    action: 'tags.list',
    proc: 'keel_list_tags',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(200),
  },
];

const READ_TOOL_BY_NAME: Readonly<Record<string, ReadToolSpec>> = Object.fromEntries(
  READ_TOOL_SPECS.map((t) => [t.name, t]),
);

/** Tool definitions handed to the model. */
export const readToolDefinitions = (): ToolDefinition[] =>
  READ_TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

/** Names of every read tool (for logging/telemetry). */
export const READ_TOOL_NAMES: readonly string[] = READ_TOOL_SPECS.map((t) => t.name);

const boundJson = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'unserializable_result' });
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return JSON.stringify({
      truncated: true,
      note: 'Result too large; showing a prefix. Narrow the query (add filters or a smaller limit).',
      preview: text.slice(0, MAX_TOOL_RESULT_CHARS),
    });
  }
  return text;
};

export interface ReadToolDeps {
  /** The fail-closed authz compiler (injected from the domain bundle). */
  readonly authorize: AuthorizeFn;
  /** Opaque authz context loaded per request; passed straight to authorize. */
  readonly authzCtx: unknown;
  readonly householdId: string;
  /** Calls a read proc through the user's client (auth.uid() reaches the DB). */
  readonly rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** ISO date (YYYY-MM-DD) for defaulting ranges. */
  readonly todayIso: string;
}

/**
 * Build the `executeTool` callback for `runAgent`. Never throws for
 * authz/validation/proc failures — returns an error PAYLOAD so the model can
 * tell the user plainly (e.g. "you don't have access"), never a stubbed answer.
 */
export const makeExecuteReadTool = (deps: ReadToolDeps) => async (call: ToolCall): Promise<string> => {
  const spec = READ_TOOL_BY_NAME[call.name];
  if (!spec) return JSON.stringify({ error: 'unknown_tool', tool: call.name });

  const decision = deps.authorize(deps.authzCtx, spec.action, {
    kind: 'household',
    householdId: deps.householdId,
  });
  if (!decision.allowed) {
    return JSON.stringify({ error: 'not_authorized', tool: call.name });
  }

  const built = spec.buildArgs(call.args ?? {}, deps.householdId, deps.todayIso);
  if ('__error' in built) {
    return JSON.stringify({ error: 'invalid_arguments', detail: built.__error });
  }

  const { data, error } = await deps.rpc(spec.proc, built);
  if (error) {
    // Never surface DB error internals to the model (Law 12); a constant code.
    return JSON.stringify({ error: 'query_failed', tool: call.name });
  }
  const capped = spec.capResult ? spec.capResult(data) : data;
  return boundJson(capped);
};
