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
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'get_account_balances',
    description: 'Get every account and its current deterministic ledger balance (trial balance). Use this for "how much do I have" questions.',
    action: 'ledger.trial_balance',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'list_transactions',
    description: 'List recent transactions, optionally filtered. Returns one bounded page (newest first).',
    action: 'transactions.rich_page',
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
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(200),
  },
  {
    name: 'get_budget_month',
    description: 'Get the budget plan for a month (targets, expected income, spent-so-far). Defaults to the current month.',
    action: 'budgets.month',
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
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_notes_and_tasks',
    description: 'List household notes and tasks/reminders.',
    action: 'notes_tasks.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_recurring',
    description: 'List detected/confirmed recurring series (subscriptions, bills, income).',
    action: 'recurring.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_paychecks',
    description: 'List paychecks and their decomposition.',
    action: 'paychecks.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_statements',
    description: 'List imported financial statements.',
    action: 'statements.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_transfers',
    description: 'List transfers between the household’s own accounts.',
    action: 'transfers.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_holdings',
    description: 'List investment holdings (positions), optionally for one account.',
    action: 'holdings.list',
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
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'get_net_worth',
    description: 'Net worth as of a date (assets minus liabilities). Defaults to today.',
    action: 'dashboard.net_worth',
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
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_rules',
    description: 'List categorization/automation rules.',
    action: 'rules.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_tags',
    description: 'List tags used across transactions.',
    action: 'tags.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(200),
  },
  {
    name: 'list_recurring_classification',
    description: 'List recurring series classified by outflow bucket (bill, subscription, income, etc.).',
    action: 'recurring.classification',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_recurring_schedule_links',
    description: 'List links between recurring series and their detected payment schedules.',
    action: 'recurring.schedule_links',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_dismissed_paycheck_detections',
    description: 'List paycheck detections the user has dismissed as not actually a paycheck.',
    action: 'paychecks.detected_dismissals',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_paycheck_templates',
    description: 'List saved paycheck split templates (the gross-up rules used to decompose a deposit into gross pay, taxes, and contributions).',
    action: 'paychecks.templates',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_paycheck_split_suggestions',
    description: 'List suggested paycheck splits awaiting a template match or application.',
    action: 'paychecks.split_suggestions',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'list_expected_reimbursements',
    description: 'List expected future reimbursements (amounts the user expects back) — a separate tracker from claim-based reimbursements (use list_reimbursements for those).',
    action: 'expected_reimbursements.list',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(80),
  },
  {
    name: 'list_statement_drafts',
    description: 'List draft statement imports awaiting the user’s approval or dismissal.',
    action: 'statements.drafts',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(40),
  },
  {
    name: 'get_statement_cadence',
    description: 'Get the expected-statement cadence configuration (which accounts, how often).',
    action: 'statements.cadence',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'suggest_statement_payments',
    description: 'Compute/refresh payment-match suggestions for one statement; returns how many were found. Follow up with get_statement_payment_links to see them. Get the statementId from list_statements.',
    action: 'statements.find_payment',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId'],
      properties: { statementId: { type: 'string', description: 'The statement id (uuid).' } },
    },
    buildArgs: (args, householdId) => {
      const id = typeof args['statementId'] === 'string' && UUID_RE.test(args['statementId']) ? args['statementId'] : null;
      if (id === null) return { __error: 'statementId must be a uuid' };
      return { p_household_id: householdId, p_statement_id: id };
    },
  },
  {
    name: 'get_statement_payment_links',
    description: 'List a statement’s suggested/decided payment links. Get the statementId from list_statements.',
    action: 'statements.payment_links',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId'],
      properties: { statementId: { type: 'string', description: 'The statement id (uuid).' } },
    },
    buildArgs: (args, householdId) => {
      const id = typeof args['statementId'] === 'string' && UUID_RE.test(args['statementId']) ? args['statementId'] : null;
      if (id === null) return { __error: 'statementId must be a uuid' };
      return { p_household_id: householdId, p_statement_id: id };
    },
    capResult: capRows(60),
  },
  {
    name: 'get_statement_holdings_diff',
    description: 'Diff an investment statement’s reported holdings against current portfolio positions. Get the statementId from list_statements.',
    action: 'statements.holdings_diff',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['statementId'],
      properties: { statementId: { type: 'string', description: 'The statement id (uuid).' } },
    },
    buildArgs: (args, householdId) => {
      const id = typeof args['statementId'] === 'string' && UUID_RE.test(args['statementId']) ? args['statementId'] : null;
      if (id === null) return { __error: 'statementId must be a uuid' };
      return { p_household_id: householdId, p_statement_id: id };
    },
    capResult: capRows(120),
  },
  {
    name: 'list_documents_for_household',
    description: 'List every document (receipts, statements, etc.) attached anywhere in the household.',
    action: 'documents.list_household',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
  },
  {
    name: 'list_documents_for_target',
    description: 'List documents attached to one specific transaction, paycheck, reimbursement claim, or statement.',
    action: 'documents.list_for_target',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['targetType', 'targetId'],
      properties: {
        targetType: { type: 'string', enum: ['transaction', 'paycheck', 'reimbursement_claim', 'statement'] },
        targetId: { type: 'string', description: 'The target row id (uuid).' },
      },
    },
    buildArgs: (args, householdId) => {
      const targetTypes = ['transaction', 'paycheck', 'reimbursement_claim', 'statement'];
      const targetType = typeof args['targetType'] === 'string' && targetTypes.includes(args['targetType']) ? args['targetType'] : null;
      const targetId = typeof args['targetId'] === 'string' && UUID_RE.test(args['targetId']) ? args['targetId'] : null;
      if (targetType === null) return { __error: 'targetType must be one of transaction|paycheck|reimbursement_claim|statement' };
      if (targetId === null) return { __error: 'targetId must be a uuid' };
      return { p_household_id: householdId, p_target_type: targetType, p_target_id: targetId };
    },
    capResult: capRows(60),
  },
  {
    name: 'get_document_storage_summary',
    description: 'Get a storage-usage summary for the household’s uploaded documents.',
    action: 'documents.storage_summary',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
  },
  {
    name: 'get_receipts_inbox',
    description: 'List receipts awaiting a transaction match (the receipts inbox).',
    action: 'receipts.inbox',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(60),
  },
  {
    name: 'get_latest_balances',
    description: 'Get the latest per-account balance snapshot (a lighter, faster read than get_account_balances’ full trial balance).',
    action: 'balances.latest',
    parameters: NO_PARAMS,
    buildArgs: householdOnly,
    capResult: capRows(100),
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

/**
 * Tool name -> authz action, for callers that need to cross-check every read
 * tool has a proc mapping (e.g. against `QUERY_TO_PROC` in api/index.ts) —
 * the proc name itself is no longer duplicated here; see `ReadToolDeps.queryToProc`.
 */
export const READ_TOOL_ACTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  READ_TOOL_SPECS.map((t) => [t.name, t.action]),
);

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
  /**
   * Action -> proc name, injected by the caller (index.ts merges the SAME
   * `QUERY_TO_PROC` it uses for `/queries` with `AGENT_WRITE_TO_PROC` for the
   * notes/tasks actions its bespoke `/notes/*` + `/tasks/*` routes also
   * dispatch through) — this catalog only ever names an action; it never
   * hand-maintains its own copy of a proc string.
   */
  readonly queryToProc: Readonly<Record<string, string>>;
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

  const proc = deps.queryToProc[spec.action];
  if (!proc) {
    // Fail closed: a read tool whose action has no proc mapping is a wiring
    // bug (drift between this catalog and the injected map), never a reason
    // to guess a proc name.
    return JSON.stringify({ error: 'unmapped_tool', tool: call.name });
  }

  const { data, error } = await deps.rpc(proc, built);
  if (error) {
    // Never surface DB error internals to the model (Law 12); a constant code.
    return JSON.stringify({ error: 'query_failed', tool: call.name });
  }
  const capped = spec.capResult ? spec.capResult(data) : data;
  return boundJson(capped);
};

