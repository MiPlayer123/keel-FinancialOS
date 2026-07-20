/**
 * KEEL `api` — the authenticated command/query surface (INFRA §4/§5).
 * auth: 'user' — every request needs a valid Supabase session JWT; the
 * publishable key alone is not a credential (TASK-000 test 9).
 *
 * Flow per command: validate typed envelope (contracts) → compile
 * authorization (authz, fail-closed) → invoke the SECURITY DEFINER command
 * proc through the USER's client so `auth.uid()` reaches the database, which
 * re-checks membership and executes atomically (INFRA §5 steps 4-11). The
 * export RPC is the narrow exception: after owner authz here, the service
 * client calls a service-only snapshot proc whose opaque fields are scanned
 * before any bytes are returned.
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import {
  AccountIdSchema,
  AiProviderError,
  AnthropicAgentProvider,
  buildAgentResponseRecord,
  buildAgentSystemPrompt,
  buildDerivedContext,
  CanonicalTransactionIdSchema,
  CommandIdSchema,
  EmptyAgentResponseError,
  OpenAiAgentProvider,
  runAgent,
  CommandEnvelopeSchema,
  ConnectionIdSchema,
  DocumentIdSchema,
  DocumentKindSchema,
  DocumentTargetTypeSchema,
  EntityIdSchema,
  EntityKindSchema,
  HouseholdIdSchema,
  StatementDraftIdSchema,
  ExportSecretError,
  isWithinInlineExportLimit,
  mapAccountsGetToKeel,
  parseCommandPayload,
  toBeancount,
  toCsvFiles,
  toJson,
  toQif,
  authorize,
  type Action,
  type AuthzContext,
  type HouseholdId,
  type HouseholdRole,
  type HouseholdExport,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError, toSnakeKeys } from '../_shared/http.ts';
import {
  agentToolDefinitions,
  makeExecuteAgentTool,
  type AppliedAction,
  type ProposedAction,
} from '../_shared/agent.ts';
import { decideStatementPromotion } from '../_shared/statement-sniff.ts';
import { decryptToken, encryptToken, type EncryptedRecord } from '../_shared/credential-crypto.ts';
import { currentKekVersion, getKek } from '../_shared/credential-kek.ts';
import {
  createPlaidClient,
  PlaidClientError,
  ProviderBudgetExhaustedError,
} from '../_shared/plaid-client.ts';

// Per-kind upload allowlists (statement ingestion SLICE 4 — [A9]). The
// client-declared MIME is only a coarse gate at upload-url time; for
// statements the AUTHORITATIVE check is the byte-level content sniff in
// /documents/confirm-upload (Law 5 — a statement file may never be trusted to
// describe itself). receipt is UNCHANGED (image + pdf). statement adds the
// machine formats plus application/octet-stream (the empty MIME claim many
// browsers send for .csv/.ofx/.qfx), which is accepted ONLY when the sniff
// positively identifies csv/ofx/pdf.
const RECEIPT_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const STATEMENT_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/x-ofx',
  'application/octet-stream',
]);
const documentMimeAllowlistFor = (kind: string): Set<string> =>
  kind === 'statement' ? STATEMENT_MIME_ALLOWLIST : RECEIPT_MIME_ALLOWLIST;
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
const DOCUMENT_SIGNED_URL_TTL_S = 300;

// Statement uploads land in `quarantine` first (INFRA.md §10) and are copied
// into the canonical `statements` bucket only after confirm-upload sniffs +
// validates the bytes. receipts continue to land directly in `receipts`.
const quarantineBucketFor = (kind: string): 'quarantine' | 'receipts' =>
  kind === 'statement' ? 'quarantine' : 'receipts';
const canonicalBucketFor = (kind: string): 'statements' | 'receipts' =>
  kind === 'statement' ? 'statements' : 'receipts';

// Statement originals are potentially-hostile ingested files (Law 5). Even the
// validated ones (a real PDF/CSV/OFX) must never be served INLINE — a browser
// rendering a statement inline is an attack surface. Force a download so the
// bytes are handed to the user as an opaque attachment, never executed in the
// page. `download: true` makes Supabase mint a signed URL whose response sets
// `Content-Disposition: attachment`. receipts keep inline preview (images).
const forceAttachmentBucket = (bucket: string): boolean =>
  bucket === 'statements' || bucket === 'quarantine';

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

const COMMAND_TO_PROC: Record<string, string> = {
  'accounts.create': 'keel_cmd_create_account',
  'ingest.record_raw_event': 'keel_cmd_record_raw_event',
  'ingest.promote_event': 'keel_cmd_promote_event',
  'journal.post_batch': 'keel_cmd_post_batch',
  'journal.reverse_batch': 'keel_cmd_reverse_batch',
  'recurring.confirm': 'keel_recurring_confirm',
  'recurring.pause': 'keel_recurring_pause',
  'recurring.resume': 'keel_recurring_resume',
  'recurring.cancel': 'keel_recurring_cancel',
  'recurring.reject': 'keel_recurring_reject',
  'recurring.link_schedule': 'keel_recurring_link_schedule',
  'recurring.unlink_schedule': 'keel_recurring_unlink_schedule',
  'paychecks.create': 'keel_paycheck_create',
  'paychecks.edit': 'keel_paycheck_edit',
  'paychecks.reverse': 'keel_paycheck_reverse',
  'paychecks.restore': 'keel_paycheck_restore',
  'paychecks.dismiss_detected': 'keel_cmd_dismiss_detected_paycheck',
  'paychecks.save_template': 'keel_cmd_paycheck_save_template',
  'paychecks.set_series_settings': 'keel_cmd_paycheck_set_series_settings',
  'reimbursements.create_claim': 'keel_reimbursement_create_claim',
  'reimbursements.settle': 'keel_reimbursement_settle',
  'reimbursements.reverse_settlement': 'keel_reimbursement_reverse_settlement',
  'reimbursements.reverse_claim': 'keel_reimbursement_reverse_claim',
  'statements.create': 'keel_statement_create',
  'statements.approve_draft': 'keel_cmd_statements_approve_draft',
  'statements.dismiss_draft': 'keel_cmd_statements_dismiss_draft',
  'statements.set_cadence': 'keel_statement_set_cadence',
  'statements.decide_payment_link': 'keel_cmd_statements_decide_payment_link',
  'statements.detach_payment_link': 'keel_cmd_statements_detach_payment_link',
  'statements.apply_holdings': 'keel_cmd_statements_apply_holdings',
  'statements.unapply_holdings': 'keel_cmd_statements_unapply_holdings',
  'reconciliations.close': 'keel_reconciliation_close',
  'reconciliations.reopen': 'keel_reconciliation_reopen',
  'transactions.manual_create': 'keel_cmd_manual_transaction',
  'transactions.manual_void': 'keel_cmd_manual_void',
  'transactions.set_splits': 'keel_cmd_set_splits',
  'transactions.set_date': 'keel_cmd_set_date',
  'accounts.dedupe_reconnect': 'keel_cmd_dedupe_reconnect_account',
  'accounts.dedupe_archived': 'keel_cmd_dedupe_archived_duplicates',
  'accounts.set_opening_balance': 'keel_cmd_set_opening_balance',
  'accounts.reanchor_balance': 'keel_cmd_reanchor_balance',
  'categorization.decide_suggestion': 'keel_cmd_decide_category_suggestion',
  'documents.detach': 'keel_cmd_documents_detach',
  'documents.delete': 'keel_cmd_documents_delete',
  'receipts.decide_match': 'keel_cmd_receipts_decide_match',
  'receipts.detach_match': 'keel_cmd_receipts_detach_match',
  'budgets.set_total': 'keel_cmd_budgets_set_total',
  'budgets.set_target': 'keel_cmd_budgets_set_target',
  'budgets.remove_target': 'keel_cmd_budgets_remove_target',
  'budgets.set_expected_income': 'keel_cmd_budgets_set_expected_income',
};

const QUERY_TO_PROC: Record<string, string> = {
  'ledger.trial_balance': 'keel_trial_balance',
  'transactions.list': 'keel_list_transactions',
  'transactions.rich': 'keel_list_transactions_rich',
  // WS-H (F-005): bounded, keyset-paginated + server-filtered variant of the
  // rich read. Same per-row DTO as transactions.rich; carries a nextCursor.
  'transactions.rich_page': 'keel_list_transactions_rich_page',
  // WS-H (F-021): slim server-side transaction search for the command palette.
  'transactions.search': 'keel_search_transactions',
  'categories.list': 'keel_list_categories',
  'balances.latest': 'keel_latest_balances',
  'recurring.list': 'keel_list_recurring',
  'recurring.classification': 'keel_recurring_classification',
  'recurring.schedule_links': 'keel_list_recurring_schedule_links',
  'paychecks.list': 'keel_list_paychecks',
  'paychecks.detected_dismissals': 'keel_list_detected_paycheck_dismissals',
  'paychecks.templates': 'keel_list_paycheck_templates',
  'paychecks.split_suggestions': 'keel_list_paycheck_split_suggestions',
  'reimbursements.list': 'keel_list_reimbursements',
  'statements.list': 'keel_list_statements',
  'statements.drafts': 'keel_list_statement_drafts',
  'statements.cadence': 'keel_statement_cadence',
  'statements.find_payment': 'keel_statement_suggest_payments',
  'statements.payment_links': 'keel_list_statement_payment_links',
  'statements.holdings_diff': 'keel_statement_holdings_diff',
  'dashboard.cash_flow': 'keel_cash_flow',
  'dashboard.net_worth': 'keel_net_worth_as_of',
  'dashboard.net_worth_daily': 'keel_net_worth_daily',
  'dashboard.cash_flow_monthly': 'keel_cash_flow_monthly',
  'accounts.balance_daily': 'keel_account_balance_daily',
  'transfers.list': 'keel_list_transfers',
  'categorization.suggestions': 'keel_list_category_suggestions',
  'notes_tasks.list': 'keel_list_notes_tasks',
  'rules.list': 'keel_list_rules',
  'budgets.list': 'keel_list_budgets',
  'budgets.month': 'keel_budget_month',
  'tags.list': 'keel_list_tags',
  'schedules.list': 'keel_list_schedules',
  'goals.list': 'keel_list_goals',
  'entities.list': 'keel_list_entities',
  'dashboard.cash_flow_forecast': 'keel_cash_flow_forecast',
  'holdings.list': 'keel_list_holdings',
  'investments.overview': 'keel_investments_overview',
  'investments.value_daily': 'keel_investments_value_daily',
  'connections.list_reconnect_matches': 'keel_list_reconnect_matches',
  'connections.list_archived_duplicate_matches': 'keel_list_archived_duplicate_matches',
  'receipts.inbox': 'keel_receipts_inbox',
};

// deno-lint-ignore no-explicit-any
type UserClient = any;

interface LinkBeginResult {
  attemptId: string;
  credentialId: string;
  state: string;
  connectionId: string | null;
}

interface CredentialEnvelope extends EncryptedRecord {
  credentialId: string;
  householdId: string;
  provider: 'plaid';
}

interface ListedRecurringSeries {
  readonly seriesId: string;
  readonly accountId: string;
}

const providerFailure = (error: PlaidClientError): Response =>
  json(502, {
    code: 'provider_failed',
    message: `Provider request failed: ${error.errorCode ?? 'provider_error'}.`,
    details: {
      error_code: error.errorCode,
      error_type: error.errorType,
      request_id: error.requestId,
    },
  });

const providerBudgetFailure = (): Response =>
  json(503, {
    code: 'provider_budget_exhausted',
    message: 'Provider call budget exhausted.',
    details: {},
  });

const internalFailure = (): Response =>
  json(500, { code: 'transaction_failed', message: 'Command failed.', details: {} });

const credentialFailure = (): Response =>
  json(500, {
    code: 'credential_subsystem_unavailable',
    message: 'credential subsystem unavailable',
    details: {},
  });

const loadAuthzContext = async (supabase: UserClient, userId: string): Promise<AuthzContext> => {
  const [memberships, entityMemberships, accountOwnerships, accountPermissions] = await Promise.all(
    [
      supabase.from('household_memberships').select('household_id, role').eq('user_id', userId),
      supabase.from('entity_memberships').select('entity_id, entities(household_id)'),
      supabase.from('account_owners').select('account_id, accounts(household_id)'),
      supabase
        .from('resource_permissions')
        .select('household_id, resource_id, permission')
        .eq('user_id', userId)
        .eq('resource_kind', 'account'),
    ],
  );
  return {
    userId: userId as AuthzContext['userId'],
    memberships: (memberships.data ?? []).map((row: { household_id: string; role: string }) => ({
      householdId: row.household_id as HouseholdId,
      role: row.role as HouseholdRole,
    })),
    entityMemberships: (entityMemberships.data ?? []).map(
      (row: { entity_id: string; entities: { household_id: string } | null }) => ({
        entityId: row.entity_id as AuthzContext['entityMemberships'][number]['entityId'],
        householdId: (row.entities?.household_id ?? '') as HouseholdId,
      }),
    ),
    accountOwnerships: (accountOwnerships.data ?? []).map(
      (row: { account_id: string; accounts: { household_id: string } | null }) => ({
        accountId: row.account_id as AuthzContext['accountOwnerships'][number]['accountId'],
        householdId: (row.accounts?.household_id ?? '') as HouseholdId,
      }),
    ),
    accountPermissions: (accountPermissions.data ?? []).map(
      (row: { household_id: string; resource_id: string; permission: string }) => ({
        accountId: row.resource_id as AuthzContext['accountPermissions'][number]['accountId'],
        householdId: row.household_id as HouseholdId,
        permission: row.permission as AuthzContext['accountPermissions'][number]['permission'],
      }),
    ),
  };
};

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'api' });
    }

    if (req.method !== 'POST') {
      return json(405, { code: 'invalid_command', message: 'POST required.', details: {} });
    }

    const userId = ctx.userClaims?.sub ?? ctx.jwtClaims?.sub;
    if (!userId) {
      return json(401, { code: 'not_authenticated', message: 'No subject claim.', details: {} });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { code: 'invalid_command', message: 'Invalid JSON.', details: {} });
    }

    if (path === '/admin/export') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Export request failed validation.',
          details: {},
        });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'admin.export_all', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const { data, error } = await ctx.supabaseAdmin.rpc('keel_export_household', {
        p_household_id: householdId.data,
      });
      if (error) return mapDbError(error);

      try {
        const snapshot = data as HouseholdExport;
        const jsonExport = toJson(snapshot);
        const envelope = JSON.parse(jsonExport) as { manifest: unknown };
        const response = {
          manifest: envelope.manifest,
          json: jsonExport,
          csv: toCsvFiles(snapshot),
          qif: toQif(snapshot),
          beancount: toBeancount(snapshot),
        };
        const serialized = JSON.stringify(response);
        if (!isWithinInlineExportLimit(serialized)) {
          return json(413, {
            code: 'export_too_large',
            message: 'Use the async export job.',
            details: {},
          });
        }
        return new Response(serialized, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (formatError) {
        return formatError instanceof ExportSecretError
          ? json(422, {
              code: 'export_secret_detected',
              message: 'Export blocked by the secret boundary.',
              details: {},
            })
          : internalFailure();
      }
    }

    if (path === '/ai/chat') {
      // KEEL agent (Laws 1/2/5/7/9/10/11/12). The model reaches data ONLY
      // through the authorized read-tool catalog (_shared/agent.ts) — same
      // fail-closed authz + procs as every other surface, no side door. Reads
      // are free; writes are governed (notes auto+undo; budgets/reimbursements
      // approval-gated) and land in later slices. This slice is read-only:
      // NOTHING here can write.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const question = input['question'];
      if (
        !householdId.success ||
        typeof question !== 'string' ||
        question.trim().length === 0 ||
        question.length > 2000
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Chat request failed validation.',
          details: {},
        });
      }

      // Law 12: provider keys live ONLY in provider secret stores — the function
      // environment first, Supabase Vault second (service_role-only definer
      // keel_ai_provider_key). Anthropic preferred when configured (best tool
      // use; matches the system's Anthropic-shaped laws), else OpenAI-compatible.
      // Absent everywhere = feature off, clean typed 503 — never stubbed. Keys
      // never leave this scope, never logged.
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
      let openaiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
      if (openaiKey.length === 0 && anthropicKey.length === 0) {
        const { data: vaultKey } = await ctx.supabaseAdmin.rpc('keel_ai_provider_key');
        openaiKey = typeof vaultKey === 'string' ? vaultKey : '';
      }
      const providerKind =
        (Deno.env.get('AI_PROVIDER') ?? (anthropicKey.length > 0 ? 'anthropic' : 'openai')).toLowerCase();
      const activeKey = providerKind === 'anthropic' ? anthropicKey : openaiKey;
      if (activeKey.length === 0) {
        return json(503, {
          code: 'ai_unavailable',
          message: 'AI assistant is not configured.',
          details: {},
        });
      }

      // Same fail-closed compiler as every other surface (Laws 7/9). The agent
      // needs at least the two viewer-tier reads before any tool can run; each
      // individual tool re-authorizes its own action inside makeExecuteReadTool.
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      for (const action of ['transactions.list', 'ledger.trial_balance'] as const) {
        const decision = authorize(authzCtx, action, {
          kind: 'household',
          householdId: householdId.data,
        });
        if (!decision.allowed) {
          return decision.code === 'household_scope_violation'
            ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
            : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
        }
      }

      const nowIso = new Date().toISOString();
      const todayIso = nowIso.slice(0, 10);
      // Per-request random boundary so ingested memos can't pre-embed the data
      // delimiter (Law 5, spotlighting).
      const dataBoundary = `kd-${crypto.randomUUID()}`;

      // Personal context (slice 5): the user's authored profile (TRUSTED,
      // user-tier — not ingested data) + deterministic auto-derived facts
      // (accounts connected, entities, budget presence). Best-effort: any
      // failure degrades to no context and never blocks the answer.
      let personalProfile = '';
      let derivedContext = '';
      try {
        const monthIso = `${todayIso.slice(0, 7)}-01`;
        const [profileRes, entitiesRes, accountsRes, targetsRes] = await Promise.all([
          ctx.supabase.rpc('keel_ai_profile_get', { p_household_id: householdId.data }),
          ctx.supabase.from('entities').select('name').eq('household_id', householdId.data),
          ctx.supabase
            .from('accounts')
            .select('name, subtype')
            .eq('household_id', householdId.data)
            .is('archived_at', null)
            .order('name'),
          ctx.supabase
            .from('budget_targets')
            .select('household_id')
            .eq('household_id', householdId.data)
            .is('end_month', null)
            .limit(1),
        ]);
        if (typeof profileRes.data === 'string') personalProfile = profileRes.data;
        const entities = ((entitiesRes.data ?? []) as { name?: string }[])
          .map((e) => ({ name: typeof e.name === 'string' ? e.name : '' }))
          .filter((e) => e.name.length > 0);
        const accounts = ((accountsRes.data ?? []) as { name?: string; subtype?: string }[])
          .map((a) => ({ name: a.name ?? '', subtype: a.subtype ?? 'account' }))
          .filter((a) => a.name.length > 0);
        derivedContext = buildDerivedContext({
          accounts,
          entities,
          budgetsMonth: todayIso.slice(0, 7),
          hasBudget: Array.isArray(targetsRes.data) && targetsRes.data.length > 0,
        });
      } catch {
        // Personal context is optional; never fail the request over it.
      }

      const system = buildAgentSystemPrompt({
        dataBoundary,
        asOf: nowIso,
        personalProfile,
        derivedContext,
      });

      const provider =
        providerKind === 'anthropic'
          ? new AnthropicAgentProvider({
              baseUrl: Deno.env.get('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com',
              model: Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
              apiKey: anthropicKey,
              anthropicVersion: Deno.env.get('ANTHROPIC_VERSION') ?? '2023-06-01',
            })
          : new OpenAiAgentProvider({
              baseUrl: Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
              model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini',
              apiKey: openaiKey,
            });

      // Class-A auto writes (notes) report here; collected into the record so
      // the UI can show what changed + offer undo (Law 2). Budgets/reimbursements
      // are Class B (proposals) and land in later slices.
      const appliedActions: AppliedAction[] = [];
      const proposedActions: ProposedAction[] = [];
      const executeTool = makeExecuteAgentTool({
        authorize,
        authzCtx,
        householdId: householdId.data,
        rpc: (proc, args) => ctx.supabase.rpc(proc, args),
        todayIso,
        onApplied: (action) => appliedActions.push(action),
        onProposed: (action) => proposedActions.push(action),
      });

      const startedAt = Date.now();
      try {
        const run = await runAgent({
          provider,
          system,
          tools: agentToolDefinitions(),
          userMessage: question.trim(),
          executeTool,
          maxSteps: 8,
          maxTokens: 1024,
        });
        // Telemetry: model, step count, and tool NAMES only — never the
        // question, tool results, or any credential (Law 12).
        console.log(
          'ai_agent_run',
          JSON.stringify({
            provider: providerKind,
            model: run.modelVersion,
            steps: run.steps,
            stoppedReason: run.stoppedReason,
            tools: run.toolCalls.map((t) => t.call.name),
            appliedCount: appliedActions.length,
            proposedCount: proposedActions.length,
            latencyMs: Date.now() - startedAt,
            inputTokens: run.usage.inputTokens,
            outputTokens: run.usage.outputTokens,
          }),
        );
        const record = buildAgentResponseRecord({
          text: run.finalText,
          asOf: nowIso,
          scope: { householdId: householdId.data, entityIds: [] },
          modelVersion: run.modelVersion,
          toolsUsed: run.toolCalls.map((t) => t.call.name),
          steps: run.steps,
          stoppedReason: run.stoppedReason,
          appliedActions,
          proposedActions,
        });
        return json(200, record);
      } catch (error) {
        if (error instanceof AiProviderError || error instanceof EmptyAgentResponseError) {
          // Status code only — provider error bodies never reach logs or wire.
          console.error(
            'ai_agent_provider_failed',
            error instanceof AiProviderError ? (error.status ?? 'transport') : 'empty',
          );
          return json(502, {
            code: 'ai_upstream_failed',
            message: 'The AI provider request failed. Try again shortly.',
            details: {},
          });
        }
        return internalFailure();
      }
    }

    if (path === '/ai/profile/get' || path === '/ai/profile/save') {
      // Personal-context profile (slice 5): trusted, user-authored free text
      // the agent receives as context. Membership + audit are enforced in the
      // definer procs (keel_ai_profile_get / keel_ai_profile_save).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'AI profile request failed validation.',
          details: {},
        });
      }
      if (path === '/ai/profile/get') {
        const { data, error } = await ctx.supabase.rpc('keel_ai_profile_get', {
          p_household_id: householdId.data,
        });
        if (error) return mapDbError(error);
        return json(200, { profileText: typeof data === 'string' ? data : '' });
      }
      const profileText = input['profileText'];
      if (typeof profileText !== 'string' || profileText.length > 4000) {
        return json(400, {
          code: 'invalid_command',
          message: 'AI profile request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_ai_profile_save', {
        p_household_id: householdId.data,
        p_profile_text: profileText,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (path === '/connections/link-token') {
      // Create a Plaid Link token so the browser can open Plaid Link (real
      // institution auth). Works in sandbox + production.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, { code: 'invalid_command', message: 'Unknown command.', details: {} });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'connections.link', {
        kind: 'household',
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const plaid = createPlaidClient(ctx.supabaseAdmin, {
        env: Deno.env.get('PLAID_ENV') ?? 'sandbox',
        clientId: Deno.env.get('PLAID_CLIENT_ID'),
        secret: Deno.env.get('PLAID_SECRET'),
        householdId: householdId.data,
      });
      try {
        const splitEnv = (name: string, fallback: string) =>
          (Deno.env.get(name) ?? fallback)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        // Request the deepest transaction history Plaid allows (730 days) so an
        // account's synced window reaches back far enough to be meaningful —
        // Venmo especially defaults to a shallow ~90-day window. Institutions
        // cap this lower and Plaid honors the smaller value; that's fine. Env
        // override for tuning without a redeploy. The opening-balance anchor
        // keeps the DISPLAYED balance tied to the bank regardless of depth;
        // deeper history just makes the register and trends more complete.
        const daysRequested = Number.parseInt(
          Deno.env.get('PLAID_TRANSACTIONS_DAYS_REQUESTED') ?? '730',
          10,
        );
        const result = await plaid.linkTokenCreate(`linktoken:${householdId.data}:${userId}`, {
          user: { client_user_id: userId },
          client_name: 'KEEL',
          // S-inv-1b: 'investments' lets Link authorize the Investments
          // product on new items so the worker's holdings sync
          // (processRefreshBalances) can call /investments/holdings/get.
          // Sandbox and existing trial-tier Plaid access both cover this
          // with no dashboard step; only true production needs one later.
          products: splitEnv('PLAID_PRODUCTS', 'transactions,investments'),
          country_codes: splitEnv('PLAID_COUNTRY_CODES', 'US'),
          language: 'en',
          ...(Number.isSafeInteger(daysRequested) && daysRequested > 0
            ? { transactions: { days_requested: daysRequested } }
            : {}),
        });
        const linkToken = result['link_token'];
        if (typeof linkToken !== 'string') return internalFailure();
        return json(200, { linkToken });
      } catch (error) {
        return error instanceof ProviderBudgetExhaustedError
          ? providerBudgetFailure()
          : error instanceof PlaidClientError
            ? providerFailure(error)
            : internalFailure();
      }
    }

    if (path === '/connections/link') {
      const input = body as Record<string, unknown>;
      const commandId = CommandIdSchema.safeParse(input['commandId']);
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const entityId = EntityIdSchema.safeParse(input['entityId']);
      if (!commandId.success || !householdId.success || !entityId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Connection link request failed validation.',
          details: {},
        });
      }
      const institutionId = input['institutionId'];
      if (institutionId !== undefined && typeof institutionId !== 'string') {
        return json(400, {
          code: 'invalid_command',
          message: 'Connection link request failed validation.',
          details: {},
        });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'connections.link', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const { data: beginData, error: beginError } = await ctx.supabase.rpc('keel_begin_link', {
        p_command_id: commandId.data,
        p_household_id: householdId.data,
        p_entity_id: entityId.data,
        p_provider: 'plaid',
        p_institution_id: institutionId ?? null,
      });
      if (beginError) return mapDbError(beginError);
      const begin = beginData as LinkBeginResult;

      if (begin.state === 'succeeded' && begin.connectionId) {
        const { data: accountRows, error: accountError } = await ctx.supabase
          .from('accounts')
          .select('id')
          .eq('connection_id', begin.connectionId)
          .order('created_at')
          .order('id');
        if (accountError) return internalFailure();
        return json(200, {
          connectionId: begin.connectionId,
          accountIds: (accountRows ?? []).map((row: { id: string }) => row.id),
        });
      }
      if (begin.state !== 'initiated') {
        return json(409, {
          code: 'link_attempt_terminated',
          message: 'This link command cannot be resumed.',
          details: {},
        });
      }

      const plaid = createPlaidClient(ctx.supabaseAdmin, {
        env: Deno.env.get('PLAID_ENV') ?? 'sandbox',
        clientId: Deno.env.get('PLAID_CLIENT_ID'),
        secret: Deno.env.get('PLAID_SECRET'),
        householdId: householdId.data,
      });
      const providedPublicToken = input['publicToken'];
      let accessToken: string;
      let itemId: string;
      try {
        let publicToken: string;
        if (typeof providedPublicToken === 'string' && providedPublicToken.length > 0) {
          // Production / real flow: the frontend obtained a public_token from Plaid
          // Link (the user authenticated with their real institution). Just exchange it.
          publicToken = providedPublicToken;
        } else {
          // Sandbox synthesis path (no Plaid Link UI): create a public_token
          // server-side. Live /sandbox/public_token/create requires a real
          // institution + products; the injected/hermetic path ignores this body.
          const sandboxInstitution =
            typeof institutionId === 'string' && institutionId.startsWith('ins_')
              ? institutionId
              : 'ins_109508';
          const publicResult = await plaid.sandboxPublicTokenCreate(begin.attemptId, {
            institution_id: sandboxInstitution,
            initial_products: ['transactions'],
          });
          publicToken = publicResult.public_token;
        }
        const exchange = await plaid.publicTokenExchange(begin.attemptId, {
          public_token: publicToken,
        });
        accessToken = exchange.access_token;
        itemId = exchange.item_id;
      } catch (error) {
        return error instanceof ProviderBudgetExhaustedError
          ? providerBudgetFailure()
          : error instanceof PlaidClientError
            ? providerFailure(error)
            : internalFailure();
      }

      let encrypted: EncryptedRecord;
      try {
        const version = currentKekVersion();
        encrypted = await encryptToken(
          accessToken,
          begin.credentialId,
          householdId.data,
          'plaid',
          getKek(version),
          version,
        );
      } catch {
        try {
          await plaid.itemRemove(begin.attemptId, { access_token: accessToken });
        } catch {
          // Best effort only: this request never persisted ownership of the attempt.
        }
        return credentialFailure();
      }

      const { error: exchangePersistError } = await ctx.supabaseAdmin.rpc(
        'keel_record_link_exchange',
        {
          p_attempt_id: begin.attemptId,
          p_household_id: householdId.data,
          p_credential_id: begin.credentialId,
          p_plaid_item_id: itemId,
          p_ciphertext_b64: encrypted.ciphertext,
          p_iv_b64: encrypted.iv,
          p_wrapped_dek_b64: encrypted.wrappedDek,
          p_wrap_iv_b64: encrypted.wrapIv,
          p_kek_version: encrypted.kekVersion,
        },
      );
      if (exchangePersistError) {
        try {
          await plaid.itemRemove(begin.attemptId, { access_token: accessToken });
        } catch {
          // Best effort only: do not mutate the shared attempt on compensation failure.
        }
        const { data: persistedAttempt } = await ctx.supabaseAdmin
          .from('link_attempts')
          .select('state, plaid_item_id')
          .eq('id', begin.attemptId)
          .single();
        if (
          exchangePersistError.code === 'P0009' &&
          exchangePersistError.message.includes('link attempt is not initiated') &&
          (persistedAttempt?.state === 'exchanged' || persistedAttempt?.state === 'succeeded') &&
          persistedAttempt.plaid_item_id !== itemId
        ) {
          return json(409, {
            code: 'link_attempt_conflict',
            message: 'Another request completed this link exchange.',
            details: {},
          });
        }
        return internalFailure();
      }

      let mapped: ReturnType<typeof mapAccountsGetToKeel>;
      try {
        const accountsBody = await plaid.accountsGet(begin.attemptId, {
          access_token: accessToken,
        });
        mapped = mapAccountsGetToKeel(accountsBody);
      } catch (error) {
        await ctx.supabaseAdmin.rpc('keel_fail_link_attempt', {
          p_attempt_id: begin.attemptId,
          p_household_id: householdId.data,
          p_reason: 'accounts_get_failed',
          p_removed: false,
          p_plaid_item_id: itemId,
        });
        return error instanceof ProviderBudgetExhaustedError
          ? providerBudgetFailure()
          : error instanceof PlaidClientError
            ? providerFailure(error)
            : internalFailure();
      }

      if (mapped.accounts.length === 0) {
        let removed = false;
        try {
          removed = await plaid.itemRemove(begin.attemptId, { access_token: accessToken });
        } catch {
          removed = false;
        }
        await ctx.supabaseAdmin.rpc('keel_fail_link_attempt', {
          p_attempt_id: begin.attemptId,
          p_household_id: householdId.data,
          p_reason: 'no_usd_accounts',
          p_removed: removed,
          p_plaid_item_id: itemId,
        });
        return json(422, {
          code: 'no_supported_accounts',
          message: 'No supported accounts were found.',
          details: {},
        });
      }

      const dbAccounts = mapped.accounts.map((account) => ({
        external_ref: account.externalRef,
        name: account.name,
        subtype: account.subtype,
        currency: account.currency,
        kind: account.kind,
        // Teardown C6/D-050: last-4 mask for disambiguating same-institution
        // accounts. Null passes through keel_finalize_link's nullif() as-is.
        mask: account.mask,
      }));
      const { data: finalized, error: finalizeError } = await ctx.supabaseAdmin.rpc(
        'keel_finalize_link',
        {
          p_attempt_id: begin.attemptId,
          p_household_id: householdId.data,
          p_institution_id: institutionId ?? null,
          p_consent_expires_at: null,
          p_accounts: dbAccounts,
        },
      );
      if (finalizeError) {
        await ctx.supabaseAdmin.rpc('keel_fail_link_attempt', {
          p_attempt_id: begin.attemptId,
          p_household_id: householdId.data,
          p_reason: 'finalize_failed',
          p_removed: false,
          p_plaid_item_id: itemId,
        });
        return internalFailure();
      }

      // Start the initial backfill immediately; the 3-minute cron remains the
      // fallback. Best-effort: a drain failure must not undo a successful link.
      await ctx.supabaseAdmin.rpc('keel_cron_drain_sync', {});

      // Record the institution's human name (from Plaid Link metadata) so the
      // connection reads as "Chase" rather than "plaid". Best-effort: a naming
      // failure must not fail an otherwise-successful link.
      const institutionName = input['institutionName'];
      const finalizedConnectionId = (finalized as { connectionId?: string } | null)?.connectionId;
      if (
        typeof institutionName === 'string' &&
        institutionName.trim().length > 0 &&
        finalizedConnectionId
      ) {
        await ctx.supabase.rpc('keel_rename_connection', {
          p_household_id: householdId.data,
          p_connection_id: finalizedConnectionId,
          p_display_name: institutionName.trim().slice(0, 80),
        });
      }
      return json(200, finalized);
    }

    if (path === '/transactions/categorize') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const txnId = input['transactionId'];
      const categoryId = input['categoryLedgerAccountId'];
      if (
        !householdId.success ||
        typeof txnId !== 'string' ||
        !uuidRe.test(txnId) ||
        typeof categoryId !== 'string' ||
        !uuidRe.test(categoryId)
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Categorize request failed validation.',
          details: {},
        });
      }
      // The proc enforces household membership (auth.uid) + category validity.
      const { error: catError } = await ctx.supabase.rpc('keel_categorize_transaction', {
        p_household_id: householdId.data,
        p_txn_id: txnId,
        p_category_ledger_account_id: categoryId,
      });
      if (catError) return mapDbError(catError);
      return json(200, { ok: true });
    }

    if (path === '/transactions/override') {
      // User-editable display name + note. Presentation overlay only — the
      // canonical description is immutable (source preservation); blank
      // fields clear the override. The proc enforces membership + ownership.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const txnId = input['transactionId'];
      const displayDescription = input['displayDescription'];
      const note = input['note'];
      const okString = (v: unknown, max: number) =>
        v === undefined || v === null || (typeof v === 'string' && v.length <= max);
      if (
        !householdId.success ||
        typeof txnId !== 'string' ||
        !uuidRe.test(txnId) ||
        !okString(displayDescription, 140) ||
        !okString(note, 2000)
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Override request failed validation.',
          details: {},
        });
      }
      const { error: ovError } = await ctx.supabase.rpc('keel_set_transaction_override', {
        p_household_id: householdId.data,
        p_txn_id: txnId,
        p_display_description: typeof displayDescription === 'string' ? displayDescription : null,
        p_note: typeof note === 'string' ? note : null,
      });
      if (ovError) return mapDbError(ovError);
      return json(200, { ok: true });
    }

    if (path === '/accounts/rename') {
      // Plain metadata edit (Law 2/9: user-owned, not an AI action — no
      // suggest/approve gate applies). The proc enforces membership + write
      // role + the accounts.name check constraint (1-200 chars).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const accountId = AccountIdSchema.safeParse(input['accountId']);
      const name = input['name'];
      if (
        !householdId.success ||
        !accountId.success ||
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > 200
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Rename request failed validation.',
          details: {},
        });
      }
      const { error: renameError } = await ctx.supabase.rpc('keel_rename_account', {
        p_household_id: householdId.data,
        p_account_id: accountId.data,
        p_name: name,
      });
      if (renameError) return mapDbError(renameError);
      return json(200, { ok: true });
    }

    if (path === '/accounts/reassign-entity') {
      // Plain ownership correction (Law 9 explicit ownership), same shape
      // as /accounts/rename -- no economic-event key, no suggest/approve
      // gate. Fixes accounts (esp. Plaid-connected ones) that landed under
      // the wrong entity at connect time.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const accountId = AccountIdSchema.safeParse(input['accountId']);
      const entityId = EntityIdSchema.safeParse(input['entityId']);
      if (!householdId.success || !accountId.success || !entityId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Reassign-entity request failed validation.',
          details: {},
        });
      }
      const { error: reassignError } = await ctx.supabase.rpc('keel_reassign_account_entity', {
        p_household_id: householdId.data,
        p_account_id: accountId.data,
        p_entity_id: entityId.data,
      });
      if (reassignError) return mapDbError(reassignError);
      return json(200, { ok: true });
    }

    if (path === '/holdings/upsert') {
      // Manual holding entry (S-inv-1a, docs/harness/plans/investments-v1.md).
      // Descriptive-only: never touches the ledger. Server computes
      // value_minor itself (Law 4) -- the client's preview number is
      // display-only, never trusted for storage.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const accountId = AccountIdSchema.safeParse(input['accountId']);
      const holdingId = input['holdingId'];
      const symbol = input['symbol'];
      const name = input['name'];
      const qty = input['qty'];
      const priceMinor = input['priceMinor'];
      const costBasisMinor = input['costBasisMinor'];
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const decimalRe = /^\d+(\.\d{1,8})?$/;
      const intRe = /^\d+$/;
      if (
        !householdId.success ||
        !accountId.success ||
        (holdingId !== undefined && holdingId !== null && (typeof holdingId !== 'string' || !uuidRe.test(holdingId))) ||
        typeof symbol !== 'string' ||
        symbol.trim().length === 0 ||
        symbol.length > 20 ||
        (name !== undefined && name !== null && typeof name !== 'string') ||
        typeof qty !== 'string' ||
        !decimalRe.test(qty) ||
        typeof priceMinor !== 'string' ||
        !intRe.test(priceMinor) ||
        (costBasisMinor !== undefined && costBasisMinor !== null &&
          (typeof costBasisMinor !== 'string' || !intRe.test(costBasisMinor)))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Holding request failed validation.',
          details: {},
        });
      }
      const { data: newHoldingId, error: upsertError } = await ctx.supabase.rpc('keel_holding_upsert', {
        p_household_id: householdId.data,
        p_account_id: accountId.data,
        p_holding_id: holdingId ?? null,
        p_symbol: symbol,
        p_name: name ?? null,
        p_qty: qty,
        p_price_minor: priceMinor,
        p_cost_basis_minor: costBasisMinor ?? null,
      });
      if (upsertError) return mapDbError(upsertError);
      return json(200, { holdingId: newHoldingId });
    }

    if (path === '/holdings/delete') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const holdingId = input['holdingId'];
      if (!householdId.success || typeof holdingId !== 'string' || !uuidRe.test(holdingId)) {
        return json(400, {
          code: 'invalid_command',
          message: 'Holding delete request failed validation.',
          details: {},
        });
      }
      const { error: deleteError } = await ctx.supabase.rpc('keel_holding_delete', {
        p_household_id: householdId.data,
        p_holding_id: holdingId,
      });
      if (deleteError) return mapDbError(deleteError);
      return json(200, { ok: true });
    }

    if (path === '/entities/create') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const name = input['name'];
      const kind = EntityKindSchema.safeParse(input['kind']);
      if (
        !householdId.success ||
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > 200 ||
        !kind.success
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Entity request failed validation.',
          details: {},
        });
      }
      const { data, error } = await ctx.supabase.rpc('keel_create_entity', {
        p_household_id: householdId.data,
        p_name: name,
        p_kind: kind.data,
      });
      if (error) return mapDbError(error);
      return json(200, { entityId: data });
    }

    if (path === '/categories/create') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const name = input['name'];
      const kind = input['kind'];
      const parent = input['parentLedgerAccountId'];
      const entityId = input['entityId'];
      const uuidReCat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !householdId.success ||
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > 80 ||
        (kind !== 'expense' && kind !== 'income') ||
        (parent !== undefined &&
          parent !== null &&
          (typeof parent !== 'string' || !uuidReCat.test(parent))) ||
        (entityId !== undefined &&
          entityId !== null &&
          (typeof entityId !== 'string' || !uuidReCat.test(entityId)))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Category request failed validation.',
          details: {},
        });
      }
      const { data, error } = await ctx.supabase.rpc('keel_create_category', {
        p_household_id: householdId.data,
        p_name: name,
        p_kind: kind,
        p_parent_ledger_account_id: typeof parent === 'string' ? parent : null,
        p_entity_id: typeof entityId === 'string' ? entityId : null,
      });
      if (error) return mapDbError(error);
      return json(200, { ledgerAccountId: data });
    }

    if (path === '/categories/set-tax-line') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReTax = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const categoryId = input['categoryLedgerAccountId'];
      const taxLine = input['taxLine'] ?? null;
      // The proc validates the enum value; here only shape.
      if (
        !householdId.success ||
        typeof categoryId !== 'string' ||
        !uuidReTax.test(categoryId) ||
        (taxLine !== null && (typeof taxLine !== 'string' || taxLine.length > 40))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Tax line request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_set_category_tax_line', {
        p_household_id: householdId.data,
        p_ledger_account_id: categoryId,
        p_tax_line: taxLine,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (
      path === '/categories/rename' ||
      path === '/categories/archive' ||
      path === '/categories/reparent'
    ) {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReCat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const categoryId = input['categoryLedgerAccountId'];
      if (!householdId.success || typeof categoryId !== 'string' || !uuidReCat.test(categoryId)) {
        return json(400, {
          code: 'invalid_command',
          message: 'Category request failed validation.',
          details: {},
        });
      }
      if (path === '/categories/rename') {
        const name = input['name'];
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
          return json(400, {
            code: 'invalid_command',
            message: 'Category request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_rename_category', {
          p_household_id: householdId.data,
          p_category_ledger_account_id: categoryId,
          p_name: name,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      if (path === '/categories/archive') {
        const reassignTo = input['reassignTo'];
        if (
          reassignTo !== undefined &&
          reassignTo !== null &&
          (typeof reassignTo !== 'string' || !uuidReCat.test(reassignTo))
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Category request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_archive_category', {
          p_household_id: householdId.data,
          p_category_ledger_account_id: categoryId,
          p_reassign_to: typeof reassignTo === 'string' ? reassignTo : null,
        });
        if (error) return mapDbError(error);
        return json(200, data ?? { ok: true });
      }
      const parentId = input['parentLedgerAccountId'];
      if (
        parentId !== undefined &&
        parentId !== null &&
        (typeof parentId !== 'string' || !uuidReCat.test(parentId))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Category request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_reparent_category', {
        p_household_id: householdId.data,
        p_category_ledger_account_id: categoryId,
        p_parent_ledger_account_id: typeof parentId === 'string' ? parentId : null,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (path === '/budgets/set' || path === '/budgets/copy') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const month = input['month'];
      if (!householdId.success || typeof month !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(month)) {
        return json(400, {
          code: 'invalid_command',
          message: 'Budget request failed validation.',
          details: {},
        });
      }
      if (path === '/budgets/copy') {
        const { data, error } = await ctx.supabase.rpc('keel_copy_budgets', {
          p_household_id: householdId.data,
          p_month: month,
        });
        if (error) return mapDbError(error);
        return json(200, { copied: data ?? 0 });
      }
      const categoryId = input['categoryLedgerAccountId'];
      const amountMinor = input['amountMinor'];
      if (
        typeof categoryId !== 'string' ||
        !uuidRe.test(categoryId) ||
        (amountMinor !== null && (typeof amountMinor !== 'string' || !/^\d+$/.test(amountMinor)))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Budget request failed validation.',
          details: {},
        });
      }
      const rollover = input['rollover'];
      if (rollover !== undefined && rollover !== null && typeof rollover !== 'boolean') {
        return json(400, {
          code: 'invalid_command',
          message: 'Budget request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_set_budget', {
        p_household_id: householdId.data,
        p_category_ledger_account_id: categoryId,
        p_month: month,
        p_amount_minor: amountMinor === null ? null : amountMinor,
        p_rollover: typeof rollover === 'boolean' ? rollover : null,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (path === '/tags/save' || path === '/tags/delete' || path === '/tags/assign') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReTag = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Tag request failed validation.',
          details: {},
        });
      }
      if (path === '/tags/save') {
        const tagId = input['tagId'];
        const name = input['name'];
        if (
          (tagId !== undefined &&
            tagId !== null &&
            (typeof tagId !== 'string' || !uuidReTag.test(tagId))) ||
          typeof name !== 'string' ||
          name.trim().length === 0 ||
          name.length > 40
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Tag request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_tag_save', {
          p_household_id: householdId.data,
          p_tag_id: typeof tagId === 'string' ? tagId : null,
          p_name: name,
        });
        if (error) return mapDbError(error);
        return json(200, { tagId: data });
      }
      if (path === '/tags/delete') {
        const tagId = input['tagId'];
        if (typeof tagId !== 'string' || !uuidReTag.test(tagId)) {
          return json(400, {
            code: 'invalid_command',
            message: 'Tag request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_tag_delete', {
          p_household_id: householdId.data,
          p_tag_id: tagId,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      const txnId = input['transactionId'];
      const tagId = input['tagId'];
      const assigned = input['assigned'];
      if (
        typeof txnId !== 'string' ||
        !uuidReTag.test(txnId) ||
        typeof tagId !== 'string' ||
        !uuidReTag.test(tagId) ||
        typeof assigned !== 'boolean'
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Tag request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_tag_assign', {
        p_household_id: householdId.data,
        p_txn_id: txnId,
        p_tag_id: tagId,
        p_assigned: assigned,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (
      path === '/notes/save' ||
      path === '/notes/archive' ||
      path === '/notes/unarchive' ||
      path === '/tasks/save' ||
      path === '/tasks/set-status'
    ) {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReNoteTask = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const dateReNoteTask = /^\d{4}-\d{2}-\d{2}$/;
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Notes/tasks request failed validation.',
          details: {},
        });
      }
      if (path === '/notes/save') {
        const noteId = input['noteId'] ?? null;
        const bodyText = input['body'];
        const pinned = input['pinned'] ?? false;
        if (
          (noteId !== null && (typeof noteId !== 'string' || !uuidReNoteTask.test(noteId))) ||
          typeof bodyText !== 'string' ||
          bodyText.trim().length === 0 ||
          bodyText.length > 1000 ||
          typeof pinned !== 'boolean'
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Note request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_note_save', {
          p_household_id: householdId.data,
          p_note_id: noteId,
          p_body: bodyText,
          p_pinned: pinned,
        });
        if (error) return mapDbError(error);
        return json(200, { noteId: data });
      }
      if (path === '/notes/archive') {
        const noteId = input['noteId'];
        if (typeof noteId !== 'string' || !uuidReNoteTask.test(noteId)) {
          return json(400, {
            code: 'invalid_command',
            message: 'Note request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_note_archive', {
          p_household_id: householdId.data,
          p_note_id: noteId,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      if (path === '/notes/unarchive') {
        // Undo for an archive (Law 2). Restores a soft-deleted note.
        const noteId = input['noteId'];
        if (typeof noteId !== 'string' || !uuidReNoteTask.test(noteId)) {
          return json(400, {
            code: 'invalid_command',
            message: 'Note request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_note_unarchive', {
          p_household_id: householdId.data,
          p_note_id: noteId,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      if (path === '/tasks/save') {
        const taskId = input['taskId'] ?? null;
        const title = input['title'];
        const description = input['description'] ?? null;
        const dueOn = input['dueOn'] ?? null;
        const priority = input['priority'] ?? 'normal';
        if (
          (taskId !== null && (typeof taskId !== 'string' || !uuidReNoteTask.test(taskId))) ||
          typeof title !== 'string' ||
          title.trim().length === 0 ||
          title.length > 160 ||
          (description !== null &&
            (typeof description !== 'string' || description.length > 1000)) ||
          (dueOn !== null && (typeof dueOn !== 'string' || !dateReNoteTask.test(dueOn))) ||
          (priority !== 'low' && priority !== 'normal' && priority !== 'high')
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Task request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_task_save', {
          p_household_id: householdId.data,
          p_task_id: taskId,
          p_title: title,
          p_description: description,
          p_due_on: dueOn,
          p_priority: priority,
        });
        if (error) return mapDbError(error);
        return json(200, { taskId: data });
      }
      const taskId = input['taskId'];
      const status = input['status'];
      if (
        typeof taskId !== 'string' ||
        !uuidReNoteTask.test(taskId) ||
        (status !== 'open' && status !== 'done' && status !== 'dismissed')
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Task request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_task_set_status', {
        p_household_id: householdId.data,
        p_task_id: taskId,
        p_status: status,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (path === '/goals/save' || path === '/goals/contribute' || path === '/goals/set-status') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReGoal = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const dateReGoal = /^\d{4}-\d{2}-\d{2}$/;
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Goal request failed validation.',
          details: {},
        });
      }
      if (path === '/goals/save') {
        const goalId = input['goalId'] ?? null;
        const name = input['name'];
        const targetMinor = input['targetMinor'];
        const targetDate = input['targetDate'] ?? null;
        const accountId = input['accountId'] ?? null;
        const kind = input['kind'] ?? 'savings';
        if (
          (goalId !== null && (typeof goalId !== 'string' || !uuidReGoal.test(goalId))) ||
          typeof name !== 'string' ||
          name.trim().length === 0 ||
          name.length > 80 ||
          typeof targetMinor !== 'string' ||
          !/^\d{1,18}$/.test(targetMinor) ||
          (targetDate !== null &&
            (typeof targetDate !== 'string' || !dateReGoal.test(targetDate))) ||
          (accountId !== null && (typeof accountId !== 'string' || !uuidReGoal.test(accountId))) ||
          (kind !== 'savings' && kind !== 'debt')
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Goal request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_goal_save', {
          p_household_id: householdId.data,
          p_goal_id: goalId,
          p_name: name,
          p_target_minor: targetMinor,
          p_target_date: targetDate,
          p_account_id: accountId,
          p_kind: kind,
        });
        if (error) return mapDbError(error);
        return json(200, { goalId: data });
      }
      if (path === '/goals/contribute') {
        const goalId = input['goalId'];
        const amountMinor = input['amountMinor'];
        const contributedOn = input['contributedOn'];
        if (
          typeof goalId !== 'string' ||
          !uuidReGoal.test(goalId) ||
          typeof amountMinor !== 'string' ||
          !/^-?\d{1,18}$/.test(amountMinor) ||
          amountMinor === '0' ||
          typeof contributedOn !== 'string' ||
          !dateReGoal.test(contributedOn)
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Goal request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_goal_contribute', {
          p_household_id: householdId.data,
          p_goal_id: goalId,
          p_amount_minor: amountMinor,
          p_contributed_on: contributedOn,
        });
        if (error) return mapDbError(error);
        return json(200, data ?? { ok: true });
      }
      const goalId = input['goalId'];
      const status = input['status'];
      if (
        typeof goalId !== 'string' ||
        !uuidReGoal.test(goalId) ||
        typeof status !== 'string' ||
        status.length > 10
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Goal request failed validation.',
          details: {},
        });
      }
      const { error } = await ctx.supabase.rpc('keel_goal_set_status', {
        p_household_id: householdId.data,
        p_goal_id: goalId,
        p_status: status,
      });
      if (error) return mapDbError(error);
      return json(200, { ok: true });
    }

    if (
      path === '/schedules/save' ||
      path === '/schedules/set-status' ||
      path === '/schedules/advance' ||
      path === '/schedules/enter'
    ) {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidReSched = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Schedule request failed validation.',
          details: {},
        });
      }
      if (path === '/schedules/save') {
        const scheduleId = input['scheduleId'] ?? null;
        const accountId = input['accountId'];
        const description = input['description'];
        const amountMinor = input['amountMinor'];
        const categoryId = input['categoryLedgerAccountId'] ?? null;
        const frequency = input['frequency'];
        const nextDueDate = input['nextDueDate'];
        const autoEnterDays = input['autoEnterDays'] ?? null;
        const anchorDay = input['anchorDay'] ?? null;
        const anchorDay2 = input['anchorDay2'] ?? null;
        const isValidAnchor = (a: unknown) =>
          a === null || (typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= 31);
        if (
          (scheduleId !== null &&
            (typeof scheduleId !== 'string' || !uuidReSched.test(scheduleId))) ||
          typeof accountId !== 'string' ||
          !uuidReSched.test(accountId) ||
          typeof description !== 'string' ||
          description.trim().length === 0 ||
          description.length > 140 ||
          typeof amountMinor !== 'string' ||
          !/^-?\d{1,18}$/.test(amountMinor) ||
          (categoryId !== null &&
            (typeof categoryId !== 'string' || !uuidReSched.test(categoryId))) ||
          typeof frequency !== 'string' ||
          frequency.length > 20 ||
          typeof nextDueDate !== 'string' ||
          !dateRe.test(nextDueDate) ||
          (autoEnterDays !== null &&
            (typeof autoEnterDays !== 'number' || !Number.isInteger(autoEnterDays))) ||
          !isValidAnchor(anchorDay) ||
          !isValidAnchor(anchorDay2)
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Schedule request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_schedule_save', {
          p_household_id: householdId.data,
          p_schedule_id: scheduleId,
          p_account_id: accountId,
          p_description: description,
          p_amount_minor: amountMinor,
          p_category_ledger_account_id: categoryId,
          p_frequency: frequency,
          p_next_due_date: nextDueDate,
          p_auto_enter_days: autoEnterDays,
          p_anchor_day: anchorDay,
          p_anchor_day_2: anchorDay2,
        });
        if (error) return mapDbError(error);
        return json(200, { scheduleId: data });
      }
      if (path === '/schedules/set-status') {
        const scheduleId = input['scheduleId'];
        const status = input['status'];
        if (
          typeof scheduleId !== 'string' ||
          !uuidReSched.test(scheduleId) ||
          typeof status !== 'string' ||
          status.length > 10
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Schedule request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_schedule_set_status', {
          p_household_id: householdId.data,
          p_schedule_id: scheduleId,
          p_status: status,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      if (path === '/schedules/enter') {
        const scheduleId = input['scheduleId'];
        const fromDue = input['fromDueDate'];
        if (
          typeof scheduleId !== 'string' ||
          !uuidReSched.test(scheduleId) ||
          typeof fromDue !== 'string' ||
          !dateRe.test(fromDue)
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Schedule request failed validation.',
            details: {},
          });
        }
        const { data, error } = await ctx.supabase.rpc('keel_schedule_enter', {
          p_household_id: householdId.data,
          p_schedule_id: scheduleId,
          p_from_due: fromDue,
        });
        if (error) return mapDbError(error);
        return json(200, data ?? { ok: true });
      }
      const scheduleId = input['scheduleId'];
      const fromDue = input['fromDueDate'];
      const reason = input['reason'];
      if (
        typeof scheduleId !== 'string' ||
        !uuidReSched.test(scheduleId) ||
        typeof fromDue !== 'string' ||
        !dateRe.test(fromDue) ||
        (reason !== 'entered' && reason !== 'skipped')
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Schedule request failed validation.',
          details: {},
        });
      }
      const { data, error } = await ctx.supabase.rpc('keel_schedule_advance', {
        p_household_id: householdId.data,
        p_schedule_id: scheduleId,
        p_from_due: fromDue,
        p_reason: reason,
      });
      if (error) return mapDbError(error);
      return json(200, data ?? { ok: true });
    }

    if (path === '/rules/save' || path === '/rules/delete' || path === '/rules/apply') {
      // Deterministic user-authored rules (Law 1). Apply supports dryRun for
      // the preview-before-retroactive contract (BC-v2.1 §3); membership is
      // enforced inside each proc.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Rule request failed validation.',
          details: {},
        });
      }
      if (path === '/rules/apply') {
        const { data, error } = await ctx.supabase.rpc('keel_apply_rules', {
          p_household_id: householdId.data,
          p_dry_run: input['dryRun'] === true,
        });
        if (error) return mapDbError(error);
        return json(200, data);
      }
      if (path === '/rules/delete') {
        const ruleId = input['ruleId'];
        if (typeof ruleId !== 'string' || !uuidRe.test(ruleId)) {
          return json(400, {
            code: 'invalid_command',
            message: 'Rule request failed validation.',
            details: {},
          });
        }
        const { error } = await ctx.supabase.rpc('keel_rule_delete', {
          p_household_id: householdId.data,
          p_rule_id: ruleId,
        });
        if (error) return mapDbError(error);
        return json(200, { ok: true });
      }
      const ruleId = input['ruleId'];
      const pattern = input['pattern'];
      const categoryId = input['categoryLedgerAccountId'];
      const renameTo = input['renameTo'];
      const priority = input['priority'];
      const active = input['active'];
      // C18 residual: optional amount-range condition, string-encoded BIGINT
      // minor units (Law 4 — money never travels as a JSON number). Either,
      // both, or neither may be present; unsigned only (magnitude, not sign).
      const amountMinMinor = input['amountMinMinor'];
      const amountMaxMinor = input['amountMaxMinor'];
      const bigIntUnsignedRe = /^\d{1,18}$/;
      if (
        (ruleId !== undefined && (typeof ruleId !== 'string' || !uuidRe.test(ruleId))) ||
        typeof pattern !== 'string' ||
        pattern.length > 140 ||
        (categoryId !== undefined &&
          categoryId !== null &&
          (typeof categoryId !== 'string' || !uuidRe.test(categoryId))) ||
        (renameTo !== undefined &&
          renameTo !== null &&
          (typeof renameTo !== 'string' || renameTo.length > 140)) ||
        (priority !== undefined && typeof priority !== 'number') ||
        (active !== undefined && typeof active !== 'boolean') ||
        (amountMinMinor !== undefined && amountMinMinor !== null &&
          (typeof amountMinMinor !== 'string' || !bigIntUnsignedRe.test(amountMinMinor))) ||
        (amountMaxMinor !== undefined && amountMaxMinor !== null &&
          (typeof amountMaxMinor !== 'string' || !bigIntUnsignedRe.test(amountMaxMinor)))
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Rule request failed validation.',
          details: {},
        });
      }
      const { data, error } = await ctx.supabase.rpc('keel_rule_save', {
        p_household_id: householdId.data,
        p_rule_id: typeof ruleId === 'string' ? ruleId : null,
        p_pattern: pattern,
        p_category_ledger_account_id: typeof categoryId === 'string' ? categoryId : null,
        p_rename_to: typeof renameTo === 'string' ? renameTo : null,
        p_priority: typeof priority === 'number' ? Math.trunc(priority) : null,
        p_active: typeof active === 'boolean' ? active : null,
        p_amount_min_minor: typeof amountMinMinor === 'string' ? amountMinMinor : null,
        p_amount_max_minor: typeof amountMaxMinor === 'string' ? amountMaxMinor : null,
      });
      if (error) return mapDbError(error);
      return json(200, { ruleId: data });
    }

    if (path === '/transfers/detect') {
      // Deterministic transfer pairing (Law 1); results are SUGGESTIONS only
      // and change nothing until the user confirms (suggest→approve, Law 2).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer detect request failed validation.',
          details: {},
        });
      }
      const { data: created, error: detectError } = await ctx.supabase.rpc(
        'keel_detect_transfers',
        { p_household_id: householdId.data },
      );
      if (detectError) return mapDbError(detectError);
      return json(200, { suggested: created ?? 0 });
    }

    if (path === '/categorization/detect') {
      // Deterministic categorization proposals (Law 1); results are
      // SUGGESTIONS only and change nothing until the user decides
      // (suggest→approve, Laws 2/10 class B). Same shape as /transfers/detect.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Categorization detect request failed validation.',
          details: {},
        });
      }
      const { data: created, error: detectError } = await ctx.supabase.rpc(
        'keel_detect_category_suggestions',
        { p_household_id: householdId.data },
      );
      if (detectError) return mapDbError(detectError);
      return json(200, { suggested: created ?? 0 });
    }

    if (path === '/transfers/decide') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const linkId = input['linkId'];
      const confirm = input['confirm'];
      if (
        !householdId.success ||
        typeof linkId !== 'string' ||
        !uuidRe.test(linkId) ||
        typeof confirm !== 'boolean'
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer decide request failed validation.',
          details: {},
        });
      }
      const { error: decideError } = await ctx.supabase.rpc('keel_decide_transfer', {
        p_household_id: householdId.data,
        p_link_id: linkId,
        p_confirm: confirm,
      });
      if (decideError) return mapDbError(decideError);
      return json(200, { ok: true });
    }

    if (path === '/transfers/link') {
      // Manual "these two are a transfer" override for near-misses the
      // deterministic detector's exact-amount/±3-day rule skips (TRANSFER-1
      // in docs/harness/plans/entities-investments-transfers.md). Still
      // lands as a 'suggested' link -- the user confirms it on Review like
      // any other suggestion (Law 2).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const txnA = CanonicalTransactionIdSchema.safeParse(input['txnA']);
      const txnB = CanonicalTransactionIdSchema.safeParse(input['txnB']);
      if (!householdId.success || !txnA.success || !txnB.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer link request failed validation.',
          details: {},
        });
      }
      const { data: linkId, error: linkError } = await ctx.supabase.rpc('keel_link_transfer', {
        p_household_id: householdId.data,
        p_txn_a: txnA.data,
        p_txn_b: txnB.data,
      });
      if (linkError) return mapDbError(linkError);
      return json(200, { linkId });
    }

    if (path === '/transfers/link-confirm') {
      // F-012 MATCH path: the user picked the "Transfers" category and chose a
      // counterparty account whose existing opposite transaction we matched.
      // Link + confirm atomically (no intermediate 'suggested' the user would
      // have to re-approve on Review) — cash-flow exclusion via the existing
      // confirmed-links mechanism (Law 2: the user's counterparty pick IS the
      // approval).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const txnA = CanonicalTransactionIdSchema.safeParse(input['txnA']);
      const txnB = CanonicalTransactionIdSchema.safeParse(input['txnB']);
      if (!householdId.success || !txnA.success || !txnB.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer link-confirm request failed validation.',
          details: {},
        });
      }
      const { data: linkId, error: lcError } = await ctx.supabase.rpc(
        'keel_link_and_confirm_transfer',
        { p_household_id: householdId.data, p_txn_a: txnA.data, p_txn_b: txnB.data },
      );
      if (lcError) return mapDbError(lcError);
      return json(200, { linkId });
    }

    if (path === '/transfers/book') {
      // F-012 BOOK path: no opposite transaction exists on the chosen
      // counterparty account (the common case for a manual/unconnected account
      // — a cash jar, a 401k). Post the balanced opposite cash leg there,
      // create its canonical transaction, and confirm the pairing — all
      // atomically, idempotent on the source transaction id (replay-safe).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const sourceTxnId = CanonicalTransactionIdSchema.safeParse(input['sourceTxnId']);
      const counterpartyAccountId = AccountIdSchema.safeParse(input['counterpartyAccountId']);
      // P1-4: per-attempt idempotency nonce (like the manual-transaction
      // attemptKey). A retry of the SAME click dedupes; a book→undo→re-book is
      // a fresh attempt, no longer wedged by a permanent stale key.
      const attemptKey = input['attemptKey'];
      if (
        !householdId.success ||
        !sourceTxnId.success ||
        !counterpartyAccountId.success ||
        typeof attemptKey !== 'string' ||
        attemptKey.trim().length < 1 ||
        attemptKey.length > 100
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer book request failed validation.',
          details: {},
        });
      }
      const { data: result, error: bookError } = await ctx.supabase.rpc(
        'keel_book_transfer_counterparty',
        {
          p_household_id: householdId.data,
          p_source_txn_id: sourceTxnId.data,
          p_counterparty_account_id: counterpartyAccountId.data,
          p_attempt_key: attemptKey,
        },
      );
      if (bookError) return mapDbError(bookError);
      return json(200, result ?? { ok: true });
    }

    if (path === '/transfers/undo') {
      // F-012 UNDO path (from the txn detail sidebar): reverse a booked
      // transfer (compensating reversal on the synthesized leg — never a
      // DELETE, Law 2) or plain-unlink a match/detector pair. Both branch on
      // transfer_links.booked_txn inside the proc.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const linkId = input['linkId'];
      if (!householdId.success || typeof linkId !== 'string' || !uuidRe.test(linkId)) {
        return json(400, {
          code: 'invalid_command',
          message: 'Transfer undo request failed validation.',
          details: {},
        });
      }
      const { data: result, error: undoError } = await ctx.supabase.rpc('keel_undo_transfer', {
        p_household_id: householdId.data,
        p_link_id: linkId,
      });
      if (undoError) return mapDbError(undoError);
      return json(200, result ?? { ok: true });
    }

    if (path === '/connections/sync') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const connectionId = ConnectionIdSchema.safeParse(input['connectionId']);
      if (!householdId.success || !connectionId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Connection sync request failed validation.',
          details: {},
        });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'connections.link', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { error: reqError } = await ctx.supabase.rpc('keel_request_connection_sync', {
        p_household_id: householdId.data,
        p_connection_id: connectionId.data,
      });
      if (reqError) return mapDbError(reqError);
      // Drive the worker immediately for responsive UX; the 3-minute cron is the
      // background fallback. Best-effort: the queue is drained either way.
      await ctx.supabaseAdmin.rpc('keel_cron_drain_sync', {});
      return json(200, { ok: true });
    }

    if (path === '/connections/rename') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const connectionId = ConnectionIdSchema.safeParse(input['connectionId']);
      const displayName = input['displayName'];
      if (!householdId.success || !connectionId.success || typeof displayName !== 'string') {
        return json(400, {
          code: 'invalid_command',
          message: 'Connection rename request failed validation.',
          details: {},
        });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'connections.link', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { error: renameError } = await ctx.supabase.rpc('keel_rename_connection', {
        p_household_id: householdId.data,
        p_connection_id: connectionId.data,
        p_display_name: displayName,
      });
      if (renameError) return mapDbError(renameError);
      return json(200, { ok: true });
    }

    if (path === '/connections/disconnect') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const connectionId = ConnectionIdSchema.safeParse(input['connectionId']);
      if (!householdId.success || !connectionId.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Connection disconnect request failed validation.',
          details: {},
        });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'connections.disconnect', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const { data: begin, error: beginError } = await ctx.supabase.rpc('keel_disconnect_begin', {
        p_household_id: householdId.data,
        p_connection_id: connectionId.data,
        p_reason: 'user_requested',
      });
      if (beginError) return mapDbError(beginError);

      let removed = false;
      let failure: string | null = null;
      if (begin.hasCredentials) {
        const { data: envelopeData, error: envelopeError } = await ctx.supabaseAdmin.rpc(
          'keel_get_connection_credential_envelope',
          { p_connection_id: connectionId.data },
        );
        if (envelopeError || !envelopeData) {
          failure = 'credential_unavailable';
        } else {
          const envelope = envelopeData as CredentialEnvelope;
          let token: string;
          try {
            token = await decryptToken(
              envelope,
              envelope.credentialId,
              householdId.data,
              'plaid',
              getKek(envelope.kekVersion),
            );
          } catch (error) {
            if (error instanceof Error && error.message === 'credential subsystem unavailable') {
              return credentialFailure();
            }
            failure = 'credential_decrypt_failed';
            token = '';
          }
          if (token) {
            const plaid = createPlaidClient(ctx.supabaseAdmin, {
              env: Deno.env.get('PLAID_ENV') ?? 'sandbox',
              clientId: Deno.env.get('PLAID_CLIENT_ID'),
              secret: Deno.env.get('PLAID_SECRET'),
              householdId: householdId.data,
            });
            try {
              removed = await plaid.itemRemove(connectionId.data, { access_token: token });
            } catch (error) {
              failure =
                error instanceof PlaidClientError
                  ? (error.errorCode ?? 'provider_error')
                  : 'provider_error';
            }
          }
        }
      } else {
        failure = 'no_credentials';
      }

      const { error: completeError } = await ctx.supabaseAdmin.rpc('keel_disconnect_complete', {
        p_household_id: householdId.data,
        p_connection_id: connectionId.data,
        p_removal_attempt_id: begin.removalAttemptId,
        p_removed: removed,
        p_failure: failure,
      });
      if (completeError) return mapDbError(completeError);
      return json(200, { status: removed ? 'disconnected' : 'disconnecting' });
    }

    if (path === '/documents/upload-url') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const entityId = EntityIdSchema.safeParse(input['entityId']);
      const kind = DocumentKindSchema.safeParse(input['kind']);
      const originalFilename =
        typeof input['originalFilename'] === 'string' &&
        input['originalFilename'].length > 0 &&
        input['originalFilename'].length <= 255
          ? input['originalFilename']
          : null;
      const mimeType = typeof input['mimeType'] === 'string' ? input['mimeType'] : null;
      if (
        !householdId.success ||
        !entityId.success ||
        !kind.success ||
        !originalFilename ||
        !mimeType ||
        !documentMimeAllowlistFor(kind.data).has(mimeType)
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Upload request failed validation.',
          details: {},
        });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'documents.confirm_upload', {
        householdId: householdId.data,
        entityId: entityId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const documentId = crypto.randomUUID();
      // Statement uploads land in `quarantine` first; receipts land directly in
      // `receipts` (INFRA.md §10). The signed upload URL targets the QUARANTINE
      // bucket for statements; confirm-upload sniffs the bytes and only then
      // copies them immutably into the canonical `statements` bucket.
      const uploadBucket = quarantineBucketFor(kind.data);
      const canonicalBucket = canonicalBucketFor(kind.data);
      const storagePath = `${householdId.data}/${documentId}/${crypto.randomUUID()}`;
      const { data: signed, error: signError } = await ctx.supabaseAdmin.storage
        .from(uploadBucket)
        .createSignedUploadUrl(storagePath);
      if (signError || !signed) return internalFailure();

      return json(200, {
        documentId,
        // `storageBucket` remains the CANONICAL bucket the caller should echo to
        // confirm-upload (so the existing kind↔bucket contract holds). The
        // upload itself goes to `uploadBucket` (quarantine for statements).
        storageBucket: canonicalBucket,
        uploadBucket,
        canonicalBucket,
        storagePath,
        uploadUrl: signed.signedUrl,
        token: signed.token,
      });
    }

    if (path === '/documents/confirm-upload') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const entityId = EntityIdSchema.safeParse(input['entityId']);
      const documentId = DocumentIdSchema.safeParse(input['documentId']);
      const kind = DocumentKindSchema.safeParse(input['kind']);
      const storageBucket = input['storageBucket'];
      const storagePath = input['storagePath'];
      const originalFilename = input['originalFilename'];
      const targetType = input['targetType'];
      const targetId = input['targetId'];
      // Discriminated attach-vs-ingest [A3]. Absent `mode` == 'attach' for
      // backward compatibility (legacy AttachmentsSection callers). `ingest` is
      // the new statement path: an account is REQUIRED and NO target/attachment
      // is created — it mints a draft instead. An attach can never carry an
      // accountId and an ingest can never carry a target, by construction.
      const mode: 'attach' | 'ingest' = input['mode'] === 'ingest' ? 'ingest' : 'attach';
      const targetTypeParsed =
        targetType === undefined ? undefined : DocumentTargetTypeSchema.safeParse(targetType);
      const accountIdParsed =
        input['accountId'] === undefined ? undefined : AccountIdSchema.safeParse(input['accountId']);
      // Shared shape checks (both modes).
      if (
        !householdId.success ||
        !entityId.success ||
        !documentId.success ||
        !kind.success ||
        (storageBucket !== 'receipts' && storageBucket !== 'statements') ||
        typeof storagePath !== 'string' ||
        storagePath.length === 0 ||
        // Bind confirm to the EXACT prefix /documents/upload-url minted for
        // this caller's own household+document — otherwise a caller could
        // name any other object in the shared bucket (e.g. a leaked or
        // guessed path from another household) and have it attached + later
        // exposed to them via a signed read URL from /documents/list.
        (documentId.success &&
          householdId.success &&
          !storagePath.startsWith(`${householdId.data}/${documentId.data}/`)) ||
        typeof originalFilename !== 'string' ||
        originalFilename.length === 0 ||
        originalFilename.length > 255
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Confirm-upload request failed validation.',
          details: {},
        });
      }
      if (mode === 'ingest') {
        // Ingest [A3]: statements only, an account is REQUIRED, and a
        // target/attachment is FORBIDDEN — an ingest never attaches.
        if (
          kind.data !== 'statement' ||
          storageBucket !== 'statements' ||
          !accountIdParsed?.success ||
          targetType !== undefined ||
          targetId !== undefined
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Statement ingest requires an account and no attachment target.',
            details: {},
          });
        }
      } else {
        // Attach: the target pair is optional (an unattached receipt in the
        // bulk-upload inbox has neither), but if present BOTH must be present and
        // valid. An accountId is FORBIDDEN in attach mode — that would be an
        // ingest smuggled in past the discriminator [A3].
        if (
          input['accountId'] !== undefined ||
          (targetType !== undefined && (!targetTypeParsed?.success || typeof targetId !== 'string')) ||
          (targetType === undefined && targetId !== undefined)
        ) {
          return json(400, {
            code: 'invalid_command',
            message: 'Confirm-upload request failed validation.',
            details: {},
          });
        }
      }
      if ((kind.data === 'receipt' ? 'receipts' : 'statements') !== storageBucket) {
        return json(400, {
          code: 'invalid_command',
          message: 'Document kind does not match its storage bucket.',
          details: {},
        });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'documents.confirm_upload', {
        householdId: householdId.data,
        entityId: entityId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      // Postgres cannot reach Storage — download the object the browser just
      // uploaded and compute its real size/hash here, server-side, before any
      // of it is trusted (Law 5). For a statement the browser uploaded to the
      // `quarantine` bucket; for a receipt it uploaded straight to `receipts`.
      // Download from whichever it actually landed in.
      const uploadBucket = quarantineBucketFor(kind.data);
      const { data: fileData, error: downloadError } = await ctx.supabaseAdmin.storage
        .from(uploadBucket)
        .download(storagePath);
      if (downloadError || !fileData) {
        return json(404, { code: 'not_found', message: 'Uploaded object not found.', details: {} });
      }
      if (fileData.size <= 0 || fileData.size > DOCUMENT_MAX_BYTES) {
        return json(422, {
          code: 'invalid_command',
          message: 'File is empty or exceeds the 10MB limit.',
          details: {},
        });
      }
      const declaredMime = fileData.type || 'application/octet-stream';
      const bytes = new Uint8Array(await fileData.arrayBuffer());
      const contentSha256 = await sha256Hex(bytes);

      // Content sniff + promote (Law 5, Law 9). We trust the BYTES, never the
      // extension or client MIME. A statement that does not positively sniff to
      // pdf/ofx/csv (or a matching image) stays in quarantine and is rejected;
      // it is never copied to the canonical `statements` bucket and never
      // served inline.
      let mimeType = declaredMime;
      if (kind.data === 'statement') {
        const promotion = decideStatementPromotion(bytes, declaredMime);
        if (!promotion.promote) {
          // Hostile / unrecognized: leave the original inert in quarantine.
          return json(422, {
            code: 'invalid_command',
            message: 'Statement file failed content validation.',
            details: { reason: promotion.reason },
          });
        }
        // Promote the EXACT bytes to the canonical bucket, immutably. The
        // sniffed kind normalizes the stored MIME so downstream (Slice 5
        // worker routing) reads a trustworthy type, not the client's claim.
        mimeType =
          promotion.sniffedKind === 'pdf'
            ? 'application/pdf'
            : promotion.sniffedKind === 'ofx'
              ? 'application/x-ofx'
              : promotion.sniffedKind === 'csv'
                ? 'text/csv'
                : declaredMime;
        const { error: promoteError } = await ctx.supabaseAdmin.storage
          .from('statements')
          .upload(storagePath, bytes, {
            contentType: mimeType,
            // Immutable original (Law 9): a statement object is written once.
            // upsert:false makes a re-confirm of the same path a Storage
            // conflict rather than an overwrite; the RPC below is idempotent on
            // (household, document_id) so a legitimate retry still succeeds
            // even when the object already exists (handled below).
            upsert: false,
          });
        if (promoteError) {
          // Duplicate object (idempotent retry) is fine — the canonical bytes
          // are already there. Any other Storage error is a real failure.
          const alreadyExists =
            typeof (promoteError as { message?: string }).message === 'string' &&
            /exist|duplicate|conflict|resource already/i.test(
              (promoteError as { message?: string }).message ?? '',
            );
          if (!alreadyExists) return internalFailure();
        }
      } else if (!RECEIPT_MIME_ALLOWLIST.has(mimeType)) {
        return json(422, {
          code: 'invalid_command',
          message: `Unsupported file type: ${mimeType}`,
          details: {},
        });
      }

      if (mode === 'ingest') {
        // Statement ingest [A3/A4/A12]. keel_statement_ingest_begin does the
        // draft + transactional-outbox insert ATOMICALLY (a committed draft
        // always has a committed delivery record) and dedupes on tenant content
        // hash — a re-upload of the same bytes returns duplicate:true with the
        // prior draft BEFORE minting a new one. source_hash is server-bound from
        // the content_sha256 computed above, never client input (Law 5).
        const { data, error } = await ctx.supabaseAdmin.rpc('keel_statement_ingest_begin', {
          p_household_id: householdId.data,
          p_entity_id: entityId.data,
          p_document_id: documentId.data,
          p_account_id: accountIdParsed!.data,
          p_storage_bucket: canonicalBucketFor(kind.data),
          p_storage_path: storagePath,
          p_content_sha256: contentSha256,
          p_mime_type: mimeType,
          p_byte_size: bytes.byteLength,
          p_original_filename: originalFilename,
          p_created_by: userId,
        });
        if (error) return mapDbError(error);

        const ingest = data as {
          duplicate?: boolean;
          documentVersionId?: string;
          draftId?: string | null;
        };
        // Enqueue the extract job only for a FRESH draft (a duplicate already has
        // one in flight or done; a re-enqueue would be redundant, though the
        // worker is idempotent per version anyway). Best-effort: a queue/drain
        // failure cannot undo the already-durable draft+outbox — the outbox
        // sweeper (Slice 5) re-drives any dropped enqueue [A12].
        const documentVersionId = ingest?.documentVersionId;
        if (!ingest?.duplicate && typeof documentVersionId === 'string') {
          const { error: enqueueError } = await ctx.supabaseAdmin.rpc('keel_enqueue', {
            queue_name: 'sync_events',
            message: {
              jobType: 'statement_extract',
              economicEventKey: `statement:extract:${documentVersionId}`,
              refs: { documentVersionId, householdId: householdId.data },
            },
          });
          if (!enqueueError) {
            await ctx.supabaseAdmin.rpc('keel_cron_drain_sync', {});
          }
        }
        return json(200, data);
      }

      const { data, error } = await ctx.supabaseAdmin.rpc('keel_documents_confirm_upload', {
        p_household_id: householdId.data,
        p_entity_id: entityId.data,
        p_document_id: documentId.data,
        p_kind: kind.data,
        // Record the CANONICAL bucket (statements/receipts) — never quarantine.
        p_storage_bucket: canonicalBucketFor(kind.data),
        p_storage_path: storagePath,
        p_content_sha256: contentSha256,
        p_mime_type: mimeType,
        p_byte_size: bytes.byteLength,
        p_original_filename: originalFilename,
        p_created_by: userId,
        p_target_type: targetTypeParsed?.data ?? null,
        p_target_id: targetType !== undefined ? targetId : null,
      });
      if (error) return mapDbError(error);

      // WS-J / F-030: for a receipt, enqueue background extraction + matching
      // (AI class B). Best-effort: a queue/drain failure must not undo the
      // already-durable upload+attach. The worker is idempotent per version.
      const confirmEffects = (data as { effects?: { documentVersionId?: string } })?.effects;
      const documentVersionId = confirmEffects?.documentVersionId;
      if (kind.data === 'receipt' && typeof documentVersionId === 'string') {
        const { error: enqueueError } = await ctx.supabaseAdmin.rpc('keel_enqueue', {
          queue_name: 'sync_events',
          message: {
            jobType: 'receipt_extract',
            economicEventKey: `receipt:extract:${documentVersionId}`,
            refs: { documentVersionId, householdId: householdId.data },
          },
        });
        if (!enqueueError) {
          // Kick the drain so extraction runs promptly (the 3-min cron is the
          // fallback). Best-effort.
          await ctx.supabaseAdmin.rpc('keel_cron_drain_sync', {});
        }
      }
      return json(200, data);
    }

    if (path === '/documents/list') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const targetType = DocumentTargetTypeSchema.safeParse(input['targetType']);
      const targetId = input['targetId'];
      if (!householdId.success || !targetType.success || typeof targetId !== 'string') {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }

      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'documents.list_for_target', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const { data, error } = await ctx.supabase.rpc('keel_documents_list_for_target', {
        p_household_id: householdId.data,
        p_target_type: targetType.data,
        p_target_id: targetId,
      });
      if (error) return mapDbError(error);
      const rows = (data as { rows: Record<string, unknown>[] })?.rows ?? [];
      const withUrls = await Promise.all(
        rows.map(async (row) => {
          const bucket = row['storageBucket'];
          const objectPath = row['storagePath'];
          if (typeof bucket !== 'string' || typeof objectPath !== 'string') {
            return { ...row, url: null };
          }
          const { data: signed } = await ctx.supabaseAdmin.storage
            .from(bucket)
            .createSignedUrl(
              objectPath,
              DOCUMENT_SIGNED_URL_TTL_S,
              forceAttachmentBucket(bucket) ? { download: true } : undefined,
            );
          return { ...row, url: signed?.signedUrl ?? null };
        }),
      );
      return json(200, { rows: withUrls });
    }

    // WS-J / F-030: receipts inbox — the receipts hub. Same shape as
    // /documents/list (proc returns storage pointers; this route mints the
    // per-row short-lived signed read URL Postgres cannot sign).
    if (path === '/receipts/inbox') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'receipts.inbox', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { data, error } = await ctx.supabase.rpc('keel_receipts_inbox', {
        p_household_id: householdId.data,
      });
      if (error) return mapDbError(error);
      const rows = (data as { rows: Record<string, unknown>[] })?.rows ?? [];
      const withUrls = await Promise.all(
        rows.map(async (row) => {
          const bucket = row['storageBucket'];
          const objectPath = row['storagePath'];
          if (typeof bucket !== 'string' || typeof objectPath !== 'string') {
            return { ...row, url: null };
          }
          const { data: signed } = await ctx.supabaseAdmin.storage
            .from(bucket)
            .createSignedUrl(
              objectPath,
              DOCUMENT_SIGNED_URL_TTL_S,
              forceAttachmentBucket(bucket) ? { download: true } : undefined,
            );
          return { ...row, url: signed?.signedUrl ?? null };
        }),
      );
      return json(200, { rows: withUrls });
    }

    // Statement ingestion Slice 6 — drafts inbox. Mirrors /receipts/inbox: the
    // proc (keel_list_statement_drafts) is ACCOUNT-scope filtered [A10] and
    // returns storage pointers; this route mints the per-row short-lived signed
    // read URL Postgres cannot sign. Served as Content-Disposition: attachment
    // (never inline) so a hostile statement original can never execute in the
    // browser (Law 5).
    if (path === '/statements/drafts') {
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      if (!householdId.success) {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'statements.drafts', {
        kind: 'household',
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { data, error } = await ctx.supabase.rpc('keel_list_statement_drafts', {
        p_household_id: householdId.data,
      });
      if (error) return mapDbError(error);
      const rows = (data as { rows: Record<string, unknown>[] })?.rows ?? [];
      const withUrls = await Promise.all(
        rows.map(async (row) => {
          const bucket = row['storageBucket'];
          const objectPath = row['storagePath'];
          // Statement originals live only in the canonical `statements` bucket;
          // sign a 5-min read URL, forced to download (never inline) [A9].
          if (bucket !== 'statements' || typeof objectPath !== 'string') {
            return { ...row, url: null };
          }
          const { data: signed } = await ctx.supabaseAdmin.storage
            .from('statements')
            .createSignedUrl(objectPath, DOCUMENT_SIGNED_URL_TTL_S, { download: true });
          return { ...row, url: signed?.signedUrl ?? null };
        }),
      );
      return json(200, { ...(data as Record<string, unknown>), rows: withUrls });
    }

    if (path === '/statements/draft-detail') {
      // SLICE 7: the extraction header + lines + holdings for ONE draft, so the
      // review dialog prefills every editable field. Account-scoped inside the
      // proc; authz floor is the viewer statements.drafts action.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const draftId = StatementDraftIdSchema.safeParse(input['draftId']);
      if (!householdId.success || !draftId.success) {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'statements.drafts', {
        kind: 'household',
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { data, error } = await ctx.supabase.rpc('keel_statement_draft_detail', {
        p_household_id: householdId.data,
        p_draft_id: draftId.data,
      });
      if (error) return mapDbError(error);
      return json(200, data);
    }

    if (path === '/statements/issue-draft-approval') {
      // SLICE 7: mint an approval token bound to the EXACT server-normalized
      // statement body the approve command will redeem (Law 11 gate). The
      // client sends the SAME `statement` object it will send to
      // statements.approve_draft; the server reconstructs v_payload identically
      // (draft account + server source_hash + balanceCheck forced) inside
      // keel_cmd_statements_issue_draft_approval and hashes it. authz gates at
      // partner (same class-B floor as statements.approve_draft).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const draftId = StatementDraftIdSchema.safeParse(input['draftId']);
      const balanceCheckRaw = input['balanceCheck'];
      const balanceCheck =
        balanceCheckRaw === 'strict' || balanceCheckRaw === 'anchor' ? balanceCheckRaw : null;
      const statement = input['statement'];
      if (
        !householdId.success ||
        !draftId.success ||
        balanceCheck === null ||
        statement === null ||
        typeof statement !== 'object' ||
        Array.isArray(statement)
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Issue-draft-approval request failed validation.',
          details: {},
        });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'statements.approve_draft', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      // Snake-case the statement body EXACTLY as /commands does before the proc
      // sees it, so the normalized payload the token binds matches the one the
      // approve command (also snake-cased by toSnakeKeys) rebuilds byte-for-byte.
      const { data, error } = await ctx.supabase.rpc(
        'keel_cmd_statements_issue_draft_approval',
        {
          p_household_id: householdId.data,
          p_draft_id: draftId.data,
          p_balance_check: balanceCheck,
          p_statement: toSnakeKeys(statement),
        },
      );
      if (error) return mapDbError(error);
      return json(200, data);
    }

    if (path === '/statements/issue-holdings-approval') {
      // SLICE 9 [A8]: mint an approval token bound to the EXACT server-derived
      // positions payload the apply command will redeem (Law 11 gate). The client
      // supplies ONLY the statementId — positions come from the extraction, so the
      // issue side and apply side hash a byte-identical server payload by
      // construction. authz gates at partner (same class-B floor as apply_holdings).
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const statementIdRaw = input['statementId'];
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !householdId.success ||
        typeof statementIdRaw !== 'string' ||
        !uuidRe.test(statementIdRaw)
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Issue-holdings-approval request failed validation.',
          details: {},
        });
      }
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      const decision = authorize(authzCtx, 'statements.apply_holdings', {
        householdId: householdId.data,
      });
      if (!decision.allowed) {
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }
      const { data, error } = await ctx.supabase.rpc(
        'keel_cmd_statements_issue_holdings_approval',
        {
          p_household_id: householdId.data,
          p_statement_id: statementIdRaw,
        },
      );
      if (error) return mapDbError(error);
      return json(200, data);
    }

    if (path === '/commands') {
      const envelope = CommandEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        return json(400, {
          code: 'invalid_command',
          message: 'Envelope failed validation.',
          details: { issues: envelope.error.issues },
        });
      }
      let payload: Record<string, unknown>;
      try {
        payload = parseCommandPayload(envelope.data.command, envelope.data.payload) as Record<
          string,
          unknown
        >;
      } catch {
        return json(400, {
          code: 'invalid_command',
          message: 'Payload failed validation.',
          details: {},
        });
      }

      // Fail-closed TS authorization before the database re-checks (Law 9).
      const authzCtx = await loadAuthzContext(ctx.supabase, userId);
      let recurringSeries: ListedRecurringSeries | undefined;
      // recurring.* commands that name a series (confirm/pause/…/link_schedule)
      // gate on that series' account. recurring.unlink_schedule names only a
      // linkId — it falls through to the household partner check here and the
      // DB proc re-checks account access on the series behind the link.
      if (
        envelope.data.command.startsWith('recurring.') &&
        typeof payload['seriesId'] === 'string'
      ) {
        const { data: recurringList, error: recurringListError } = await ctx.supabase.rpc(
          'keel_list_recurring',
          { p_household_id: envelope.data.householdId },
        );
        if (recurringListError) return mapDbError(recurringListError);
        recurringSeries = (recurringList?.rows ?? []).find(
          (row: { seriesId?: string }) => row.seriesId === payload['seriesId'],
        ) as ListedRecurringSeries | undefined;
        if (!recurringSeries) {
          return json(404, { code: 'not_found', message: 'Not found.', details: {} });
        }
      }
      const resource = {
        householdId: envelope.data.householdId,
        ...(recurringSeries
          ? { kind: 'recurring_series' as const, accountId: recurringSeries.accountId as never }
          : {}),
        ...(typeof payload['entityId'] === 'string' &&
        EntityIdSchema.safeParse(payload['entityId']).success
          ? { entityId: payload['entityId'] as never }
          : {}),
        ...(typeof payload['accountId'] === 'string' &&
        AccountIdSchema.safeParse(payload['accountId']).success
          ? { accountId: payload['accountId'] as never }
          : {}),
      };
      const decision = authorize(authzCtx, envelope.data.command as Action, resource);
      if (!decision.allowed) {
        // Scope violations answer 404 — never confirm existence cross-tenant.
        return decision.code === 'household_scope_violation'
          ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
          : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
      }

      const { data, error } = await ctx.supabase.rpc(COMMAND_TO_PROC[envelope.data.command]!, {
        p_command_id: envelope.data.commandId,
        p_economic_event_key: envelope.data.economicEventKey,
        p_actor: envelope.data.actor,
        p_household_id: envelope.data.householdId,
        p_payload: toSnakeKeys(payload),
      });
      if (error) return mapDbError(error);
      return json(200, data);
    }

    if (path === '/queries') {
      const edgeStartedAt = performance.now();
      const query = body as { query?: string; householdId?: string };
      const proc = query.query ? QUERY_TO_PROC[query.query] : undefined;
      if (!proc || typeof query.householdId !== 'string') {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }
      if (
        query.query === 'recurring.list' ||
        query.query === 'recurring.classification' ||
        query.query === 'recurring.schedule_links' ||
        query.query === 'paychecks.list' ||
        query.query === 'paychecks.detected_dismissals' ||
        query.query === 'paychecks.templates' ||
        query.query === 'paychecks.split_suggestions' ||
        query.query === 'reimbursements.list' ||
        query.query === 'statements.list' ||
        query.query === 'statements.drafts' ||
        query.query === 'statements.cadence' ||
        query.query === 'statements.find_payment' ||
        query.query === 'statements.payment_links' ||
        query.query === 'statements.holdings_diff'
      ) {
        const parsedHousehold = HouseholdIdSchema.safeParse(query.householdId);
        if (!parsedHousehold.success) {
          return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
        }
        const authzCtx = await loadAuthzContext(ctx.supabase, userId);
        const decision = authorize(authzCtx, query.query as Action, {
          kind: 'household',
          householdId: parsedHousehold.data,
        });
        if (!decision.allowed) {
          return decision.code === 'household_scope_violation'
            ? json(404, { code: 'not_found', message: 'Not found.', details: {} })
            : json(403, { code: 'not_authorized', message: decision.reason, details: {} });
        }
      }
      const rpcArgs: Record<string, unknown> = { p_household_id: query.householdId };
      const isoDate = (v: unknown): string | null =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      const todayIso = new Date().toISOString().slice(0, 10);
      if (query.query === 'dashboard.cash_flow') {
        const db = body as { from?: unknown; to?: unknown };
        const past = new Date();
        past.setUTCDate(past.getUTCDate() - 30);
        rpcArgs.p_from = isoDate(db.from) ?? past.toISOString().slice(0, 10);
        rpcArgs.p_to = isoDate(db.to) ?? todayIso;
      } else if (query.query === 'dashboard.net_worth_daily') {
        const db = body as { from?: unknown; to?: unknown };
        const past = new Date();
        past.setUTCDate(past.getUTCDate() - 90);
        rpcArgs.p_from = isoDate(db.from) ?? past.toISOString().slice(0, 10);
        rpcArgs.p_to = isoDate(db.to) ?? todayIso;
      } else if (query.query === 'dashboard.cash_flow_monthly') {
        const db = body as { from?: unknown; to?: unknown };
        const past = new Date();
        past.setUTCMonth(past.getUTCMonth() - 11);
        past.setUTCDate(1);
        rpcArgs.p_from = isoDate(db.from) ?? past.toISOString().slice(0, 10);
        rpcArgs.p_to = isoDate(db.to) ?? todayIso;
      } else if (query.query === 'accounts.balance_daily') {
        const db = body as { accountId?: unknown; from?: unknown; to?: unknown };
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof db.accountId !== 'string' || !uuidRe.test(db.accountId)) {
          return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
        }
        const past = new Date();
        past.setUTCDate(past.getUTCDate() - 90);
        rpcArgs.p_account_id = db.accountId;
        rpcArgs.p_from = isoDate(db.from) ?? past.toISOString().slice(0, 10);
        rpcArgs.p_to = isoDate(db.to) ?? todayIso;
      } else if (query.query === 'dashboard.cash_flow_forecast') {
        const db = body as { days?: unknown };
        const days = typeof db.days === 'number' ? Math.trunc(db.days) : 30;
        rpcArgs.p_days = Math.min(Math.max(days, 1), 120);
      } else if (query.query === 'budgets.list' || query.query === 'budgets.month') {
        const db = body as { month?: unknown };
        if (db.month !== undefined && isoDate(db.month) === null) {
          return json(400, { code: 'invalid_command', message: 'Invalid month.', details: {} });
        }
        rpcArgs.p_month = isoDate(db.month) ?? `${todayIso.slice(0, 7)}-01`;
      } else if (query.query === 'dashboard.net_worth') {
        const db = body as { asOf?: unknown };
        rpcArgs.p_as_of = isoDate(db.asOf) ?? todayIso;
      } else if (query.query === 'holdings.list') {
        const db = body as { accountId?: unknown };
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (db.accountId !== undefined) {
          if (typeof db.accountId !== 'string' || !uuidRe.test(db.accountId)) {
            return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
          }
          rpcArgs.p_account_id = db.accountId;
        }
      } else if (query.query === 'investments.value_daily') {
        const db = body as { from?: unknown; to?: unknown };
        const past = new Date();
        past.setUTCDate(past.getUTCDate() - 365);
        rpcArgs.p_from = isoDate(db.from) ?? past.toISOString().slice(0, 10);
        rpcArgs.p_to = isoDate(db.to) ?? todayIso;
      } else if (query.query === 'transactions.rich_page') {
        // WS-H (F-005): keyset page params. Everything is optional; each is
        // validated to its shape (bad input degrades to "no filter", never an
        // error, so a stale/garbage cursor can't wedge the ledger). The proc
        // itself clamps p_limit to [1,200] and re-checks membership.
        const db = body as {
          limit?: unknown;
          cursorDate?: unknown;
          cursorId?: unknown;
          accountId?: unknown;
          categoryId?: unknown;
          search?: unknown;
        };
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof db.limit === 'number' && Number.isFinite(db.limit)) {
          rpcArgs.p_limit = Math.trunc(db.limit);
        }
        // Cursor is only honoured as a MATCHED pair (date + id); a half-cursor
        // is ignored so the first page is served rather than a malformed keyset.
        if (isoDate(db.cursorDate) && typeof db.cursorId === 'string' && uuidRe.test(db.cursorId)) {
          rpcArgs.p_cursor_date = db.cursorDate;
          rpcArgs.p_cursor_id = db.cursorId;
        }
        if (typeof db.accountId === 'string' && uuidRe.test(db.accountId)) {
          rpcArgs.p_account_id = db.accountId;
        }
        if (typeof db.categoryId === 'string' && uuidRe.test(db.categoryId)) {
          rpcArgs.p_category_id = db.categoryId;
        }
        if (typeof db.search === 'string' && db.search.length <= 200) {
          rpcArgs.p_search = db.search;
        }
      } else if (
        query.query === 'statements.find_payment' ||
        query.query === 'statements.payment_links' ||
        query.query === 'statements.holdings_diff'
      ) {
        // SLICE 8 [A7]: find_payment runs the deterministic exact-only card-
        // payment matcher for one statement ("Find payment" button);
        // payment_links reads the active/decided links. Both are statement-
        // scoped — statementId required.
        const db = body as { statementId?: unknown };
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof db.statementId !== 'string' || !uuidRe.test(db.statementId)) {
          return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
        }
        rpcArgs.p_statement_id = db.statementId;
      } else if (query.query === 'transactions.search') {
        // WS-H (F-021): command-palette typeahead. Requires a search term; the
        // proc returns an empty page for a blank/absent one.
        const db = body as { search?: unknown; limit?: unknown };
        rpcArgs.p_search =
          typeof db.search === 'string' && db.search.length <= 200 ? db.search : '';
        if (typeof db.limit === 'number' && Number.isFinite(db.limit)) {
          rpcArgs.p_limit = Math.trunc(db.limit);
        }
      }
      const rpcStartedAt = performance.now();
      const { data, error } = await ctx.supabase.rpc(proc, rpcArgs);
      const rpcMs = Math.trunc(performance.now() - rpcStartedAt);
      if (error) return mapDbError(error);
      const edgeMs = Math.trunc(performance.now() - edgeStartedAt);
      const responseBody =
        data !== null && typeof data === 'object' && !Array.isArray(data)
          ? {
              ...(data as Record<string, unknown>),
              diagnostics: { query: query.query, rpcMs, edgeMs },
            }
          : data;
      return json(200, responseBody);
    }

    return json(404, { code: 'not_found', message: 'Not found.', details: {} });
  }),
};
