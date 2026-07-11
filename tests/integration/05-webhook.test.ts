/**
 * TASK-000 test 11: the Plaid webhook contract — verification BEFORE
 * ingestion (D-013). Valid signed payloads are recorded + deduped; invalid
 * ones leave zero raw events and land in quarantine.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { callFunction, serviceClient, stackEnv, SEED } from './helpers.js';

const signBody = async (
  body: string,
  opts: { tamper?: boolean; expired?: boolean } = {},
): Promise<string> => {
  const privateJwk = JSON.parse(stackEnv().webhookPrivateJwk) as jose.JWK;
  const key = await jose.importJWK(privateJwk, 'ES256');
  const hash = createHash('sha256')
    .update(opts.tamper ? `${body}tampered` : body)
    .digest('hex');
  const jwt = new jose.SignJWT({ request_body_sha256: hash })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setIssuedAt(
      opts.expired ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000),
    );
  return jwt.sign(key);
};

const webhookBody = (code: string): string =>
  JSON.stringify({
    webhook_type: 'TRANSACTIONS',
    webhook_code: code,
    item_id: SEED.connections.plaidAlpha.ref,
    environment: 'sandbox',
  });

const rawEventCount = async (): Promise<number> => {
  const svc = serviceClient();
  const { count } = await svc
    .from('raw_provider_events')
    .select('*', { count: 'exact', head: true })
    .eq('provider', 'plaid');
  return count ?? 0;
};

const rejectionCount = async (): Promise<number> => {
  const svc = serviceClient();
  const { count } = await svc
    .from('webhook_rejections')
    .select('*', { count: 'exact', head: true });
  return count ?? 0;
};

describe('webhook-provider verification (test 11)', () => {
  it('accepts a correctly signed webhook, records it, and dedupes redelivery', async () => {
    const body = webhookBody('SYNC_UPDATES_AVAILABLE');
    const jwt = await signBody(body);
    const before = await rawEventCount();

    const res = await fetch(
      `${stackEnv().apiUrl}/functions/v1/webhook-provider/plaid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'plaid-verification': jwt },
        body,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, routed: true });
    expect(await rawEventCount()).toBe(before + 1);

    // Exact redelivery: same body, same derived event id → no new raw event.
    const redelivery = await fetch(
      `${stackEnv().apiUrl}/functions/v1/webhook-provider/plaid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'plaid-verification': await signBody(body) },
        body,
      },
    );
    expect(redelivery.status).toBe(200);
    expect(await rawEventCount()).toBe(before + 1);
  });

  it.each([
    ['missing header', async (b: string) => null],
    ['tampered body hash', async (b: string) => signBody(b, { tamper: true })],
    ['expired token', async (b: string) => signBody(b, { expired: true })],
    ['garbage jwt', async () => 'not.a.jwt'],
  ])('rejects %s: zero ingestion, quarantined', async (_label, makeJwt) => {
    const body = webhookBody(`HOSTILE_${Math.random().toString(36).slice(2, 8)}`);
    const jwt = await makeJwt(body);
    const beforeRaw = await rawEventCount();
    const beforeRej = await rejectionCount();

    const res = await fetch(
      `${stackEnv().apiUrl}/functions/v1/webhook-provider/plaid`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(jwt ? { 'plaid-verification': jwt } : {}),
        },
        body,
      },
    );
    expect(res.status).toBe(401);
    expect(await rawEventCount()).toBe(beforeRaw);
    expect(await rejectionCount()).toBe(beforeRej + 1);
  });
});
