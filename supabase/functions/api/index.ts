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
  buildChatMessages,
  buildChatResponseRecord,
  CommandIdSchema,
  EmptyAiResponseError,
  OpenAiCompatibleChatProvider,
  CommandEnvelopeSchema,
  ConnectionIdSchema,
  EntityIdSchema,
  EntityKindSchema,
  HouseholdIdSchema,
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
  type FinancialContextSnapshot,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError, toSnakeKeys } from '../_shared/http.ts';
import { decryptToken, encryptToken, type EncryptedRecord } from '../_shared/credential-crypto.ts';
import { currentKekVersion, getKek } from '../_shared/credential-kek.ts';
import {
  createPlaidClient,
  PlaidClientError,
  ProviderBudgetExhaustedError,
} from '../_shared/plaid-client.ts';

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
  'paychecks.create': 'keel_paycheck_create',
  'paychecks.reverse': 'keel_paycheck_reverse',
  'paychecks.restore': 'keel_paycheck_restore',
  'reimbursements.create_claim': 'keel_reimbursement_create_claim',
  'reimbursements.settle': 'keel_reimbursement_settle',
  'reimbursements.reverse_settlement': 'keel_reimbursement_reverse_settlement',
  'reimbursements.reverse_claim': 'keel_reimbursement_reverse_claim',
  'statements.create': 'keel_statement_create',
  'reconciliations.close': 'keel_reconciliation_close',
  'reconciliations.reopen': 'keel_reconciliation_reopen',
  'transactions.manual_create': 'keel_cmd_manual_transaction',
  'transactions.manual_void': 'keel_cmd_manual_void',
  'transactions.set_splits': 'keel_cmd_set_splits',
  'accounts.set_opening_balance': 'keel_cmd_set_opening_balance',
  'accounts.reanchor_balance': 'keel_cmd_reanchor_balance',
  'categorization.decide_suggestion': 'keel_cmd_decide_category_suggestion',
};

