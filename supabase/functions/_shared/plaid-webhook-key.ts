import * as jose from 'npm:jose@6';
import {
  isValidPlaidWebhookJwk,
  safeStaleAllowed,
  type PlaidWebhookKeyResolution,
  type PlaidWebhookKeyResolver,
} from './plaid-webhook-verify.ts';
import {
  meterCall,
  PLAID_DAILY_CALL_LIMIT,
  reserveProviderCall,
} from './plaid-meter.ts';

export interface WebhookKeyAdminClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }> | { data: unknown; error: unknown };
}

export type WebhookVerificationKeyFetchResult =
  | { status: 'ok'; key: Record<string, unknown> }
  | { status: 'invalid_kid' }
  | { status: 'budget_exhausted' }
  | { status: 'outage' };

interface PlaidWebhookKeyFetchConfig {
  plaidEnv?: string;
  clientId?: string;
  secret?: string;
  dailyLimit?: number;
}

export interface FetchWebhookVerificationKeyDeps {
  fetchImpl?: typeof fetch;
  config?: PlaidWebhookKeyFetchConfig;
  timeoutMs?: number;
}

export interface PlaidWebhookKeyResolverDeps {
  fetchKey?: (keyId: string) => Promise<WebhookVerificationKeyFetchResult>;
  fetchDeps?: FetchWebhookVerificationKeyDeps;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const classifyResponse = (
  httpStatus: number,
  bodyText: string,
): WebhookVerificationKeyFetchResult => {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 'outage' };
  }
  if (!isRecord(body)) return { status: 'outage' };
  if (httpStatus === 200 && isRecord(body['key'])) {
    return { status: 'ok', key: body['key'] };
  }
  if (httpStatus === 400 &&
    body['error_code'] === 'INVALID_WEBHOOK_VERIFICATION_KEY_ID') {
    return { status: 'invalid_kid' };
  }
  return { status: 'outage' };
};

const responseRequestId = (bodyText: string): string | null => {
  try {
    const body = JSON.parse(bodyText) as unknown;
    if (!isRecord(body) || typeof body['request_id'] !== 'string') return null;
    return /^[A-Za-z0-9_-]{1,64}$/.test(body['request_id']) ? body['request_id'] : null;
  } catch {
    return null;
  }
};

export const fetchWebhookVerificationKey = async (
  admin: WebhookKeyAdminClient,
  keyId: string,
  deps: FetchWebhookVerificationKeyDeps = {},
): Promise<WebhookVerificationKeyFetchResult> => {
  const { data: injected, error: injectionError } = await admin.rpc(
    'keel_consume_webhook_key_response',
    { p_kid: keyId },
  );
  if (injectionError) return { status: 'outage' };
  if (injected !== null && injected !== undefined) {
    if (!isRecord(injected) || typeof injected['httpStatus'] !== 'number' ||
      typeof injected['bodyText'] !== 'string') {
      return { status: 'outage' };
    }
    const start = Date.now();
    const result = classifyResponse(injected['httpStatus'], injected['bodyText']);
    await meterCall(admin, {
      provider: 'plaid',
      kind: 'webhook_key_get',
      start,
      ok: result.status === 'ok',
      errorCode: result.status === 'ok' ? null : 'provider_error',
      requestId: responseRequestId(injected['bodyText']),
    });
    return result;
  }

  const config = deps.config ?? {
    plaidEnv: Deno.env.get('PLAID_ENV'),
    clientId: Deno.env.get('PLAID_CLIENT_ID'),
    secret: Deno.env.get('PLAID_SECRET'),
  };
  if (config.plaidEnv !== 'sandbox' || !config.clientId || !config.secret) {
    return { status: 'outage' };
  }

  const reserved = await reserveProviderCall(
    admin,
    'plaid',
    config.dailyLimit ?? PLAID_DAILY_CALL_LIMIT,
  );
  if (!reserved) {
    await meterCall(admin, {
      provider: 'plaid',
      kind: 'budget_refused',
      start: Date.now(),
      ok: false,
      errorCode: 'provider_budget_exhausted',
    });
    return { status: 'budget_exhausted' };
  }

  const start = Date.now();
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(
      'https://sandbox.plaid.com/webhook_verification_key/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          secret: config.secret,
          key_id: keyId,
        }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 4000),
      },
    );
  } catch {
    await meterCall(admin, {
      provider: 'plaid',
      kind: 'webhook_key_get',
      start,
      ok: false,
      errorCode: 'provider_error',
    });
    return { status: 'outage' };
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    await meterCall(admin, {
      provider: 'plaid',
      kind: 'webhook_key_get',
      start,
      ok: false,
      errorCode: 'provider_error',
    });
    return { status: 'outage' };
  }
  const result = classifyResponse(response.status, bodyText);
  await meterCall(admin, {
    provider: 'plaid',
    kind: 'webhook_key_get',
    start,
    ok: result.status === 'ok',
    errorCode: result.status === 'ok' ? null : 'provider_error',
    requestId: responseRequestId(bodyText),
  });
  return result;
};

