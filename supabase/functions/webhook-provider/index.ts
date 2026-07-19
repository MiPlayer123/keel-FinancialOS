/**
 * KEEL `webhook-provider` — public transport, verified Plaid ingestion.
 *
 * The raw request is bounded, its signed-JWT key is resolved by `kid`, and
 * signature/body-hash/environment verification completes before any raw event
 * is stored. Invalid deliveries are bounded-quarantined; key infrastructure
 * failures are retryable and never ingest.
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import { json } from '../_shared/http.ts';
import { createPlaidWebhookKeyResolver } from '../_shared/plaid-webhook-key.ts';
import {
  declaredWebhookBodyTooLarge,
  readBoundedWebhookBody,
} from '../_shared/plaid-webhook-request.ts';
import {
  MAX_VERIFICATION_HEADER_BYTES,
  sha256Hex,
  verifyPlaidWebhook,
} from '../_shared/plaid-webhook-verify.ts';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

const EMPTY_BYTES = new Uint8Array();
const QUARANTINE_WINDOW_MS = 60 * 60 * 1000;
const SENSITIVE_HEADERS = new Set(['plaid-verification', 'authorization', 'apikey']);
const REAUTH_REQUIRED_ITEM_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  // Conservative lifecycle handling: revoked permission and bad item state
  // require user repair and remain write-blocked until Plaid reports repair.
  'USER_PERMISSION_REVOKED',
  'ITEM_BAD_STATE',
]);
const REAUTH_CLEARED_ITEM_CODE = 'LOGIN_REPAIRED';

// Atomic quarantine (post-build review, Codex #2): the dedupe + insert happen
// inside a single SECURITY DEFINER RPC serialized by a per-(reason,hash)
// advisory lock, so a concurrent forgery flood can't defeat the bound. The
// insert failure is surfaced (no longer silently ignored).
const quarantine = async (
  admin: AdminClient,
  reason: string,
  bodyBytes: Uint8Array,
  headers: Headers,
): Promise<boolean> => {
  const bodySha256 = await sha256Hex(bodyBytes);
  const safeHeaders = Object.fromEntries(
    [...headers.entries()].filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())),
  );
  const { error } = await admin.rpc('keel_webhook_quarantine', {
    p_reason: reason,
    p_body_sha256: bodySha256,
    // Raw lowercase hex (no `\x`); the proc decode()s it to bytea.
    p_body_hex: Array.from(bodyBytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    p_headers: safeHeaders,
    p_window_seconds: Math.floor(QUARANTINE_WINDOW_MS / 1000),
  });
  return !error;
};

const invalidResponse = () =>
  json(401, { code: 'not_authenticated', message: 'Verification failed.', details: {} });

const earlyEnvironment = (bodyBytes: Uint8Array): string | null => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const environment = (value as Record<string, unknown>)['environment'];
      return typeof environment === 'string' ? environment : null;
    }
  } catch {
    // Invalid JSON proceeds to normal verification/classification.
  }
  return null;
};

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/webhook-provider/, '');

    if (req.method === 'GET' && path === '/health') {
      return json(200, { ok: true, service: 'webhook-provider' });
    }
    if (req.method !== 'POST' || path !== '/plaid') {
      return json(404, { code: 'not_found', message: 'Not found.', details: {} });
    }

    const admin = ctx.supabaseAdmin;
    const verificationHeader = req.headers.get('plaid-verification');

    // Gate attacker-controlled declared size and verification header before
    // buffering the request body. Oversize quarantine stores no attacker body.
    if (declaredWebhookBodyTooLarge(req.headers)) {
      await quarantine(admin, 'webhook body too large', EMPTY_BYTES, req.headers);
      return invalidResponse();
    }
    if (verificationHeader !== null &&
      verificationHeader.length > MAX_VERIFICATION_HEADER_BYTES) {
      await quarantine(admin, 'Plaid-Verification header too large', EMPTY_BYTES, req.headers);
      return invalidResponse();
    }

    const boundedBody = await readBoundedWebhookBody(req);
    if (!boundedBody.ok) {
      await quarantine(admin, boundedBody.reason, EMPTY_BYTES, req.headers);
      return invalidResponse();
    }
    const { bodyBytes } = boundedBody;

    // Production/non-sandbox deliveries are acknowledged and dropped before
    // any key lookup. Unverified data only controls this non-action.
    const environment = earlyEnvironment(bodyBytes);
    if (environment !== null && environment !== 'sandbox') {
      return json(200, { received: true, routed: false });
    }

    const verdict = await verifyPlaidWebhook(bodyBytes, verificationHeader, {
      keyResolver: createPlaidWebhookKeyResolver(admin),
    });

    if (verdict.outcome === 'invalid') {
      await quarantine(admin, verdict.reason, bodyBytes, req.headers);
      return invalidResponse();
    }
    if (verdict.outcome === 'unverifiable') {
      return json(503, { code: 'verification_unavailable' });
    }

    const bodyText = new TextDecoder().decode(bodyBytes);
    const itemId = typeof verdict.body['item_id'] === 'string'
      ? verdict.body['item_id']
      : 'unknown-item';
    const webhookType = typeof verdict.body['webhook_type'] === 'string'
      ? verdict.body['webhook_type']
      : null;
    const webhookCode = typeof verdict.body['webhook_code'] === 'string'
      ? verdict.body['webhook_code']
      : null;
    const isReauthRequired = webhookType === 'ITEM' && webhookCode !== null &&
      REAUTH_REQUIRED_ITEM_CODES.has(webhookCode);
    const isReauthCleared = webhookType === 'ITEM' && webhookCode === REAUTH_CLEARED_ITEM_CODE;

    if (isReauthRequired || isReauthCleared) {
      const { data: connection, error: connectionError } = await admin
        .from('connections')
        .select('id')
        .eq('provider', 'plaid')
        .eq('external_ref', itemId)
        .maybeSingle();
      if (connectionError) return json(503, { code: 'ingestion_unavailable' });
      if (!connection) {
        await quarantine(admin, 'unroutable', bodyBytes, req.headers);
        return json(200, { received: true, routed: false });
      }
      const { error: lifecycleError } = await admin.rpc('keel_set_connection_reauth', {
        p_connection_id: connection.id,
        p_event_type: webhookCode,
        p_required: isReauthRequired,
      });
      if (lifecycleError) return json(503, { code: 'ingestion_unavailable' });
      return json(200, { received: true, routed: true });
    }

    const bodySha256 = await sha256Hex(bodyBytes);
    const { data, error } = await admin.rpc('keel_webhook_record_delivery', {
      p_connection_external_ref: itemId,
      p_provider_event_id: `plaid:webhook:${verdict.jwtFingerprint}`,
      p_body: verdict.body,
      p_body_text: bodyText,
      p_body_sha256: bodySha256,
      p_received_at: new Date().toISOString(),
    });

    if (error) return json(503, { code: 'ingestion_unavailable' });
    if (data?.unroutable === true) {
      await quarantine(admin, 'unroutable', bodyBytes, req.headers);
      return json(200, { received: true, routed: false });
    }

    // Investments readiness (F-013/F-014, migration 20260719200000): Fidelity
    // and other OAuth institutions populate Investments data ASYNCHRONOUSLY
    // after link — /investments/* returns 200-with-empty until the institution
    // finishes its initial pull, signalled by these webhooks. The regular
    // sync_notification path only drives /transactions/sync (cursor-based) and
    // never re-pulls holdings/inv-txns, so without this the data sat invisible
    // until the next cron refresh. Fire the idempotent re-pull immediately;
    // non-fatal — the 3-minute refresh-balances cron remains the backstop.
    if (webhookType === 'HOLDINGS' || webhookType === 'INVESTMENTS_TRANSACTIONS') {
      const { error: repullError } = await admin.rpc('keel_trigger_investment_repull');
      if (repullError) {
        console.error(`investments repull trigger failed (non-fatal): ${repullError.message}`);
      }
    }

    return json(200, {
      received: true,
      routed: true,
      rawEventId: data?.rawEventId ?? null,
    });
  }),
};