const QUERY_TO_PROC: Record<string, string> = {
  'ledger.trial_balance': 'keel_trial_balance',
  'transactions.list': 'keel_list_transactions',
  'transactions.rich': 'keel_list_transactions_rich',
  'categories.list': 'keel_list_categories',
  'balances.latest': 'keel_latest_balances',
  'recurring.list': 'keel_list_recurring',
  'paychecks.list': 'keel_list_paychecks',
  'reimbursements.list': 'keel_list_reimbursements',
  'statements.list': 'keel_list_statements',
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
  'tags.list': 'keel_list_tags',
  'schedules.list': 'keel_list_schedules',
  'goals.list': 'keel_list_goals',
  'entities.list': 'keel_list_entities',
  'dashboard.cash_flow_forecast': 'keel_cash_flow_forecast',
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
    message: 'Provider request failed.',
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
      // Read-only AI chat POC (docs/research/AI-CHAT-2026-07-16.md §6, Laws
      // 1/5/10/11/12). Class C preview-only: the model narrates a bounded,
      // server-computed snapshot; NOTHING on this path can write. The typed
      // record it returns is display-only.
      const input = body as Record<string, unknown>;
      const householdId = HouseholdIdSchema.safeParse(input['householdId']);
      const question = input['question'];
      if (
        !householdId.success ||
        typeof question !== 'string' ||
        question.trim().length === 0 ||
        question.length > 500
      ) {
        return json(400, {
          code: 'invalid_command',
          message: 'Chat request failed validation.',
          details: {},
        });
      }

      // Law 12: the provider key lives ONLY in provider secret stores — the
      // function environment first, Supabase Vault second (via the
      // service_role-only definer keel_ai_provider_key; this pipeline cannot
      // script the dashboard env store). Absent everywhere = feature off,
      // clean typed 503 — never a stubbed answer. The value is never logged
      // and never leaves this scope.
      let aiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
      if (aiApiKey.length === 0) {
        const { data: vaultKey } = await ctx.supabaseAdmin.rpc('keel_ai_provider_key');
        aiApiKey = typeof vaultKey === 'string' ? vaultKey : '';
      }
      if (aiApiKey.length === 0) {
        return json(503, {
          code: 'ai_unavailable',
          message: 'AI assistant is not configured.',
          details: {},
        });
      }

      // Same fail-closed compiler as every other surface (Laws 7/9). Chat
      // reads transactions + ledger balances, so BOTH viewer-tier read
      // actions must pass before any data is fetched.
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

      // Context snapshot from EXISTING read procs only (Law 1: numbers are
      // precomputed by the deterministic spine; no new SQL in this POC). All
      // procs re-check membership via auth.uid(), same as the UI's queries.
      const nowIso = new Date().toISOString();
      const monthIso = `${nowIso.slice(0, 7)}-01`;
      const [entitiesRes, trialRes, txRes, catRes, budgetRes, accountsRes] = await Promise.all([
        ctx.supabase.rpc('keel_list_entities', { p_household_id: householdId.data }),
        ctx.supabase.rpc('keel_trial_balance', { p_household_id: householdId.data }),
        ctx.supabase.rpc('keel_list_transactions_rich', { p_household_id: householdId.data }),
        ctx.supabase.rpc('keel_list_categories', { p_household_id: householdId.data }),
        ctx.supabase.rpc('keel_list_budgets', {
          p_household_id: householdId.data,
          p_month: monthIso,
        }),
        ctx.supabase
          .from('accounts')
          .select('id, name, subtype, currency, ledger_account_id')
          .eq('household_id', householdId.data)
          .is('archived_at', null)
          .order('name'),
      ]);
      for (const res of [entitiesRes, trialRes, txRes, catRes, budgetRes, accountsRes]) {
        if (res.error) return mapDbError(res.error);
      }

      const entities = (entitiesRes.data ?? []) as { entityId: string }[];
      const balances = new Map(
        (
          ((trialRes.data as { rows?: unknown[] } | null)?.rows ?? []) as {
            ledgerAccountId: string;
            currency: string;
            balanceMinor: string;
          }[]
        ).map((row) => [row.ledgerAccountId, row.balanceMinor]),
      );
      const accountRows = (accountsRes.data ?? []) as {
        id: string;
        name: string;
        subtype: string;
        currency: string;
        ledger_account_id: string;
      }[];
      const txRows = (
        ((txRes.data as { rows?: unknown[] } | null)?.rows ?? []) as {
          transactionId: string;
          effectiveDate: string;
          description: string;
          amountMinor: string;
          currency: string;
          accountName: string;
          categoryName: string | null;
          status: string;
        }[]
      ).slice(0, 50); // rows arrive newest-first; keep the snapshot bounded
      const categoryRows = (
        (catRes.data ?? []) as { name: string; kind: 'income' | 'expense' }[]
      ).slice(0, 100);
      const budgetRows = (
        ((budgetRes.data as { rows?: unknown[] } | null)?.rows ?? []) as {
          categoryName: string;
          currency: string;
          budgetMinor: string | null;
          spentMinor: string;
        }[]
      ).slice(0, 100);

      const snapshot: FinancialContextSnapshot = {
        asOf: nowIso,
        scope: {
          householdId: householdId.data,
          entityIds: entities.map((e) => e.entityId),
        },
        budgetsMonth: monthIso,
        accounts: accountRows.map((a) => ({
          accountId: a.id,
          name: a.name,
          subtype: a.subtype,
          currency: a.currency,
          balanceMinor: balances.get(a.ledger_account_id) ?? '0',
        })),
        transactions: txRows.map((t) => ({
          transactionId: t.transactionId,
          effectiveDate: t.effectiveDate,
          description: t.description, // data-tier; prompt builder wraps it (Law 5)
          amountMinor: t.amountMinor,
          currency: t.currency,
          accountName: t.accountName,
          categoryName: t.categoryName,
          status: t.status,
        })),
        categories: categoryRows.map((c) => ({ name: c.name, kind: c.kind })),
        budgets: budgetRows.map((b) => ({
          categoryName: b.categoryName,
          currency: b.currency,
          budgetMinor: b.budgetMinor,
          spentMinor: b.spentMinor,
        })),
      };

      const provider = new OpenAiCompatibleChatProvider({
        baseUrl: Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
        model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini',
        apiKey: aiApiKey,
      });
      // Per-request random boundary so ingested memos can't pre-embed the
      // data delimiter (Law 5, spotlighting).
      const dataBoundary = `kd-${crypto.randomUUID()}`;
      const startedAt = Date.now();
      try {
        const completion = await provider.complete(
          buildChatMessages(snapshot, question.trim(), { dataBoundary }),
          { maxTokens: 700 },
        );
        // Usage telemetry: counts and model only — never the question, the
        // snapshot, or any credential (Law 12). The keel_meter_provider_call
        // proc is plaid-only and this POC adds no migrations, so usage_events
        // metering is deferred to the full slice (deviation noted in report).
        console.log(
          'ai_chat_completion',
          JSON.stringify({
            model: completion.modelVersion,
            latencyMs: Date.now() - startedAt,
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
          }),
        );
        const record = buildChatResponseRecord({
          text: completion.text,
          snapshot,
          modelVersion: completion.modelVersion,
        });
        return json(200, record);
      } catch (error) {
        if (error instanceof AiProviderError || error instanceof EmptyAiResponseError) {
          // Status code only — provider error bodies never reach logs or wire.
          console.error(
            'ai_chat_provider_failed',
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
          products: splitEnv('PLAID_PRODUCTS', 'transactions'),
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
            (typeof autoEnterDays !== 'number' || !Number.isInteger(autoEnterDays)))
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
      if (envelope.data.command.startsWith('recurring.')) {
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
        query.query === 'paychecks.list' ||
        query.query === 'reimbursements.list' ||
        query.query === 'statements.list'
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
      } else if (query.query === 'budgets.list') {
        const db = body as { month?: unknown };
        if (db.month !== undefined && isoDate(db.month) === null) {
          return json(400, { code: 'invalid_command', message: 'Invalid month.', details: {} });
        }
        rpcArgs.p_month = isoDate(db.month) ?? `${todayIso.slice(0, 7)}-01`;
      } else if (query.query === 'dashboard.net_worth') {
        const db = body as { asOf?: unknown };
        rpcArgs.p_as_of = isoDate(db.asOf) ?? todayIso;
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
