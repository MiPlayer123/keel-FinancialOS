/**
 * TASK-000 tests 9 + 10: function auth boundaries.
 * 9: user-facing `api` rejects missing/invalid user JWTs.
 * 10: worker/scheduled reject publishable & user credentials and accept ONLY
 *     the named automations secret (positive case included per PLAN §3.6.11).
 */
import { describe, expect, it } from 'vitest';
import { callFunction, stackEnv, userToken, authedHeaders, SEED } from './helpers.js';

describe('api (auth: user) — test 9', () => {
  it('rejects a request with no credentials at all', async () => {
    const res = await callFunction('/api/health', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('rejects the publishable key alone (not a user credential)', async () => {
    const res = await callFunction('/api/health', {
      method: 'GET',
      headers: { apikey: stackEnv().anonKey },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage bearer token', async () => {
    const res = await callFunction('/api/health', {
      method: 'GET',
      headers: { apikey: stackEnv().anonKey, authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid session JWT', async () => {
    const token = await userToken(SEED.users.alex.email);
    const res = await callFunction('/api/health', {
      method: 'GET',
      headers: authedHeaders(token),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'api' });
  });
});

describe.each(['worker', 'scheduled'])('%s (auth: secret:automations) — test 10', (fn) => {
  const health = `/${fn}/health`;

  it('rejects missing credentials', async () => {
    expect((await callFunction(health, { method: 'GET' })).status).toBe(401);
  });

  it('rejects the publishable key', async () => {
    const res = await callFunction(health, {
      method: 'GET',
      headers: { apikey: stackEnv().anonKey },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a valid USER JWT (users are not automations)', async () => {
    const token = await userToken(SEED.users.alex.email);
    const res = await callFunction(health, { method: 'GET', headers: authedHeaders(token) });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed/wrong secret', async () => {
    const res = await callFunction(health, {
      method: 'GET',
      headers: { apikey: 'not-a-valid-secret-key' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts only the named automations secret (positive case)', async () => {
    const res = await callFunction(health, {
      method: 'GET',
      headers: { apikey: stackEnv().automationsSecret },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
