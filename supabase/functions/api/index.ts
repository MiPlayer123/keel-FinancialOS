/**
 * KEEL `api` — the authenticated command/query surface (INFRA §4/§5).
 * auth: 'user' — every request needs a valid Supabase session JWT; the
 * publishable key alone is not a credential (TASK-000 test 9).
 *
 * Flow per command: validate typed envelope (contracts) → compile
 * authorization (authz, fail-closed) → invoke the SECURITY DEFINER command
 * proc through the USER's client so `auth.uid()` reaches the database, which
 * re-checks membership and executes atomically (INFRA §5 steps 4-11).
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import {
  AccountIdSchema,
  CommandEnvelopeSchema,
  EntityIdSchema,
  parseCommandPayload,
  authorize,
  type Action,
  type AuthzContext,
  type HouseholdId,
  type HouseholdRole,
} from '../_shared/vendor/keel-domain.mjs';
import { json, mapDbError, toSnakeKeys } from '../_shared/http.ts';

const COMMAND_TO_PROC: Record<string, string> = {
  'accounts.create': 'keel_cmd_create_account',
  'ingest.record_raw_event': 'keel_cmd_record_raw_event',
  'ingest.promote_event': 'keel_cmd_promote_event',
  'journal.post_batch': 'keel_cmd_post_batch',
  'journal.reverse_batch': 'keel_cmd_reverse_batch',
};

const QUERY_TO_PROC: Record<string, string> = {
  'ledger.trial_balance': 'keel_trial_balance',
  'transactions.list': 'keel_list_transactions',
};

// deno-lint-ignore no-explicit-any
type UserClient = any;

const loadAuthzContext = async (
  supabase: UserClient,
  userId: string,
): Promise<AuthzContext> => {
  const [memberships, entityMemberships, accountOwnerships] = await Promise.all([
    supabase.from('household_memberships').select('household_id, role').eq('user_id', userId),
    supabase.from('entity_memberships').select('entity_id, entities(household_id)'),
    supabase.from('account_owners').select('account_id, accounts(household_id)'),
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
      const resource = {
        householdId: envelope.data.householdId,
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
      const { data, error } = await ctx.supabase.rpc(proc, {
        p_household_id: query.householdId,
      });
      if (error) return mapDbError(error);
      return json(200, data);
    }

    return json(404, { code: 'not_found', message: 'Not found.', details: {} });
  }),
};
