/** C6: provider metering, atomic breakers, cadence claims, and pure-SQL cron. */
import { createHash } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { encryptToken } from '../../supabase/functions/_shared/credential-crypto.ts';
import {
  authedHeaders,
  callFunction,
  drainQueue,
  serviceClient,
  serviceRpcWithRetry,
  SEED,
  signIn,
  stackEnv,
  userToken,
} from './helpers.js';

type SigningKey = Parameters<jose.SignJWT['sign']>[0];

const DAILY_LIMIT = 10_000;
const ROOT = join(import.meta.dirname, '..', '..');
const PSQL = existsSync('/Library/PostgreSQL/17/bin/psql')
  ? '/Library/PostgreSQL/17/bin/psql'
  : 'psql'; // CI/Linux: client on PATH
let alexToken: string;
let privateKey: SigningKey;
let publicJwk: jose.JWK;
let cachedDb: { args: string[]; password: string } | null = null;

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const localDb = (): { args: string[]; password: string } => {
  if (cachedDb) return cachedDb;
  const status = execSync('supabase status -o env', { cwd: ROOT, encoding: 'utf8' });
  const raw = status.match(/^DB_URL="?([^"\n]+)"?$/m)?.[1];
  if (!raw) throw new Error('local database URL unavailable');
  const url = new URL(raw);
  cachedDb = {
    args: [
      '-h', url.hostname, '-p', url.port, '-U', decodeURIComponent(url.username),
      '-d', url.pathname.slice(1), '-v', 'ON_ERROR_STOP=1', '-At',
    ],
    password: decodeURIComponent(url.password),
  };
  return cachedDb;
};
const dbCommand = (sql: string): string => {
  const db = localDb();
  return execFileSync(PSQL, [...db.args, '-c', sql], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: db.password },
  }).trim();
};

const dbRows = <T>(query: string): T[] => JSON.parse(dbCommand(
  `select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (${query}) as q`,
) || '[]') as T[];

const today = (): string => new Date().toISOString().slice(0, 10);
const hourBucket = (): string => {
  const value = new Date();
  value.setUTCMinutes(0, 0, 0);
  return value.toISOString();
};

const setBudget = async (provider: string, count: number): Promise<void> => {
  const { error } = await serviceClient().from('provider_call_budget').upsert({
    budget_date: today(),
    provider,
    call_count: count,
  }, { onConflict: 'budget_date,provider' });
  if (error) throw new Error(`budget seed failed: ${error.message}`);
};

const beginLink = async (): Promise<{
  attemptId: string;
  credentialId: string;
  commandId: string;
}> => {
  const commandId = crypto.randomUUID();
  const alex = await signIn(SEED.users.alex.email);
  const { data, error } = await alex.rpc('keel_begin_link', {
    p_command_id: commandId,
    p_household_id: SEED.households.alpha,
    p_entity_id: SEED.entities.alphaPersonal,
    p_provider: 'plaid',
    p_institution_id: 'ins-c6',
  });
  if (error || !data) throw new Error(`begin link failed: ${error?.message ?? 'no data'}`);
  return {
    attemptId: String(data.attemptId),
    credentialId: String(data.credentialId),
    commandId,
  };
};

const createStaleAttempt = async (): Promise<string> => {
  const link = await beginLink();
  const envText = readFileSync(join(ROOT, 'supabase', 'functions', '.env'), 'utf8');
  const kek = envText.match(/^KEEL_CREDENTIAL_KEK=(.+)$/m)?.[1];
  const kekVersion = Number(envText.match(/^KEEL_CREDENTIAL_KEK_VERSION=(.+)$/m)?.[1]);
  if (!kek || !Number.isInteger(kekVersion) || kekVersion <= 0) {
    throw new Error('credential test configuration unavailable');
  }
  const envelope = await encryptToken(
    'c6-budget-reaper-token',
    link.credentialId,
    SEED.households.alpha,
    'plaid',
    kek,
    kekVersion,
  );
  const { error } = await serviceClient().rpc('keel_record_link_exchange', {
    p_attempt_id: link.attemptId,
    p_household_id: SEED.households.alpha,
    p_credential_id: link.credentialId,
    p_plaid_item_id: `c6-budget-reaper-${crypto.randomUUID()}`,
    p_ciphertext_b64: envelope.ciphertext,
    p_iv_b64: envelope.iv,
    p_wrapped_dek_b64: envelope.wrappedDek,
    p_wrap_iv_b64: envelope.wrapIv,
    p_kek_version: envelope.kekVersion,
  });
  if (error) throw new Error(error.message);
  dbCommand(`update public.link_attempts
    set expires_at = now() - interval '1 hour'
    where id = ${sqlLiteral(link.attemptId)}::uuid`);
  return link.attemptId;
};

