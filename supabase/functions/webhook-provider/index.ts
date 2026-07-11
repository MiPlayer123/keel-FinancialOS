/**
 * KEEL `webhook-provider` — public transport, verified ingestion (D-013).
 *
 * Order is law (CLAUDE.md repo rule; TASK-000 test 11): the exact request
 * bytes are buffered, the Plaid-Verification ES256 JWT is validated against
 * the provider's JWK, and the JWT's request_body_sha256 must equal the hash
 * of those bytes. ONLY verified payloads become immutable raw events;
 * failures are quarantined in webhook_rejections and answered 401.
 *
 * Key source:
 *   - live Plaid (stage 1C ⚑): /webhook_verification_key/get per kid
 *   - Stage 1A tests: PLAID_WEBHOOK_JWK env fixture (public JWK JSON)
 */
import { withSupabase } from 'npm:@supabase/server@1.3.0';
import * as jose from 'npm:jose@6';
import { json } from '../_shared/http.ts';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

interface VerifyResult {
  ok: boolean;
  reason: string;
}

const verifyPlaidSignature = async (
  verificationJwt: string | null,
  bodyBytes: Uint8Array,
): Promise<VerifyResult> => {
  if (!verificationJwt) return { ok: false, reason: 'missing Plaid-Verification header' };

  const jwkJson = Deno.env.get('PLAID_WEBHOOK_JWK');
  if (!jwkJson) return { ok: false, reason: 'no verification key configured' };

  let key: jose.CryptoKey | Uint8Array;
  try {
    key = await jose.importJWK(JSON.parse(jwkJson), 'ES256');
  } catch {
    return { ok: false, reason: 'verification key invalid' };
  }

  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(verificationJwt, key, {
      algorithms: ['ES256'],
      maxTokenAge: '5 minutes',
    }));
  } catch (err) {
    return { ok: false, reason: `jwt verification failed: ${(err as Error).name}` };
  }

  const claimed = payload['request_body_sha256'];
  if (typeof claimed !== 'string') {
    return { ok: false, reason: 'jwt missing request_body_sha256' };
  }
  const actual = await sha256Hex(bodyBytes);
  if (claimed !== actual) return { ok: false, reason: 'body hash mismatch' };

  return { ok: true, reason: 'verified' };
};

const quarantine = async (
  admin: AdminClient,
  reason: string,
  bodyBytes: Uint8Array,
  headers: Headers,
): Promise<void> => {
  await admin.from('webhook_rejections').insert({
    provider: 'plaid',
    reason,
    body: `\\x${Array.from(bodyBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`,
    headers: Object.fromEntries(
      // Never store credentials: verification header is consumed, not kept.
      [...headers.entries()].filter(([k]) => !['authorization', 'apikey'].includes(k)),
    ),
  });
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

    const bodyBytes = new Uint8Array(await req.arrayBuffer());
    const admin = ctx.supabaseAdmin;

    const verdict = await verifyPlaidSignature(
      req.headers.get('plaid-verification'),
      bodyBytes,
    );
    if (!verdict.ok) {
      await quarantine(admin, verdict.reason, bodyBytes, req.headers);
      return json(401, { code: 'not_authenticated', message: 'Verification failed.', details: {} });
    }

    let body: {
      webhook_type?: string;
      webhook_code?: string;
      item_id?: string;
      environment?: string;
    };
    try {
      body = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      await quarantine(admin, 'verified but not JSON', bodyBytes, req.headers);
      return json(400, { code: 'invalid_command', message: 'Invalid JSON.', details: {} });
    }

    // Stage 1A contract: verified events are recorded + deduped + enqueued
    // atomically via the worker-path proc. Plaid webhooks are notifications
    // ("SYNC_UPDATES_AVAILABLE"), the actual pull happens via /transactions/
    // sync in stage 1C — here we record the verified notification itself.
    const eventId = `${body.webhook_type ?? 'UNKNOWN'}:${body.webhook_code ?? 'UNKNOWN'}:${
      body.item_id ?? 'unknown-item'
    }:${await sha256Hex(bodyBytes)}`;

    const { data, error } = await admin.rpc('keel_worker_record_raw_event', {
      p_provider: 'plaid',
      p_connection_external_ref: body.item_id ?? 'unknown-item',
      p_provider_event_id: eventId,
      p_account_external_ref: 'item-level',
      p_body: body,
      p_received_at: new Date().toISOString(),
    });
    if (error) {
      // Unknown item: verified but unroutable — quarantine, still 200 so the
      // provider does not retry forever (Plaid convention).
      await quarantine(admin, `unroutable: ${error.code}`, bodyBytes, req.headers);
      return json(200, { received: true, routed: false });
    }

    return json(200, { received: true, routed: true, rawEventId: data?.rawEventId ?? null });
  }),
};
