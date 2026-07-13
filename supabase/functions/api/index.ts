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
  CommandIdSchema,
  CommandEnvelopeSchema,
  ConnectionIdSchema,
  EntityIdSchema,
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
  'reimbursements.create_claim':'keel_reimbursement_create_claim',
  'reimbursements.settle':'keel_reimbursement_settle',
  'reimbursements.reverse_settlement':'keel_reimbursement_reverse_settlement',
  'reimbursements.reverse_claim':'keel_reimbursement_reverse_claim',
  'statements.create':'keel_statement_create','reconciliations.close':'keel_reconciliation_close','reconciliations.reopen':'keel_reconciliation_reopen',
};

const QUERY_TO_PROC: Record<string, string> = {
  'ledger.trial_balance': 'keel_trial_balance',
  'transactions.list': 'keel_list_transactions',
  'transactions.rich': 'keel_list_transactions_rich',
  'categories.list': 'keel_list_categories',
  'balances.latest': 'keel_latest_balances',
  'recurring.list': 'keel_list_recurring',
  'paychecks.list': 'keel_list_paychecks',
  'reimbursements.list':'keel_list_reimbursements',
  'statements.list':'keel_list_statements',
  'dashboard.cash_flow': 'keel_cash_flow',
  'dashboard.net_worth': 'keel_net_worth_as_of',
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

const loadAuthzContext = async (
  supabase: UserClient,
  userId: string,
): Promise<AuthzContext> => {
  const [memberships, entityMemberships, accountOwnerships, accountPermissions] = await Promise.all([
    supabase.from('household_memberships').select('household_id, role').eq('user_id', userId),
    supabase.from('entity_memberships').select('entity_id, entities(household_id)'),
    supabase.from('account_owners').select('account_id, accounts(household_id)'),
    supabase.from('resource_permissions')
      .select('household_id, resource_id, permission')
      .eq('user_id', userId)
      .eq('resource_kind', 'account'),
  ]);
  return {
    userId: userId as AuthzContext['userId'],
    memberships: (memberships.data ?? []).map(
      (row: { household_id: string; role: string }) => ({
        householdId: row.household_id as HouseholdId,
        role: row.role as HouseholdRole,
      }),
    ),
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
        const result = await plaid.linkTokenCreate(`linktoken:${householdId.data}:${userId}`, {
          user: { client_user_id: userId },
          client_name: 'KEEL',
          products: splitEnv('PLAID_PRODUCTS', 'transactions'),
          country_codes: splitEnv('PLAID_COUNTRY_CODES', 'US'),
          language: 'en',
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
          : error instanceof PlaidClientError ? providerFailure(error) : internalFailure();
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
          : error instanceof PlaidClientError ? providerFailure(error) : internalFailure();
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
      if (
        !householdId.success ||
        !connectionId.success ||
        typeof displayName !== 'string'
      ) {
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

      const { data: begin, error: beginError } = await ctx.supabase.rpc(
        'keel_disconnect_begin',
        {
          p_household_id: householdId.data,
          p_connection_id: connectionId.data,
          p_reason: 'user_requested',
        },
      );
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
              failure = error instanceof PlaidClientError
                ? (error.errorCode ?? 'provider_error')
                : 'provider_error';
            }
          }
        }
      } else {
        failure = 'no_credentials';
      }

      const { error: completeError } = await ctx.supabaseAdmin.rpc(
        'keel_disconnect_complete',
        {
          p_household_id: householdId.data,
          p_connection_id: connectionId.data,
          p_removal_attempt_id: begin.removalAttemptId,
          p_removed: removed,
          p_failure: failure,
        },
      );
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
      const query = body as { query?: string; householdId?: string };
      const proc = query.query ? QUERY_TO_PROC[query.query] : undefined;
      if (!proc || typeof query.householdId !== 'string') {
        return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
      }
      if (query.query === 'recurring.list' || query.query === 'paychecks.list' || query.query === 'reimbursements.list' || query.query === 'statements.list') {
        const parsedHousehold = HouseholdIdSchema.safeParse(query.householdId);
        if (!parsedHousehold.success) {
          return json(400, { code: 'invalid_command', message: 'Unknown query.', details: {} });
        }
        const authzCtx = await loadAuthzContext(ctx.supabase, userId);
        const decision = authorize(authzCtx, query.query as Action, {
          kind: 'household', householdId: parsedHousehold.data,
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
      } else if (query.query === 'dashboard.net_worth') {
        const db = body as { asOf?: unknown };
        rpcArgs.p_as_of = isoDate(db.asOf) ?? todayIso;
      }
      const { data, error } = await ctx.supabase.rpc(proc, rpcArgs);
      if (error) return mapDbError(error);
      return json(200, data);
    }

    return json(404, { code: 'not_found', message: 'Not found.', details: {} });
  }),
};