const injectPlaid = async (
  scopeKey: string,
  kind: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const { error } = await serviceClient().from('plaid_test_responses').insert({
    scope_key: scopeKey,
    kind,
    ordinal: 0,
    body_text: JSON.stringify(body),
  });
  if (error) throw new Error(`Plaid response seed failed: ${error.message}`);
};

const callLink = (commandId: string) => callFunction('/api/connections/link', {
  headers: authedHeaders(alexToken),
  body: {
    commandId,
    householdId: SEED.households.alpha,
    entityId: SEED.entities.alphaPersonal,
    institutionId: 'ins-c6',
  },
});

const queueDepth = async (): Promise<number> => {
  const { data, error } = await serviceClient().rpc('keel_worker_queue_depth', {
    p_queue: 'sync_events',
  });
  if (error) throw new Error(error.message);
  return Number(data);
};

const webhookBody = (code: string): string => JSON.stringify({
  webhook_type: 'TRANSACTIONS',
  webhook_code: code,
  item_id: SEED.connections.plaidAlpha.ref,
  environment: 'sandbox',
});

const signBody = async (body: string, kid: string): Promise<string> =>
  new jose.SignJWT({ request_body_sha256: createHash('sha256').update(body).digest('hex') })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setIssuedAt()
    .sign(privateKey);

const postWebhook = (body: string, verification?: string): Promise<Response> => fetch(
  `${stackEnv().apiUrl}/functions/v1/webhook-provider/plaid`,
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(verification ? { 'plaid-verification': verification } : {}),
    },
    body,
  },
);

const countRows = async (table: 'raw_provider_events' | 'webhook_rejections') => {
  const { count, error } = await serviceClient().from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
};

beforeAll(async () => {
  alexToken = await userToken(SEED.users.alex.email);
  const privateJwk = JSON.parse(stackEnv().webhookPrivateJwk) as jose.JWK;
  privateKey = await jose.importJWK(privateJwk, 'ES256');
  publicJwk = { ...privateJwk };
  delete publicJwk.d;
  await drainQueue('sync_events');
});