// ---------------------------------------------------------------------------
// Write tools — Class A (notes): auto-applied + undoable (Law 2/10).
// The agent applies these directly through the EXISTING audited note procs
// (keel_note_save / keel_note_archive / keel_note_unarchive) — same authorized
// path, each write hits audit_log and is reversible. Budgets & reimbursements
// are Class B (proposal-gated) and land in later slices, NOT here.
// ---------------------------------------------------------------------------

/** How the UI reverses an applied action (mirrors @keel/ai AppliedActionUndo). */
export interface AppliedActionUndo {
  readonly op: 'archive_note' | 'unarchive_note' | 'edit_note' | 'set_task_status' | 'edit_task' | 'detach_document';
  readonly noteId?: string;
  readonly taskId?: string;
  readonly attachmentId?: string;
  readonly body?: string;
  readonly pinned?: boolean;
  readonly status?: 'open' | 'done' | 'dismissed';
  readonly title?: string;
  readonly description?: string | null;
  readonly dueOn?: string | null;
  readonly priority?: 'low' | 'normal' | 'high';
}

/** A change the agent applied (mirrors @keel/ai AppliedAction). */
export interface AppliedAction {
  readonly kind: string;
  readonly summary: string;
  readonly ref: string;
  readonly undo?: AppliedActionUndo;
}