const rpcSucceeded = async (
  admin: WebhookKeyAdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> => {
  const { error } = await admin.rpc(name, args);
  return !error;
};

const bumpFailure = async (admin: WebhookKeyAdminClient, kid: string): Promise<void> => {
  await admin.rpc('keel_webhook_key_bump_failure', { p_kid: kid });
};

const unixTimestamp = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const createPlaidWebhookKeyResolver = (
  admin: WebhookKeyAdminClient,
  deps: PlaidWebhookKeyResolverDeps = {},
): PlaidWebhookKeyResolver => async (
  kid: string,
  tokenIat?: number,
): Promise<PlaidWebhookKeyResolution> => {
  const { data: cachedData, error: cacheError } = await admin.rpc(
    'keel_webhook_key_get',
    { p_kid: kid },
  );
  if (cacheError) return { outage: true };

  const cached = cachedData === null || cachedData === undefined
    ? null
    : isRecord(cachedData) ? cachedData : undefined;
  if (cached === undefined) return { outage: true };

  const cachedResolution: PlaidWebhookKeyResolution | null = cached === null
    ? null
    : {
      ...(isRecord(cached['jwk']) ? { jwk: cached['jwk'] as jose.JWK } : {}),
      notFound: cached['notFound'] === true,
      stale: cached['stale'] === true,
      ...(typeof cached['fetchedAt'] === 'string' ? { fetchedAt: cached['fetchedAt'] } : {}),
      ...(cached['keyExpiredAt'] === null || typeof cached['keyExpiredAt'] === 'string'
        ? { keyExpiredAt: cached['keyExpiredAt'] as string | null }
        : {}),
    };

  if (cachedResolution && !cachedResolution.stale) {
    if (cachedResolution.notFound) return { notFound: true };
    return cachedResolution;
  }
  if (cachedResolution?.jwk && !cachedResolution.notFound &&
    tokenIat !== undefined && safeStaleAllowed(cachedResolution, tokenIat, Date.now())) {
    return cachedResolution;
  }

  const fetched = await (deps.fetchKey
    ? deps.fetchKey(kid)
    : fetchWebhookVerificationKey(admin, kid, deps.fetchDeps));

  if (fetched.status === 'invalid_kid') {
    const stored = await rpcSucceeded(admin, 'keel_webhook_key_put_negative', { p_kid: kid });
    return stored ? { notFound: true } : { outage: true };
  }

  if (fetched.status === 'budget_exhausted') return { budgetExhausted: true };

  if (fetched.status === 'outage') {
    await bumpFailure(admin, kid);
    if (cachedResolution?.jwk && !cachedResolution.notFound) {
      return { ...cachedResolution, stale: true, outage: true };
    }
    return { outage: true };
  }

  if (!isValidPlaidWebhookJwk(fetched.key, kid)) {
    await bumpFailure(admin, kid);
    return { outage: true };
  }
  try {
    await jose.importJWK(fetched.key as jose.JWK, 'ES256');
  } catch {
    await bumpFailure(admin, kid);
    return { outage: true };
  }

  const createdAt = unixTimestamp(fetched.key['created_at']);
  const expiredAt = unixTimestamp(fetched.key['expired_at']);
  if (createdAt === undefined || expiredAt === undefined) {
    await bumpFailure(admin, kid);
    return { outage: true };
  }

  const stored = await rpcSucceeded(admin, 'keel_webhook_key_put_positive', {
    p_kid: kid,
    p_jwk: fetched.key,
    p_key_created_at: createdAt,
    p_key_expired_at: expiredAt,
  });
  if (!stored) {
    await bumpFailure(admin, kid);
    return { outage: true };
  }

  return {
    jwk: fetched.key as jose.JWK,
    notFound: false,
    stale: false,
    fetchedAt: new Date().toISOString(),
    keyExpiredAt: expiredAt,
  };
};