describe('C6 metering + breakers + pg_cron', () => {
  it('meters an injected link through the strict Law-12 whitelist', async () => {
    const tokenCanary = `c6-token-${crypto.randomUUID()}`;
    const secretCanary = `c6-secret-${crypto.randomUUID()}`;
    const bodyCanary = `c6-body-${crypto.randomUUID()}`;
    const link = await beginLink();
    await injectPlaid(link.attemptId, 'sandbox_public_token_create', {
      request_id: 'c6_public_request',
    });
    await injectPlaid(link.attemptId, 'item_public_token_exchange', {
      item_id: tokenCanary,
      request_id: 'c6_exchange_request',
    });
    await injectPlaid(link.attemptId, 'accounts_get', {
      request_id: 'c6_accounts_request',
      secret_canary: secretCanary,
      accounts: [{
        account_id: `acct-${crypto.randomUUID()}`,
        name: bodyCanary,
        official_name: null,
        mask: '6000',
        type: 'depository',
        subtype: 'checking',
        balances: { iso_currency_code: 'USD' },
      }],
    });

    expect((await callLink(link.commandId)).status).toBe(200);
    const { data: events, error } = await serviceClient().from('usage_events')
      .select('*')
      .eq('resource_id', link.attemptId)
      .order('occurred_at');
    if (error) throw new Error(error.message);
    expect(events.map((event) => event.kind)).toEqual([
      'sandbox_public_token_create',
      'item_public_token_exchange',
      'accounts_get',
    ]);
    expect(events.every((event) =>
      event.household_id === SEED.households.alpha &&
      event.provider === 'plaid' &&
      event.ok === true &&
      Number.isInteger(event.latency_ms)
    )).toBe(true);
    const meteredText = JSON.stringify(events);
    for (const canary of [tokenCanary, secretCanary, bodyCanary]) {
      expect(meteredText).not.toContain(canary);
    }
    await drainQueue('sync_events');
  });

  it('reserves/refunds atomically and maps an open live-link budget to 503', async () => {
    const provider = `c6-concurrent-${crypto.randomUUID()}`;
    const grants = await Promise.all(Array.from({ length: 20 }, () =>
      serviceClient().rpc('keel_provider_budget_reserve', {
        p_provider: provider,
        p_daily_limit: 3,
      })));
    expect(grants.filter((result) => result.data === true)).toHaveLength(3);
    expect(grants.every((result) => result.error === null)).toBe(true);
    const { data: budget } = await serviceClient().from('provider_call_budget')
      .select('call_count')
      .eq('budget_date', today())
      .eq('provider', provider)
      .single();
    expect(budget?.call_count).toBe(3);
    expect((await serviceClient().rpc('keel_provider_budget_refund', {
      p_provider: provider,
    })).error).toBeNull();
    const { data: refunded } = await serviceClient().from('provider_call_budget')
      .select('call_count')
      .eq('budget_date', today())
      .eq('provider', provider)
      .single();
    expect(refunded?.call_count).toBe(2);

    await setBudget('plaid', DAILY_LIMIT);
    const link = await beginLink();
    const response = await callLink(link.commandId);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'provider_budget_exhausted' });
    const { data: refused } = await serviceClient().from('usage_events')
      .select('kind,resource_id')
      .eq('kind', 'budget_refused')
      .eq('resource_id', link.attemptId);
    expect(refused).toHaveLength(1);
  });

  it('claims cadence concurrently without duplicates and excludes leased/outstanding work', async () => {
    await drainQueue('sync_events');
    dbCommand(`update public.connections
      set next_sync_eligible_at = now() + interval '1 day'
      where provider = 'plaid' and status = 'active'`);

    const idle = crypto.randomUUID();
    const leased = crypto.randomUUID();
    const outstanding = crypto.randomUUID();
    const leaseOwner = crypto.randomUUID();
    dbCommand(`insert into public.connections
      (id, household_id, provider, external_ref, status,
       sync_lease_owner, sync_leased_until, sync_desired_generation, sync_committed_generation)
      values
      (${sqlLiteral(idle)}::uuid, ${sqlLiteral(SEED.households.alpha)}::uuid,
       'plaid', ${sqlLiteral(`c6-idle-${idle}`)}, 'active', null, null, 0, 0),
      (${sqlLiteral(leased)}::uuid, ${sqlLiteral(SEED.households.alpha)}::uuid,
       'plaid', ${sqlLiteral(`c6-leased-${leased}`)}, 'active',
       ${sqlLiteral(leaseOwner)}::uuid, now() + interval '1 minute', 0, 0),
      (${sqlLiteral(outstanding)}::uuid, ${sqlLiteral(SEED.households.alpha)}::uuid,
       'plaid', ${sqlLiteral(`c6-outstanding-${outstanding}`)}, 'active', null, null, 1, 0)`);

    const claims = await Promise.all([
      serviceClient().rpc('keel_cron_enqueue_active_syncs', { p_min_interval_seconds: 900 }),
      serviceClient().rpc('keel_cron_enqueue_active_syncs', { p_min_interval_seconds: 900 }),
    ]);
    expect(claims.every((claim) => claim.error === null)).toBe(true);
    expect(claims.reduce((sum, claim) => sum + Number(claim.data), 0)).toBe(1);
    expect(await queueDepth()).toBe(1);
    const cadence = execFileSync(PSQL, [...localDb().args, '-c', `select jsonb_object_agg(
      id::text, next_sync_eligible_at is not null) from public.connections
      where id in (${sqlLiteral(idle)}::uuid, ${sqlLiteral(leased)}::uuid,
                   ${sqlLiteral(outstanding)}::uuid)`], {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: localDb().password },
    }).trim();
    expect(JSON.parse(cadence)).toEqual({ [idle]: true, [leased]: false, [outstanding]: false });
    await drainQueue('sync_events');
  });

  it('/scheduled/tick calls the same atomic claim and returns its enqueue count', async () => {
    const connectionId = crypto.randomUUID();
    dbCommand(`insert into public.connections
      (id, household_id, provider, external_ref, status)
      values (${sqlLiteral(connectionId)}::uuid, ${sqlLiteral(SEED.households.alpha)}::uuid,
      'plaid', ${sqlLiteral(`c6-tick-${connectionId}`)}, 'active')`);
    const response = await callFunction('/scheduled/tick', {
      headers: { apikey: stackEnv().automationsSecret },
      body: {},
    });
    expect(response).toEqual({ status: 200, body: { ok: true, enqueued: 1 } });
    expect(await queueDepth()).toBe(1);
    await drainQueue('sync_events');
  });

  it('caps quarantine atomically and meters over-cap refusals', async () => {
    const svc = serviceClient();
    const bucket = hourBucket();
    const { data: original, error: originalError } = await svc
      .from('webhook_rejection_counters')
      .select('count')
      .eq('provider', 'plaid')
      .eq('hour_bucket', bucket)
      .maybeSingle();
    if (originalError) throw new Error(originalError.message);
    try {
      await svc.from('webhook_rejection_counters').upsert({
        provider: 'plaid',
        hour_bucket: bucket,
        count: DAILY_LIMIT,
      }, { onConflict: 'provider,hour_bucket' });
      const beforeRejections = await countRows('webhook_rejections');
      const beforeMeter = await svc.from('usage_events')
        .select('*', { count: 'exact', head: true })
        .eq('kind', 'quarantine_capped');
      expect((await postWebhook(webhookBody(`CAPPED_${crypto.randomUUID()}`))).status).toBe(401);
      expect(await countRows('webhook_rejections')).toBe(beforeRejections);
      const afterMeter = await svc.from('usage_events')
        .select('*', { count: 'exact', head: true })
        .eq('kind', 'quarantine_capped');
      expect(afterMeter.count).toBe((beforeMeter.count ?? 0) + 1);

      await svc.from('webhook_rejection_counters').update({ count: DAILY_LIMIT - 2 })
        .eq('provider', 'plaid')
        .eq('hour_bucket', bucket);
      const beforeConcurrent = await countRows('webhook_rejections');
      const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        postWebhook(webhookBody(`CAPPED_CONCURRENT_${index}_${crypto.randomUUID()}`))));
      expect(responses.every((response) => response.status === 401)).toBe(true);
      expect(await countRows('webhook_rejections')).toBe(beforeConcurrent + 2);
      const { data: counter } = await svc.from('webhook_rejection_counters')
        .select('count')
        .eq('provider', 'plaid')
        .eq('hour_bucket', bucket)
        .single();
      expect(counter?.count).toBe(DAILY_LIMIT);
    } finally {
      if (original) {
        const restore = await svc.from('webhook_rejection_counters')
          .update({ count: original.count })
          .eq('provider', 'plaid').eq('hour_bucket', bucket);
        if (restore.error) throw new Error(restore.error.message);
      } else {
        dbCommand(`delete from public.webhook_rejection_counters
          where provider = 'plaid' and hour_bucket = ${sqlLiteral(bucket)}::timestamptz`);
      }
    }
  });

  it('budget-open unusable stale key is 503/no-ingest while a fresh cached key still verifies', async () => {
    await setBudget('plaid', DAILY_LIMIT);
    const beforeRaw = await countRows('raw_provider_events');
    const beforeRejections = await countRows('webhook_rejections');
    const missKid = `c6-miss-${crypto.randomUUID()}`;
    const missBody = webhookBody(`C6_BUDGET_MISS_${crypto.randomUUID()}`);
    const miss = await postWebhook(missBody, await signBody(missBody, missKid));
    expect(miss.status).toBe(503);
    expect(await miss.json()).toMatchObject({ code: 'verification_unavailable' });
    expect(await countRows('raw_provider_events')).toBe(beforeRaw);
    expect(await countRows('webhook_rejections')).toBe(beforeRejections);

    const staleKid = `c6-stale-${crypto.randomUUID()}`;
    await serviceRpcWithRetry('keel_webhook_key_put_positive', {
      p_kid: staleKid,
      p_jwk: { ...publicJwk, kid: staleKid, alg: 'ES256', use: 'sig' },
      p_key_created_at: new Date(0).toISOString(),
      p_key_expired_at: null,
    });
    dbCommand(`update public.plaid_webhook_keys
      set fetched_at = now() - interval '73 hours',
          refresh_after = now() - interval '49 hours'
      where kid = ${sqlLiteral(staleKid)}`);
    const staleBody = webhookBody(`C6_BUDGET_STALE_${crypto.randomUUID()}`);
    const stale = await postWebhook(staleBody, await signBody(staleBody, staleKid));
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ code: 'verification_unavailable' });
    expect(await countRows('raw_provider_events')).toBe(beforeRaw);
    expect(await countRows('webhook_rejections')).toBe(beforeRejections);

    const freshKid = `c6-fresh-${crypto.randomUUID()}`;
    // Fixture planting; retried — the local gateway occasionally answers
    // "invalid response from upstream server" under CI load.
    await serviceRpcWithRetry('keel_webhook_key_put_positive', {
      p_kid: freshKid,
      p_jwk: { ...publicJwk, kid: freshKid, alg: 'ES256', use: 'sig' },
      p_key_created_at: new Date(0).toISOString(),
      p_key_expired_at: null,
    });
    const { data: budgetBeforeFresh } = await serviceClient().from('provider_call_budget')
      .select('call_count')
      .eq('budget_date', today())
      .eq('provider', 'plaid')
      .single();
    const freshBody = webhookBody(`C6_BUDGET_FRESH_${crypto.randomUUID()}`);
    const fresh = await postWebhook(freshBody, await signBody(freshBody, freshKid));
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ received: true, routed: true });
    expect(await countRows('raw_provider_events')).toBe(beforeRaw + 1);
    const { data: budgetAfterFresh } = await serviceClient().from('provider_call_budget')
      .select('call_count')
      .eq('budget_date', today())
      .eq('provider', 'plaid')
      .single();
    expect(budgetAfterFresh?.call_count).toBe(budgetBeforeFresh?.call_count);
    await drainQueue('sync_events');
  });

  it('reaper budget exhaustion releases the claim without burning a retry', async () => {
    await setBudget('plaid', DAILY_LIMIT);
    const attemptId = await createStaleAttempt();
    const response = await callFunction('/worker/reap-links', {
      headers: { apikey: stackEnv().automationsSecret },
      body: {},
    });
    expect(response.status).toBe(200);
    expect(dbRows<{
      state: string;
      reap_attempts: number;
      reap_claim_id: string | null;
      reap_claimed_at: string | null;
      last_reap_error: string | null;
    }>(`select state, reap_attempts, reap_claim_id, reap_claimed_at, last_reap_error
       from public.link_attempts where id = ${sqlLiteral(attemptId)}::uuid`)).toEqual([{
      state: 'exchanged',
      reap_attempts: 0,
      reap_claim_id: null,
      reap_claimed_at: null,
      last_reap_error: 'provider_budget_exhausted',
    }]);
  });
});