/** A change the agent proposes for approval (mirrors @keel/ai ProposedAction). */
export interface ProposedAction {
  readonly kind: string;
  readonly command: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Injected, narrowly-scoped capability: upload THIS turn's attached image as a
 * receipt and attach it to a transaction (needs the service-role storage +
 * confirm proc, which the agent tool executor deliberately does NOT get in
 * general). Present only when a receipt-compatible image was attached this turn.
 */
export type AttachReceiptFn = (input: { transactionId: string }) => Promise<
  | { readonly ok: true; readonly attachmentId: string; readonly documentId: string }
  | { readonly ok: false; readonly error: string }
>;

interface WriteExecCtx {
  readonly householdId: string;
  readonly todayIso: string;
  readonly rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** Same injected map read tools use — for the handful of write tools that call a READ proc as a validation/undo-capture helper (never for the write itself). */
  readonly queryToProc: Readonly<Record<string, string>>;
  readonly attachReceipt?: AttachReceiptFn;
}

type WriteExecResult =
  | { readonly ok: true; readonly modelResult: Record<string, unknown>; readonly applied: AppliedAction }
  | { readonly ok: true; readonly modelResult: Record<string, unknown>; readonly proposed: ProposedAction }
  | { readonly ok: false; readonly error: string; readonly detail?: string };

interface WriteToolSpec {
  readonly name: string;
  readonly description: string;
  readonly action: ActionName;
  readonly parameters: JsonSchema;
  readonly execute: (args: Record<string, unknown>, ctx: WriteExecCtx) => Promise<WriteExecResult>;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const noteBody = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length >= 1 && trimmed.length <= 1000 ? trimmed : null;
};

const noteId = (v: unknown): string | null =>
  typeof v === 'string' && UUID_RE.test(v) ? v : null;

// --- budget proposal helpers ---
const currentMonthIso = (todayIso: string): string => `${todayIso.slice(0, 7)}-01`;
/** Minor-unit amount as a non-negative digit string (Law 4: no floats). */
const minorDigits = (v: unknown): string | null =>
  typeof v === 'string' && /^\d+$/.test(v) ? v : null;
const basisPoints = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000 ? v : null;
/** Display-only dollar formatting for the proposal summary (server-side, not the LLM). */
const displayMinor = (minor: string): string => {
  const n = Number(minor);
  return Number.isFinite(n) ? `$${(n / 100).toFixed(2)}` : `${minor} (minor units)`;
};

/**
 * Resolve a category ledger-account id to its REAL name server-side (Law 11:
 * the approval summary must reflect the bound payload, not a model-supplied
 * label). Returns null when the id is not a category in this household — which
 * also validates the id before it becomes a proposal.
 */
const resolveCategoryName = async (
  rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  queryToProc: Readonly<Record<string, string>>,
  householdId: string,
  categoryLedgerAccountId: string,
): Promise<string | null> => {
  const proc = queryToProc['categories.list'];
  if (!proc) return null;
  const { data, error } = await rpc(proc, { p_household_id: householdId });
  if (error) return null;
  const rows = (Array.isArray(data)
    ? data
    : (((data as { rows?: unknown[] } | null)?.rows) ?? [])) as Record<string, unknown>[];
  const match = rows.find((r) => r['ledgerAccountId'] === categoryLedgerAccountId);
  return match && typeof match['name'] === 'string' ? (match['name'] as string) : null;
};

// --- task helpers (Class A, notes sibling) ---
const TASK_PRIORITIES = ['low', 'normal', 'high'];
const TASK_STATUSES = ['open', 'done', 'dismissed'];
const taskTitle = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= 160 ? t : null;
};
/** Find a task's current row (for edit/status undo capture) via the list proc. */
const resolveTaskRow = async (
  rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  queryToProc: Readonly<Record<string, string>>,
  householdId: string,
  taskId: string,
): Promise<Record<string, unknown> | null> => {
  const proc = queryToProc['notes_tasks.list'];
  if (!proc) return null;
  const { data, error } = await rpc(proc, { p_household_id: householdId });
  if (error) return null;
  const rows = (((data as { rows?: unknown[] } | null)?.rows) ?? []) as Record<string, unknown>[];
  return rows.find((r) => r['type'] === 'task' && r['id'] === taskId) ?? null;
};

