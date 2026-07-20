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

// ---------------------------------------------------------------------------
// Write tools — Class A (notes): auto-applied + undoable (Law 2/10).
// The agent applies these directly through the EXISTING audited note procs
// (keel_note_save / keel_note_archive / keel_note_unarchive) — same authorized
// path, each write hits audit_log and is reversible. Budgets & reimbursements
// are Class B (proposal-gated) and land in later slices, NOT here.
// ---------------------------------------------------------------------------

/** How the UI reverses an applied action (mirrors @keel/ai AppliedActionUndo). */
export interface AppliedActionUndo {
  readonly op: 'archive_note' | 'unarchive_note' | 'edit_note';
  readonly noteId: string;
  readonly body?: string;
  readonly pinned?: boolean;
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

interface WriteExecCtx {
  readonly householdId: string;
  readonly todayIso: string;
  readonly rpc: (proc: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
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
  householdId: string,
  categoryLedgerAccountId: string,
): Promise<string | null> => {
  const { data, error } = await rpc('keel_list_categories', { p_household_id: householdId });
  if (error) return null;
  const rows = (Array.isArray(data)
    ? data
    : (((data as { rows?: unknown[] } | null)?.rows) ?? [])) as Record<string, unknown>[];
  const match = rows.find((r) => r['ledgerAccountId'] === categoryLedgerAccountId);
  return match && typeof match['name'] === 'string' ? (match['name'] as string) : null;
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
      const { data, error } = await ctx.rpc('keel_note_save', {
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
      const { data: listData } = await ctx.rpc('keel_list_notes_tasks', { p_household_id: ctx.householdId });
      const rows = (((listData as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[]).filter(
        (r) => r['type'] === 'note' && r['id'] === id,
      );
      const prior = rows[0];
      const priorBody = prior && typeof prior['body'] === 'string' ? (prior['body'] as string) : undefined;
      const priorPinned = prior && typeof prior['pinned'] === 'boolean' ? (prior['pinned'] as boolean) : undefined;
      const pinned = typeof args['pinned'] === 'boolean' ? (args['pinned'] as boolean) : (priorPinned ?? false);
      const { error } = await ctx.rpc('keel_note_save', {
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
      const { error } = await ctx.rpc('keel_note_archive', { p_household_id: ctx.householdId, p_note_id: id });
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
      const { error } = await ctx.rpc('keel_note_unarchive', { p_household_id: ctx.householdId, p_note_id: id });
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
      const name = await resolveCategoryName(ctx.rpc, ctx.householdId, cat);
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
      const name = await resolveCategoryName(ctx.rpc, ctx.householdId, cat);
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
    });
    if (!res.ok) {
      return JSON.stringify({ error: res.error, ...(res.detail ? { detail: res.detail } : {}) });
    }
    if ('applied' in res) deps.onApplied(res.applied);
    else deps.onProposed(res.proposed);
    return JSON.stringify(res.modelResult);
  };
};
