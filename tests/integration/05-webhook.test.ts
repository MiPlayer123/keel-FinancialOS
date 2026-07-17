/**
 * C4 public webhook security contract. Verification always precedes storage;
 * invalid deliveries quarantine, infrastructure outages never ingest, and
 * verified notifications dedupe on the signed-JWT fingerprint.
 */
import { createHash, createSecretKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { readBoundedWebhookBody } from '../../supabase/functions/_shared/plaid-webhook-request.ts';
import {
  anonClient,
  serviceClient,
  signIn,
  stackEnv,
  SEED,
} from './helpers.js';

const DEFAULT_KID = 'keel-itest-webhook-default';

type SigningKey = Parameters<jose.SignJWT['sign']>[0];

let defaultPrivateKey: SigningKey;
let defaultPublicJwk: jose.JWK;

const publicOnly = (jwk: jose.JWK): jose.JWK => {
  const publicJwk = { ...jwk };
  delete publicJwk.d;
  return publicJwk;
};

const seedPositiveKey = async (
  kid: string,
  jwk: jose.JWK,
  expiredAt: string | null = null,
): Promise<void> => {
  // Retries transient PostgREST errors (seen under CI load as "An invalid
  // response was received from the upstream server") rather than failing the
  // whole suite on infrastructure noise unrelated to the test's assertions.
  for (let attempt = 0; ; attempt++) {
    const { error } = await serviceClient().rpc('keel_webhook_key_put_positive', {
      p_kid: kid,
      p_jwk: { ...publicOnly(jwk), kid, alg: 'ES256', use: 'sig' },
      p_key_created_at: new Date(0).toISOString(),
      p_key_expired_at: expiredAt,
    });
    if (!error) return;
    if (attempt >= 2) throw new Error(`key seed failed: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const signBody = async (
  body: string,
  opts: {
    hashBody?: string;
    iat?: number;
    kid?: string;
    alg?: string;
    key?: SigningKey;
  } = {},
): Promise<string> => {
  const hash = createHash('sha256').update(opts.hashBody ?? body).digest('hex');
  return new jose.SignJWT({ request_body_sha256: hash })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', typ: 'JWT', kid: opts.kid ?? DEFAULT_KID })
    .setIssuedAt(opts.iat ?? Math.floor(Date.now() / 1000))
    .sign(opts.key ?? defaultPrivateKey);
};

const unsignedAlgToken = (body: string, alg: string, kid = DEFAULT_KID): string => {
  const header = jose.base64url.encode(JSON.stringify({ alg, typ: 'JWT', kid }));
  const payload = jose.base64url.encode(JSON.stringify({
    iat: Math.floor(Date.now() / 1000),
    request_body_sha256: createHash('sha256').update(body).digest('hex'),
  }));
  return `${header}.${payload}.`;
};

const webhookBody = (
  code: string,
  itemId = SEED.connections.plaidAlpha.ref,
  environment = 'sandbox',
  webhookType = 'TRANSACTIONS',
): string => JSON.stringify({
  webhook_type: webhookType,
  webhook_code: code,
  item_id: itemId,
  environment,
});

const postWebhook = (
  body: string,
  verification: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> => fetch(
  `${stackEnv().apiUrl}/functions/v1/webhook-provider/plaid`,
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(verification ? { 'plaid-verification': verification } : {}),
      ...extraHeaders,
    },
    body,
  },
);

const tableCount = async (
  table: 'raw_provider_events' | 'webhook_rejections' | 'plaid_webhook_key_test_responses',
  filters: Record<string, string> = {},
): Promise<number> => {
  let query = serviceClient().from(table).select('*', { count: 'exact', head: true });
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(`count ${table} failed: ${error.message}`);
  return count ?? 0;
};

const queueDepth = async (): Promise<number> => {
  // Observability read, not the behavior under test — retry the local
  // gateway's transient "invalid response ... upstream server" hiccup the
  // same way serviceRpcWithRetry does (CI run 29560225203 flaked here).
  let lastMessage = 'unknown error';
  for (let i = 0; i < 3; i++) {
    const { data, error } = await serviceClient().rpc('keel_worker_queue_depth', {
      p_queue: 'sync_events',
    });
    if (!error) return Number(data);
    lastMessage = error.message;
    if (!/upstream server|fetch failed|ECONNREFUSED|502|503/i.test(lastMessage)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  throw new Error(`queue depth failed: ${lastMessage}`);
};

const seedFetchResponse = async (
  kid: string,
  httpStatus: number,
  body: unknown,
  ordinal = 0,
): Promise<void> => {
  // Scaffolding insert — retry the local gateway's transient "invalid
  // response ... upstream server" hiccup like serviceRpcWithRetry does
  // (CI run 29584534409 flaked here).
  let lastMessage = 'unknown error';
  for (let i = 0; i < 3; i++) {
    const { error } = await serviceClient().from('plaid_webhook_key_test_responses').insert({
      kid,
      ordinal,
      http_status: httpStatus,
      body_text: JSON.stringify(body),
    });
    if (!error) return;
    lastMessage = error.message;
    if (!/upstream server|fetch failed|ECONNREFUSED|502|503/i.test(lastMessage)) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  throw new Error(`fetch response seed failed: ${lastMessage}`);
};

beforeAll(async () => {
  const privateJwk = JSON.parse(stackEnv().webhookPrivateJwk) as jose.JWK;
  defaultPrivateKey = await jose.importJWK(privateJwk, 'ES256');
  defaultPublicJwk = { ...publicOnly(privateJwk), kid: DEFAULT_KID, alg: 'ES256', use: 'sig' };
  await seedPositiveKey(DEFAULT_KID, defaultPublicJwk);
});

afterAll(async () => {
  // C4 verifies enqueue semantics directly, then removes only the messages it
  // created so later shared-DB suites do not process Plaid notifications while
  // asserting simulator queue ordering.
  const svc = serviceClient();
  const { data: c4RawEvents, error: rawError } = await svc
    .from('raw_provider_events')
    .select('id')
    .like('provider_event_id', 'plaid:webhook:%');
  if (rawError) throw new Error(`C4 cleanup raw lookup failed: ${rawError.message}`);
  const c4EconomicKeys = new Set(
    c4RawEvents.map((event) => `plaid:webhook:${event.id}`),
  );
  const { data: messages, error: readError } = await svc.rpc('keel_worker_queue_read', {
    p_queue: 'sync_events',
    p_vt: 0,
    p_qty: 1000,
  });
  if (readError) throw new Error(`C4 cleanup queue read failed: ${readError.message}`);
  for (const message of messages ?? []) {
    if (c4EconomicKeys.has(message.message?.economicEventKey)) {
      const { error: archiveError } = await svc.rpc('keel_worker_queue_archive', {
        p_queue: 'sync_events',
        p_msg_id: message.msg_id,
      });
      if (archiveError) throw new Error(`C4 cleanup archive failed: ${archiveError.message}`);
    }
  }
});

describe('webhook-provider verification (test 11)', () => {
  it('accepts a cache-hit webhook and dedupes exact-JWT redelivery', async () => {
    const body = webhookBody('SYNC_UPDATES_AVAILABLE');
    const jwt = await signBody(body);
    const before = await tableCount('raw_provider_events', { provider: 'plaid' });

    const first = await postWebhook(body, jwt);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ received: true, routed: true });
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(before + 1);
    const fingerprint = createHash('sha256').update(jwt).digest('hex');
    const { data: recorded, error: recordedError } = await serviceClient()
      .from('raw_provider_events')
      .select('provider_event_id,account_external_ref,body,body_text,body_sha256')
      .eq('provider_event_id', `plaid:webhook:${fingerprint}`)
      .single();
    expect(recordedError).toBeNull();
    expect(recorded).toMatchObject({
      provider_event_id: `plaid:webhook:${fingerprint}`,
      account_external_ref: 'item-notification',
      body: JSON.parse(body),
      body_text: body,
      body_sha256: createHash('sha256').update(body).digest('hex'),
    });

    const redelivery = await postWebhook(body, jwt);
    expect(redelivery.status).toBe(200);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(before + 1);
  });

  it('records nonce-free identical bodies when their signed JWTs differ', async () => {
    const body = webhookBody('DEFAULT_UPDATE');
    const now = Math.floor(Date.now() / 1000);
    const firstJwt = await signBody(body, { iat: now - 1 });
    const secondJwt = await signBody(body, { iat: now });
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeQueue = await queueDepth();

    expect((await postWebhook(body, firstJwt)).status).toBe(200);
    expect((await postWebhook(body, secondJwt)).status).toBe(200);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw + 2);
    expect(await queueDepth()).toBe(beforeQueue + 2);
  });

  it('sets reauth from a verified ITEM_LOGIN_REQUIRED without recording or enqueueing sync', async () => {
    const body = webhookBody(
      'ITEM_LOGIN_REQUIRED',
      SEED.connections.plaidAlpha.ref,
      'sandbox',
      'ITEM',
    );
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeQueue = await queueDepth();

    const response = await postWebhook(body, await signBody(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, routed: true });
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await queueDepth()).toBe(beforeQueue);

    const svc = serviceClient();
    const { data: connection, error: connectionError } = await svc
      .from('connections')
      .select('status')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    if (connectionError) throw new Error(connectionError.message);
    expect(connection.status).toBe('reauth_required');
    const { data: health, error: healthError } = await svc
      .from('connection_health_events')
      .select('event_type, severity')
      .eq('connection_id', SEED.connections.plaidAlpha.id)
      .eq('event_type', 'ITEM_LOGIN_REQUIRED')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .single();
    if (healthError) throw new Error(healthError.message);
    expect(health).toEqual({ event_type: 'ITEM_LOGIN_REQUIRED', severity: 'error' });
  });

  it('clears reauth from a verified LOGIN_REPAIRED without enqueueing sync', async () => {
    const body = webhookBody(
      'LOGIN_REPAIRED',
      SEED.connections.plaidAlpha.ref,
      'sandbox',
      'ITEM',
    );
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeQueue = await queueDepth();

    const response = await postWebhook(body, await signBody(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, routed: true });
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await queueDepth()).toBe(beforeQueue);

    const { data: connection, error } = await serviceClient()
      .from('connections')
      .select('status')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    if (error) throw new Error(error.message);
    expect(connection.status).toBe('active');
  });

  it('does not let an unverified ITEM lifecycle webhook change connection state', async () => {
    const body = webhookBody(
      'ITEM_LOGIN_REQUIRED',
      SEED.connections.plaidAlpha.ref,
      'sandbox',
      'ITEM',
    );
    const response = await postWebhook(body, await signBody(body, { hashBody: `${body}tampered` }));
    expect(response.status).toBe(401);
    const { data: connection, error } = await serviceClient()
      .from('connections')
      .select('status')
      .eq('id', SEED.connections.plaidAlpha.id)
      .single();
    if (error) throw new Error(error.message);
    expect(connection.status).toBe('active');
  });

  it.each([
    ['missing header', () => Promise.resolve(null)],
    ['tampered body hash', (body: string) => signBody(body, { hashBody: `${body}tampered` })],
    ['expired token', (body: string) => signBody(body, { iat: Math.floor(Date.now() / 1000) - 3600 })],
    ['garbage jwt', () => Promise.resolve('not.a.jwt')],
  ])('rejects %s: zero ingestion, quarantined', async (_label, makeJwt) => {
    const body = webhookBody(`HOSTILE_${crypto.randomUUID()}`);
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeRejections = await tableCount('webhook_rejections');
    const response = await postWebhook(body, await makeJwt(body));
    expect(response.status).toBe(401);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await tableCount('webhook_rejections')).toBe(beforeRejections + 1);
  });

  it('negative-caches only exact invalid-key-id and does not refetch on redelivery', async () => {
    const kid = `unknown-${crypto.randomUUID()}`;
    const body = webhookBody('UNKNOWN_KID');
    const jwt = await signBody(body, { kid });
    const invalidBody = { error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID' };
    await seedFetchResponse(kid, 400, invalidBody, 1);
    await seedFetchResponse(kid, 400, invalidBody, 2);

    expect((await postWebhook(body, jwt)).status).toBe(401);
    expect((await postWebhook(body, jwt)).status).toBe(401);
    expect(await tableCount('plaid_webhook_key_test_responses', { kid })).toBe(1);
    // Destructuring only `data` turned a transient PostgREST error into a
    // baffling "expected null to match object" CI flake; retry errors, but a
    // clean null (row genuinely missing) still fails immediately.
    let cached: unknown;
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await serviceClient().rpc('keel_webhook_key_get', { p_kid: kid });
      if (!error) {
        cached = data;
        break;
      }
      if (attempt >= 2) throw new Error(`keel_webhook_key_get failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(cached).toMatchObject({ notFound: true, stale: false });
  });

  it('acks verified but unroutable notifications and bounded-quarantines them', async () => {
    const body = webhookBody('UNROUTABLE', `missing-${crypto.randomUUID()}`);
    const jwt = await signBody(body);
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const response = await postWebhook(body, jwt);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, routed: false });
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await tableCount('webhook_rejections', { reason: 'unroutable' })).toBeGreaterThan(0);
  });

  it('routes fetched bad-JWK shape to 503 without quarantine or negative cache', async () => {
    const kid = `bad-shape-${crypto.randomUUID()}`;
    const body = webhookBody('BAD_JWK_SHAPE');
    const jwt = await signBody(body, { kid });
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeRejections = await tableCount('webhook_rejections');
    await seedFetchResponse(kid, 200, {
      key: {
        ...defaultPublicJwk,
        kid,
        crv: 'P-384',
        created_at: Math.floor(Date.now() / 1000),
        expired_at: null,
      },
    });

    const response = await postWebhook(body, jwt);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'verification_unavailable' });
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await tableCount('webhook_rejections')).toBe(beforeRejections);
    const { data: cached } = await serviceClient().rpc('keel_webhook_key_get', { p_kid: kid });
    expect(cached).toBeNull();
  });

  it('never ingests on fetch outage and self-heals after a key is seeded', async () => {
    const kid = `outage-${crypto.randomUUID()}`;
    const body = webhookBody('KEY_OUTAGE');
    const jwt = await signBody(body, { kid });
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeRejections = await tableCount('webhook_rejections');
    await seedFetchResponse(kid, 503, { error_code: 'INTERNAL_SERVER_ERROR' });

    expect((await postWebhook(body, jwt)).status).toBe(503);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await tableCount('webhook_rejections')).toBe(beforeRejections);

    await seedPositiveKey(kid, defaultPublicJwk);
    expect((await postWebhook(body, jwt)).status).toBe(200);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw + 1);
  });

  it('uses a safe-stale key on fetch outage within grace and token-time expiry', async () => {
    const kid = `stale-${crypto.randomUUID()}`;
    const body = webhookBody('SAFE_STALE');
    const tokenIat = Math.floor(Date.now() / 1000) - 60;
    const expiresAt = new Date((tokenIat + 30) * 1000).toISOString();
    await seedPositiveKey(kid, defaultPublicJwk, expiresAt);
    const jwt = await signBody(body, { kid, iat: tokenIat });
    await seedFetchResponse(kid, 503, { error_code: 'INTERNAL_SERVER_ERROR' });
    expect((await postWebhook(body, jwt)).status).toBe(200);
  });

  it('rejects none, HS256, RS256, and ES384 algorithm confusion', async () => {
    const rsa = await jose.generateKeyPair('RS256');
    const es384 = await jose.generateKeyPair('ES384');
    const cases: Array<[string, (body: string) => Promise<string>]> = [
      ['none', (body) => Promise.resolve(unsignedAlgToken(body, 'none'))],
      ['HS256', (body) => {
        const secret = createSecretKey(Buffer.from(JSON.stringify(defaultPublicJwk)));
        return new jose.SignJWT({ request_body_sha256: createHash('sha256').update(body).digest('hex') })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: DEFAULT_KID })
          .setIssuedAt()
          .sign(secret);
      }],
      ['RS256', (body) => signBody(body, { alg: 'RS256', key: rsa.privateKey })],
      ['ES384', (body) => signBody(body, { alg: 'ES384', key: es384.privateKey })],
    ];
    for (const [label, makeToken] of cases) {
      const body = webhookBody(`ALG_${label}_${crypto.randomUUID()}`);
      expect((await postWebhook(body, await makeToken(body))).status).toBe(401);
    }
  });

  it('rejects kid/signing-key mismatch and treats cached wrong curve as unverifiable', async () => {
    const kid = `mismatch-${crypto.randomUUID()}`;
    const pair = await jose.generateKeyPair('ES256', { extractable: true });
    await seedPositiveKey(kid, await jose.exportJWK(pair.publicKey));
    const body = webhookBody('KID_MISMATCH');
    expect((await postWebhook(body, await signBody(body, { kid }))).status).toBe(401);

    const badCurveKid = `cached-bad-curve-${crypto.randomUUID()}`;
    const { error } = await serviceClient().rpc('keel_webhook_key_put_positive', {
      p_kid: badCurveKid,
      p_jwk: { ...defaultPublicJwk, kid: badCurveKid, crv: 'P-384' },
      p_key_created_at: new Date(0).toISOString(),
      p_key_expired_at: null,
    });
    expect(error).toBeNull();
    const badBody = webhookBody('CACHED_BAD_CURVE');
    expect((await postWebhook(badBody, await signBody(badBody, { kid: badCurveKid }))).status)
      .toBe(503);
  });

  it('rejects future iat, expired iat, and tampered body', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Promise<string>]> = [];
    const futureBody = webhookBody(`FUTURE_${crypto.randomUUID()}`);
    cases.push([futureBody, signBody(futureBody, { iat: now + 600 })]);
    const expiredBody = webhookBody(`EXPIRED_${crypto.randomUUID()}`);
    cases.push([expiredBody, signBody(expiredBody, { iat: now - 3600 })]);
    const tamperedBody = webhookBody(`TAMPER_${crypto.randomUUID()}`);
    cases.push([tamperedBody, signBody(tamperedBody, { hashBody: `${tamperedBody}changed` })]);
    for (const [body, token] of cases) {
      expect((await postWebhook(body, await token)).status).toBe(401);
    }
  });

  it('early-acks non-sandbox environment without key fetch, raw event, or quarantine', async () => {
    const kid = `production-${crypto.randomUUID()}`;
    const body = webhookBody('PRODUCTION_EVENT', SEED.connections.plaidAlpha.ref, 'production');
    const jwt = await signBody(body, { kid });
    await seedFetchResponse(kid, 400, { error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID' });
    const beforeRaw = await tableCount('raw_provider_events', { provider: 'plaid' });
    const beforeRejections = await tableCount('webhook_rejections');

    const response = await postWebhook(body, jwt);
    expect(response.status).toBe(200);
    expect(await tableCount('raw_provider_events', { provider: 'plaid' })).toBe(beforeRaw);
    expect(await tableCount('webhook_rejections')).toBe(beforeRejections);
    expect(await tableCount('plaid_webhook_key_test_responses', { kid })).toBe(1);
  });

  it('rejects Content-Length over 1 MiB before arrayBuffer', async () => {
    let bodyRead = false;
    const result = await readBoundedWebhookBody({
      headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
      arrayBuffer: () => {
        bodyRead = true;
        throw new Error('oversized request body must not be read');
      },
    });
    expect(result).toEqual({ ok: false, status: 401, reason: 'webhook body too large' });
    expect(bodyRead).toBe(false);
  });

  it('does not let a negative write clobber a fresh positive key', async () => {
    const kid = `positive-wins-${crypto.randomUUID()}`;
    await seedPositiveKey(kid, defaultPublicJwk);
    const { error } = await serviceClient().rpc('keel_webhook_key_put_negative', { p_kid: kid });
    expect(error).toBeNull();
    const { data } = await serviceClient().rpc('keel_webhook_key_get', { p_kid: kid });
    expect(data).toMatchObject({ notFound: false, stale: false });
    expect(data.jwk.kid).toBe(kid);
  });

  it('denies every C4 RPC to anon and authenticated callers', async () => {
    const alex = await signIn(SEED.users.alex.email);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['keel_webhook_key_get', { p_kid: 'denied' }],
      ['keel_webhook_key_put_positive', {
        p_kid: 'denied', p_jwk: {}, p_key_created_at: null, p_key_expired_at: null,
      }],
      ['keel_webhook_key_put_negative', { p_kid: 'denied' }],
      ['keel_webhook_key_bump_failure', { p_kid: 'denied' }],
      ['keel_webhook_record_delivery', {
        p_connection_external_ref: 'denied', p_provider_event_id: 'denied', p_body: {},
        p_body_text: '{}', p_body_sha256: 'a'.repeat(64), p_received_at: new Date().toISOString(),
      }],
      ['keel_consume_webhook_key_response', { p_kid: 'denied' }],
    ];
    for (const client of [anonClient(), alex]) {
      for (const [name, args] of calls) {
        const { error } = await client.rpc(name, args);
        expect(error, `${name} unexpectedly executable`).not.toBeNull();
      }
    }
  });

  it('never persists raw verification or authorization headers (Law 12 canary)', async () => {
    const verificationCanary = `law12-verification-${crypto.randomUUID()}`;
    const authCanary = `law12-authorization-${crypto.randomUUID()}`;
    const apiCanary = `law12-apikey-${crypto.randomUUID()}`;
    const body = webhookBody(`LAW12_${crypto.randomUUID()}`);
    expect((await postWebhook(body, verificationCanary, {
      authorization: `Bearer ${authCanary}`,
      apikey: apiCanary,
    })).status).toBe(401);

    const svc = serviceClient();
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const [{ data: rejections }, { data: raw }, { data: audit }, { data: keyCache }] = await Promise.all([
      svc.from('webhook_rejections').select('reason,headers,body_sha256').eq('body_sha256', bodySha256),
      svc.from('raw_provider_events').select('body,body_text,body_sha256'),
      svc.from('audit_log').select('actor,action,before,after'),
      svc.rpc('keel_webhook_key_get', { p_kid: DEFAULT_KID }),
    ]);
    const persisted = JSON.stringify({ rejections, raw, audit, keyCache });
    expect(persisted).not.toContain(verificationCanary);
    expect(persisted).not.toContain(authCanary);
    expect(persisted).not.toContain(apiCanary);
    for (const rejection of rejections ?? []) {
      const keys = Object.keys(rejection.headers ?? {}).map((key) => key.toLowerCase());
      expect(keys).not.toContain('plaid-verification');
      expect(keys).not.toContain('authorization');
      expect(keys).not.toContain('apikey');
    }
  });
});