const WRITE_TOOL_SPECS: readonly WriteToolSpec[] = [
  {
    name: 'create_note',
    description:
      'Create a household note/reminder. Applied immediately and undoable. Use when the user says "remember…", "make a note…", "note that…".',
    action: 'notes.save',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 1000, description: 'The note text.' },
        pinned: { type: 'boolean', description: 'Pin to the top (default false).' },
      },
    },
    execute: async (args, ctx) => {
      const body = noteBody(args['body']);
      if (body === null) return { ok: false, error: 'invalid_arguments', detail: 'body must be 1..1000 chars' };
      const pinned = args['pinned'] === true;
      const proc = ctx.queryToProc['notes.save'];
      if (!proc) return { ok: false, error: 'unmapped_tool' };
      const { data, error } = await ctx.rpc(proc, {
        p_household_id: ctx.householdId,
        p_note_id: null,
        p_body: body,
        p_pinned: pinned,
      });
      if (error) return { ok: false, error: 'write_failed' };
      const id = typeof data === 'string' ? data : '';
      return {
        ok: true,
        modelResult: { ok: true, noteId: id },
        applied: {
          kind: 'notes.create',
          summary: `Added note: "${truncate(body, 80)}"`,
          ref: id,
          undo: { op: 'archive_note', noteId: id },
        },
      };
    },
  },
  {
    name: 'edit_note',
    description: 'Edit an existing note by id. Applied immediately and undoable.',
    action: 'notes.save',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId', 'body'],
      properties: {
        noteId: { type: 'string', description: 'The note id (uuid).' },
        body: { type: 'string', minLength: 1, maxLength: 1000 },
        pinned: { type: 'boolean' },
      },
    },
    execute: async (args, ctx) => {
      const id = noteId(args['noteId']);
      const body = noteBody(args['body']);
      if (id === null) return { ok: false, error: 'invalid_arguments', detail: 'noteId must be a uuid' };
      if (body === null) return { ok: false, error: 'invalid_arguments', detail: 'body must be 1..1000 chars' };
      // Capture prior state so the UI can offer an edit-undo (re-apply it).
      const notesTasksProc = ctx.queryToProc['notes_tasks.list'];
      const { data: listData } = notesTasksProc
        ? await ctx.rpc(notesTasksProc, { p_household_id: ctx.householdId })
        : { data: null };
      const rows = (((listData as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]).filter(
        (r) => r['type'] === 'note' && r['id'] === id,
      );
      const prior = rows[0];
      const priorBody = prior && typeof prior['body'] === 'string' ? (prior['body'] as string) : undefined;
      const priorPinned = prior && typeof prior['pinned'] === 'boolean' ? (prior['pinned'] as boolean) : undefined;
      const pinned = typeof args['pinned'] === 'boolean' ? (args['pinned'] as boolean) : (priorPinned ?? false);
      const saveProc = ctx.queryToProc['notes.save'];
      if (!saveProc) return { ok: false, error: 'unmapped_tool' };
      const { error } = await ctx.rpc(saveProc, {
        p_household_id: ctx.householdId,
        p_note_id: id,
        p_body: body,
        p_pinned: pinned,
      });
      if (error) return { ok: false, error: 'write_failed' };
      const applied: AppliedAction = {
        kind: 'notes.update',
        summary: `Edited note: "${truncate(body, 80)}"`,
        ref: id,
        ...(priorBody !== undefined
          ? { undo: { op: 'edit_note' as const, noteId: id, body: priorBody, ...(priorPinned !== undefined ? { pinned: priorPinned } : {}) } }
          : {}),
      };
      return { ok: true, modelResult: { ok: true, noteId: id }, applied };
    },
  },
  {
    name: 'archive_note',
    description: 'Archive (soft-delete) a note by id. Applied immediately and undoable (restores on undo).',
    action: 'notes.archive',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId'],
      properties: { noteId: { type: 'string', description: 'The note id (uuid).' } },
    },
    execute: async (args, ctx) => {
      const id = noteId(args['noteId']);
      if (id === null) return { ok: false, error: 'invalid_arguments', detail: 'noteId must be a uuid' };
      const proc = ctx.queryToProc['notes.archive'];
      if (!proc) return { ok: false, error: 'unmapped_tool' };
      const { error } = await ctx.rpc(proc, { p_household_id: ctx.householdId, p_note_id: id });
      if (error) return { ok: false, error: 'write_failed' };
      return {
        ok: true,
        modelResult: { ok: true, noteId: id },
        applied: {
          kind: 'notes.archive',
          summary: 'Archived a note',
          ref: id,
          undo: { op: 'unarchive_note', noteId: id },
        },
      };
    },
  },
  {
    name: 'restore_note',
    description: 'Restore a previously archived note by id. Applied immediately and undoable.',
    action: 'notes.unarchive',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId'],
      properties: { noteId: { type: 'string', description: 'The note id (uuid).' } },
    },
    execute: async (args, ctx) => {
      const id = noteId(args['noteId']);
      if (id === null) return { ok: false, error: 'invalid_arguments', detail: 'noteId must be a uuid' };
      const proc = ctx.queryToProc['notes.unarchive'];
      if (!proc) return { ok: false, error: 'unmapped_tool' };
      const { error } = await ctx.rpc(proc, { p_household_id: ctx.householdId, p_note_id: id });
      if (error) return { ok: false, error: 'write_failed' };
      return {
        ok: true,
        modelResult: { ok: true, noteId: id },
        applied: {
          kind: 'notes.unarchive',
          summary: 'Restored a note',
          ref: id,
          undo: { op: 'archive_note', noteId: id },
        },
      };
    },
  },
  // --- Budgets: Class B (suggest→approve). These PROPOSE the exact command +
  // payload; nothing changes until the user approves in the app (Law 2/10). ---
  {
    name: 'propose_budget_target',
    description:
      'Propose a monthly budget target for one category (a fixed amount OR a percent of the plan total). Requires the user’s approval — this does NOT change anything by itself. First call list_categories to get the categoryLedgerAccountId.',
    action: 'budgets.set_target',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['categoryLedgerAccountId'],
      properties: {
        categoryLedgerAccountId: { type: 'string', description: 'Category ledger account id (uuid) from list_categories.' },
        categoryName: { type: 'string', description: 'Category name, for the summary shown to the user.' },
        amountMinor: { type: 'string', description: 'Target amount in minor units, e.g. "60000" for $600. Provide this OR percentBp.' },
        percentBp: { type: 'integer', minimum: 0, maximum: 10000, description: 'Percent of plan total in basis points (10000 = 100%).' },
        month: { type: 'string', description: 'First-of-month ISO date; defaults to the current month.' },
        rollover: { type: 'boolean' },
      },
    },
    execute: async (args, ctx) => {
      const cat = noteId(args['categoryLedgerAccountId']);
      if (cat === null) return { ok: false, error: 'invalid_arguments', detail: 'categoryLedgerAccountId must be a uuid' };
      const month = isoDate(args['month']) ?? currentMonthIso(ctx.todayIso);
      const amount = minorDigits(args['amountMinor']);
      const pct = basisPoints(args['percentBp']);
      if ((amount === null) === (pct === null)) {
        return { ok: false, error: 'invalid_arguments', detail: 'provide exactly one of amountMinor or percentBp' };
      }
      // Resolve + validate the real category (Law 11: summary must match payload).
      const name = await resolveCategoryName(ctx.rpc, ctx.queryToProc, ctx.householdId, cat);
      if (name === null) return { ok: false, error: 'invalid_arguments', detail: 'not a live budget category in this household' };
      const rollover = args['rollover'] === true;
      const payload: Record<string, unknown> =
        amount !== null
          ? { month, categoryLedgerAccountId: cat, kind: 'amount', amountMinor: amount, ...(rollover ? { rollover } : {}) }
          : { month, categoryLedgerAccountId: cat, kind: 'percent_of_total', percentBp: pct, ...(rollover ? { rollover } : {}) };
      const summary =
        amount !== null
          ? `Set ${name} budget to ${displayMinor(amount)} for ${month.slice(0, 7)}`
          : `Set ${name} budget to ${((pct as number) / 100).toString()}% of total for ${month.slice(0, 7)}`;
      return { ok: true, modelResult: { ok: true, proposed: true }, proposed: { kind: 'budgets.set_target', command: 'budgets.set_target', summary, payload } };
    },
  },
  {
    name: 'propose_budget_total',
    description:
      'Propose the overall monthly budget total — a fixed amount OR a percent of expected income. Requires the user’s approval.',
    action: 'budgets.set_total',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amountMinor: { type: 'string', description: 'Total in minor units. Provide this OR percentBp.' },
        percentBp: { type: 'integer', minimum: 0, maximum: 10000, description: 'Percent of expected income in basis points.' },
        month: { type: 'string', description: 'First-of-month ISO date; defaults to current month.' },
      },
    },
    execute: (args, ctx) => {
      const month = isoDate(args['month']) ?? currentMonthIso(ctx.todayIso);
      const amount = minorDigits(args['amountMinor']);
      const pct = basisPoints(args['percentBp']);
      if ((amount === null) === (pct === null)) {
        return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'provide exactly one of amountMinor or percentBp' });
      }
      const payload: Record<string, unknown> =
        amount !== null
          ? { month, basis: 'amount', amountMinor: amount }
          : { month, basis: 'percent_of_income', percentBp: pct };
      const summary =
        amount !== null
          ? `Set the monthly budget total to ${displayMinor(amount)} for ${month.slice(0, 7)}`
          : `Set the monthly budget total to ${((pct as number) / 100).toString()}% of expected income for ${month.slice(0, 7)}`;
      return Promise.resolve({ ok: true, modelResult: { ok: true, proposed: true }, proposed: { kind: 'budgets.set_total', command: 'budgets.set_total', summary, payload } });
    },
  },
  {
    name: 'propose_expected_income',
    description: 'Propose the expected income for a month (used for percent-based budgeting). Requires the user’s approval.',
    action: 'budgets.set_expected_income',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['amountMinor'],
      properties: {
        amountMinor: { type: 'string', description: 'Expected income in minor units.' },
        month: { type: 'string', description: 'First-of-month ISO date; defaults to current month.' },
      },
    },
    execute: (args, ctx) => {
      const amount = minorDigits(args['amountMinor']);
      if (amount === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'amountMinor must be a non-negative minor-unit string' });
      const month = isoDate(args['month']) ?? currentMonthIso(ctx.todayIso);
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'budgets.set_expected_income',
          command: 'budgets.set_expected_income',
          summary: `Set expected income to ${displayMinor(amount)} for ${month.slice(0, 7)}`,
          payload: { month, amountMinor: amount },
        },
      });
    },
  },
  {
    name: 'propose_remove_budget_target',
    description: 'Propose removing a category’s budget target for a month (soft removal). Requires the user’s approval.',
    action: 'budgets.remove_target',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['categoryLedgerAccountId'],
      properties: {
        categoryLedgerAccountId: { type: 'string', description: 'Category ledger account id (uuid).' },
        categoryName: { type: 'string' },
        month: { type: 'string', description: 'First-of-month ISO date; defaults to current month.' },
      },
    },
    execute: async (args, ctx) => {
      const cat = noteId(args['categoryLedgerAccountId']);
      if (cat === null) return { ok: false, error: 'invalid_arguments', detail: 'categoryLedgerAccountId must be a uuid' };
      const month = isoDate(args['month']) ?? currentMonthIso(ctx.todayIso);
      const name = await resolveCategoryName(ctx.rpc, ctx.queryToProc, ctx.householdId, cat);
      if (name === null) return { ok: false, error: 'invalid_arguments', detail: 'not a live budget category in this household' };
      return {
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'budgets.remove_target',
          command: 'budgets.remove_target',
          summary: `Remove the ${name} budget target for ${month.slice(0, 7)}`,
          payload: { month, categoryLedgerAccountId: cat },
        },
      };
    },
  },
  // --- Reimbursements: Class B (suggest→approve). Log that a counterparty owes
  // the user for a specific expense. Settle/reverse stay in the UI. ---
  {
    name: 'propose_reimbursement_claim',
    description:
      'Propose logging a reimbursement claim — that a counterparty (person, employer, insurer, …) owes the user for a specific expense transaction. Requires the user’s approval. Find the originalTransactionId with search_transactions or list_transactions first.',
    action: 'reimbursements.create_claim',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['originalTransactionId', 'counterpartyName', 'kind', 'amountMinor', 'description'],
      properties: {
        originalTransactionId: { type: 'string', description: 'The expense transaction id (uuid) being reimbursed.' },
        counterpartyName: { type: 'string', minLength: 1, maxLength: 200, description: 'Who owes / will reimburse.' },
        kind: { type: 'string', enum: ['friend', 'employer', 'client', 'insurance', 'household'] },
        amountMinor: { type: 'string', description: 'Amount owed in minor units (e.g. "4000" for $40).' },
        currency: { type: 'string', description: '3-letter code; defaults USD.' },
        description: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    execute: (args) => {
      const txId = noteId(args['originalTransactionId']);
      if (txId === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'originalTransactionId must be a uuid' });
      const counterparty = typeof args['counterpartyName'] === 'string' ? args['counterpartyName'].trim() : '';
      if (counterparty.length === 0 || counterparty.length > 200) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'counterpartyName 1..200 chars' });
      const kinds = ['friend', 'employer', 'client', 'insurance', 'household'];
      const kind = typeof args['kind'] === 'string' && kinds.includes(args['kind']) ? args['kind'] : null;
      if (kind === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'kind must be one of friend|employer|client|insurance|household' });
      const amount = minorDigits(args['amountMinor']);
      if (amount === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'amountMinor must be a non-negative minor-unit string' });
      const description = typeof args['description'] === 'string' ? args['description'].trim() : '';
      if (description.length === 0 || description.length > 500) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'description 1..500 chars' });
      const currency = typeof args['currency'] === 'string' && /^[A-Za-z]{3}$/.test(args['currency']) ? args['currency'].toUpperCase() : 'USD';
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'reimbursements.create_claim',
          command: 'reimbursements.create_claim',
          summary: `Log a ${displayMinor(amount)} reimbursement: ${counterparty} owes for "${truncate(description, 60)}"`,
          payload: {
            originalTransactionId: txId,
            counterpartyName: counterparty,
            kind,
            amountMinor: amount,
            currency,
            description,
          },
        },
      });
    },
  },
  // --- Recategorize a transaction: Class B (category = Law 10 Class B). ---
  {
    name: 'propose_recategorize_transaction',
    description:
      'Propose changing the category of one existing transaction. Requires the user’s approval. Get the transactionId from list_transactions/search_transactions and the categoryLedgerAccountId from list_categories. (Split transactions are categorized by their splits, not here.)',
    action: 'transactions.categorize',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId', 'categoryLedgerAccountId'],
      properties: {
        transactionId: { type: 'string', description: 'The transaction id (uuid).' },
        categoryLedgerAccountId: { type: 'string', description: 'The target category ledger account id (uuid) from list_categories.' },
      },
    },
    execute: async (args, ctx) => {
      const txId = noteId(args['transactionId']);
      const cat = noteId(args['categoryLedgerAccountId']);
      if (txId === null) return { ok: false, error: 'invalid_arguments', detail: 'transactionId must be a uuid' };
      if (cat === null) return { ok: false, error: 'invalid_arguments', detail: 'categoryLedgerAccountId must be a uuid' };
      const name = await resolveCategoryName(ctx.rpc, ctx.queryToProc, ctx.householdId, cat);
      if (name === null) return { ok: false, error: 'invalid_arguments', detail: 'not a live category in this household' };
      return {
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'transactions.categorize',
          command: 'transactions.categorize',
          summary: `Recategorize a transaction to ${name}`,
          payload: { transactionId: txId, categoryLedgerAccountId: cat },
        },
      };
    },
  },
  // --- Create a category: Class B. ---
  {
    name: 'propose_create_category',
    description: 'Propose creating a new spending/income category. Requires the user’s approval.',
    action: 'categories.create',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Category name.' },
        kind: { type: 'string', enum: ['expense', 'income'] },
      },
    },
    execute: (args) => {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
      if (name.length === 0 || name.length > 80) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'name 1..80 chars' });
      const kind = args['kind'] === 'expense' || args['kind'] === 'income' ? args['kind'] : null;
      if (kind === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'kind must be expense or income' });
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'categories.create',
          command: 'categories.create',
          summary: `Create a new ${kind} category: "${name}"`,
          payload: { name, kind },
        },
      });
    },
  },
  // --- Rename a category: Class B. ---
  {
    name: 'propose_rename_category',
    description: 'Propose renaming an existing category. Requires the user’s approval. Get the categoryLedgerAccountId from list_categories.',
    action: 'categories.rename',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['categoryLedgerAccountId', 'name'],
      properties: {
        categoryLedgerAccountId: { type: 'string', description: 'The category ledger account id (uuid).' },
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'New name.' },
      },
    },
    execute: async (args, ctx) => {
      const cat = noteId(args['categoryLedgerAccountId']);
      if (cat === null) return { ok: false, error: 'invalid_arguments', detail: 'categoryLedgerAccountId must be a uuid' };
      const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
      if (name.length === 0 || name.length > 80) return { ok: false, error: 'invalid_arguments', detail: 'name 1..80 chars' };
      const oldName = await resolveCategoryName(ctx.rpc, ctx.queryToProc, ctx.householdId, cat);
      if (oldName === null) return { ok: false, error: 'invalid_arguments', detail: 'not a live category in this household' };
      return {
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'categories.rename',
          command: 'categories.rename',
          summary: `Rename category "${oldName}" to "${name}"`,
          payload: { categoryLedgerAccountId: cat, name },
        },
      };
    },
  },
  // --- Tasks: Class A auto+undo (notes sibling). ---
  {
    name: 'create_task',
    description: 'Create a task/to-do. Applied immediately and undoable. Use for "remind me to…", "add a task to…".',
    action: 'tasks.save',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 1000 },
        dueOn: { type: 'string', description: 'Due date, ISO YYYY-MM-DD.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
    },
    execute: async (args, ctx) => {
      const title = taskTitle(args['title']);
      if (title === null) return { ok: false, error: 'invalid_arguments', detail: 'title 1..160 chars' };
      const description = typeof args['description'] === 'string' && args['description'].length <= 1000 ? args['description'] : null;
      const dueOn = isoDate(args['dueOn']);
      const priority = typeof args['priority'] === 'string' && TASK_PRIORITIES.includes(args['priority']) ? args['priority'] : 'normal';
      const saveProc = ctx.queryToProc['tasks.save'];
      if (!saveProc) return { ok: false, error: 'unmapped_tool' };
      const { data, error } = await ctx.rpc(saveProc, {
        p_household_id: ctx.householdId,
        p_task_id: null,
        p_title: title,
        p_description: description,
        p_due_on: dueOn,
        p_priority: priority,
      });
      if (error) return { ok: false, error: 'write_failed' };
      const id = typeof data === 'string' ? data : '';
      return {
        ok: true,
        modelResult: { ok: true, taskId: id },
        applied: {
          kind: 'tasks.create',
          summary: `Added task: "${truncate(title, 80)}"`,
          ref: id,
          undo: { op: 'set_task_status', taskId: id, status: 'dismissed' },
        },
      };
    },
  },
  {
    name: 'edit_task',
    description: 'Edit an existing task by id. Applied immediately and undoable.',
    action: 'tasks.save',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'title'],
      properties: {
        taskId: { type: 'string', description: 'The task id (uuid).' },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        description: { type: 'string', maxLength: 1000 },
        dueOn: { type: 'string', description: 'Due date, ISO YYYY-MM-DD.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
    },
    execute: async (args, ctx) => {
      const id = noteId(args['taskId']);
      const title = taskTitle(args['title']);
      if (id === null) return { ok: false, error: 'invalid_arguments', detail: 'taskId must be a uuid' };
      if (title === null) return { ok: false, error: 'invalid_arguments', detail: 'title 1..160 chars' };
      const prior = await resolveTaskRow(ctx.rpc, ctx.queryToProc, ctx.householdId, id);
      const description = typeof args['description'] === 'string' && args['description'].length <= 1000 ? args['description'] : null;
      const dueOn = isoDate(args['dueOn']);
      const priority = typeof args['priority'] === 'string' && TASK_PRIORITIES.includes(args['priority']) ? args['priority'] : 'normal';
      const saveProc = ctx.queryToProc['tasks.save'];
      if (!saveProc) return { ok: false, error: 'unmapped_tool' };
      const { error } = await ctx.rpc(saveProc, {
        p_household_id: ctx.householdId,
        p_task_id: id,
        p_title: title,
        p_description: description,
        p_due_on: dueOn,
        p_priority: priority,
      });
      if (error) return { ok: false, error: 'write_failed' };
      const undo = prior
        ? {
            op: 'edit_task' as const,
            taskId: id,
            title: typeof prior['title'] === 'string' ? (prior['title'] as string) : title,
            description: typeof prior['description'] === 'string' ? (prior['description'] as string) : null,
            dueOn: typeof prior['dueOn'] === 'string' ? (prior['dueOn'] as string) : null,
            priority: typeof prior['priority'] === 'string' && TASK_PRIORITIES.includes(prior['priority'] as string) ? (prior['priority'] as 'low' | 'normal' | 'high') : 'normal',
          }
        : undefined;
      const applied: AppliedAction = {
        kind: 'tasks.update',
        summary: `Edited task: "${truncate(title, 80)}"`,
        ref: id,
        ...(undo ? { undo } : {}),
      };
      return { ok: true, modelResult: { ok: true, taskId: id }, applied };
    },
  },
  {
    name: 'set_task_status',
    description: 'Mark a task done, reopen it (open), or dismiss it. Applied immediately and undoable.',
    action: 'tasks.set_status',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'status'],
      properties: {
        taskId: { type: 'string', description: 'The task id (uuid).' },
        status: { type: 'string', enum: ['open', 'done', 'dismissed'] },
      },
    },
    execute: async (args, ctx) => {
      const id = noteId(args['taskId']);
      const status = typeof args['status'] === 'string' && TASK_STATUSES.includes(args['status']) ? args['status'] : null;
      if (id === null) return { ok: false, error: 'invalid_arguments', detail: 'taskId must be a uuid' };
      if (status === null) return { ok: false, error: 'invalid_arguments', detail: 'status must be open|done|dismissed' };
      // Capture prior status BEFORE mutating (for undo).
      const prior = await resolveTaskRow(ctx.rpc, ctx.queryToProc, ctx.householdId, id);
      const priorStatus =
        prior && typeof prior['status'] === 'string' && TASK_STATUSES.includes(prior['status'] as string)
          ? (prior['status'] as 'open' | 'done' | 'dismissed')
          : 'open';
      const statusProc = ctx.queryToProc['tasks.set_status'];
      if (!statusProc) return { ok: false, error: 'unmapped_tool' };
      const { error } = await ctx.rpc(statusProc, {
        p_household_id: ctx.householdId,
        p_task_id: id,
        p_status: status,
      });
      if (error) return { ok: false, error: 'write_failed' };
      return {
        ok: true,
        modelResult: { ok: true, taskId: id },
        applied: {
          kind: 'tasks.set_status',
          summary: `Marked a task ${status}`,
          ref: id,
          undo: { op: 'set_task_status', taskId: id, status: priorStatus },
        },
      };
    },
  },
  // --- Reimbursements: settle + reverse (Class B, /commands envelope). ---
  {
    name: 'propose_settle_reimbursement',
    description:
      'Propose settling a reimbursement claim from a specific transaction (e.g. the deposit that paid you back). Requires the user’s approval. Get claimId from list_reimbursements and transactionId from list_transactions.',
    action: 'reimbursements.settle',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['claimId', 'transactionId', 'amountMinor', 'note'],
      properties: {
        claimId: { type: 'string', description: 'The reimbursement claim id (uuid).' },
        transactionId: { type: 'string', description: 'The settling transaction id (uuid).' },
        amountMinor: { type: 'string', description: 'Amount applied, in minor units.' },
        note: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    execute: (args) => {
      const claimId = noteId(args['claimId']);
      const txId = noteId(args['transactionId']);
      const amount = minorDigits(args['amountMinor']);
      const note = typeof args['note'] === 'string' ? args['note'].trim() : '';
      if (claimId === null || txId === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'claimId and transactionId must be uuids' });
      if (amount === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'amountMinor must be a non-negative minor-unit string' });
      if (note.length === 0 || note.length > 500) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'note 1..500 chars' });
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'reimbursements.settle',
          command: 'reimbursements.settle',
          summary: `Settle ${displayMinor(amount)} of a reimbursement claim from a transaction`,
          payload: { transactionId: txId, allocations: [{ claimId, amountMinor: amount }], note },
        },
      });
    },
  },
  {
    name: 'propose_reverse_reimbursement_claim',
    description: 'Propose reversing (undoing) a reimbursement claim. Requires the user’s approval. Get claimId from list_reimbursements.',
    action: 'reimbursements.reverse_claim',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['claimId', 'reason'],
      properties: {
        claimId: { type: 'string', description: 'The claim id (uuid).' },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    execute: (args) => {
      const claimId = noteId(args['claimId']);
      const reason = typeof args['reason'] === 'string' ? args['reason'].trim() : '';
      if (claimId === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'claimId must be a uuid' });
      if (reason.length === 0 || reason.length > 500) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'reason 1..500 chars' });
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'reimbursements.reverse_claim',
          command: 'reimbursements.reverse_claim',
          summary: 'Reverse a reimbursement claim',
          payload: { claimId, reason },
        },
      });
    },
  },
  {
    name: 'propose_reverse_reimbursement_settlement',
    description: 'Propose reversing (undoing) a reimbursement settlement. Requires the user’s approval. Get settlementId from list_reimbursements.',
    action: 'reimbursements.reverse_settlement',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['settlementId', 'reason'],
      properties: {
        settlementId: { type: 'string', description: 'The settlement id (uuid).' },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    execute: (args) => {
      const settlementId = noteId(args['settlementId']);
      const reason = typeof args['reason'] === 'string' ? args['reason'].trim() : '';
      if (settlementId === null) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'settlementId must be a uuid' });
      if (reason.length === 0 || reason.length > 500) return Promise.resolve({ ok: false, error: 'invalid_arguments', detail: 'reason 1..500 chars' });
      return Promise.resolve({
        ok: true,
        modelResult: { ok: true, proposed: true },
        proposed: {
          kind: 'reimbursements.reverse_settlement',
          command: 'reimbursements.reverse_settlement',
          summary: 'Reverse a reimbursement settlement',
          payload: { settlementId, reason },
        },
      });
    },
  },
  // --- Attach the uploaded image as a receipt on a transaction (Class A auto,
  // reversible via detach). Only works when the user attached a receipt-
  // compatible image (JPEG/PNG/WebP/PDF) this turn. ---
  {
    name: 'attach_receipt_to_transaction',
    description:
      'Attach the image the user uploaded THIS turn to a transaction as a receipt. Only call this when the user attached an image and asked to file/attach it. Find the transactionId with search_transactions/list_transactions. Applied immediately and undoable (detaches).',
    action: 'documents.attach_receipt',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['transactionId'],
      properties: {
        transactionId: { type: 'string', description: 'The transaction id (uuid) to attach the receipt to.' },
      },
    },
    execute: async (args, ctx) => {
      const txId = noteId(args['transactionId']);
      if (txId === null) return { ok: false, error: 'invalid_arguments', detail: 'transactionId must be a uuid' };
      if (!ctx.attachReceipt) {
        return {
          ok: false,
          error: 'no_image',
          detail:
            'No receipt-compatible image is attached this turn. Ask the user to attach a JPEG, PNG, WebP, or PDF receipt (GIFs are not accepted as receipts).',
        };
      }
      const res = await ctx.attachReceipt({ transactionId: txId });
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        modelResult: { ok: true, attachmentId: res.attachmentId },
        applied: {
          kind: 'documents.attach_receipt',
          summary: 'Attached the receipt to a transaction',
          ref: res.attachmentId,
          undo: { op: 'detach_document', attachmentId: res.attachmentId },
        },
      };
    },
  },
];

const WRITE_TOOL_BY_NAME: Readonly<Record<string, WriteToolSpec>> = Object.fromEntries(
  WRITE_TOOL_SPECS.map((t) => [t.name, t]),
);

export const writeToolDefinitions = (): ToolDefinition[] =>
  WRITE_TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

export const WRITE_TOOL_NAMES: readonly string[] = WRITE_TOOL_SPECS.map((t) => t.name);

/** Every tool (read + write) the agent may call. */
export const agentToolDefinitions = (): ToolDefinition[] => [
  ...readToolDefinitions(),
  ...writeToolDefinitions(),
];

export interface AgentToolDeps extends ReadToolDeps {
  /** Called for each successfully applied Class-A write (collected for the record). */
  readonly onApplied: (action: AppliedAction) => void;
  /** Called for each staged Class-B proposal (collected for the record). */
  readonly onProposed: (action: ProposedAction) => void;
  /** Scoped receipt-attach capability; present only when a compatible image was attached. */
  readonly attachReceipt?: AttachReceiptFn;
}

/**
 * Build the combined read+write `executeTool` for `runAgent`. Reads flow through
 * `makeExecuteReadTool`; writes authorize their own action then either APPLY
 * (Class A notes → `onApplied`) or PROPOSE (Class B budgets → `onProposed`,
 * nothing changes until the user approves). Never throws for
 * authz/validation/proc failures — returns an error PAYLOAD the model can react
 * to.
 */
export const makeExecuteAgentTool = (deps: AgentToolDeps) => {
  const runRead = makeExecuteReadTool(deps);
  return async (call: ToolCall): Promise<string> => {
    const write = WRITE_TOOL_BY_NAME[call.name];
    if (!write) return runRead(call); // read tool, or unknown_tool (handled there)

    const decision = deps.authorize(deps.authzCtx, write.action, {
      kind: 'household',
      householdId: deps.householdId,
    });
    if (!decision.allowed) return JSON.stringify({ error: 'not_authorized', tool: call.name });

    const res = await write.execute(call.args ?? {}, {
      householdId: deps.householdId,
      todayIso: deps.todayIso,
      rpc: deps.rpc,
      queryToProc: deps.queryToProc,
      ...(deps.attachReceipt ? { attachReceipt: deps.attachReceipt } : {}),
    });
    if (!res.ok) {
      return JSON.stringify({ error: res.error, ...(res.detail ? { detail: res.detail } : {}) });
    }
    if ('applied' in res) deps.onApplied(res.applied);
    else deps.onProposed(res.proposed);
    return JSON.stringify(res.modelResult);
  };
};
