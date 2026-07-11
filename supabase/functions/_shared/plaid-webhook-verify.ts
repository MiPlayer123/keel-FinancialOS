import * as jose from 'npm:jose@6';
import { MAX_WEBHOOK_BYTES } from './plaid-webhook-request.ts';

export { MAX_WEBHOOK_BYTES } from './plaid-webhook-request.ts';
export const MAX_VERIFICATION_HEADER_BYTES = 8 * 1024;
export const PLAID_WEBHOOK_STALE_GRACE_MS = 72 * 60 * 60 * 1000;

export interface PlaidWebhookKeyResolution {
  jwk?: jose.JWK;
  notFound?: boolean;
  stale?: boolean;
  outage?: boolean;
  fetchedAt?: string;
  keyExpiredAt?: string | null;
}

export type PlaidWebhookKeyResolver = (
  kid: string,
) => Promise<PlaidWebhookKeyResolution>;

export type PlaidWebhookVerdict =
  | { outcome: 'verified'; reason: 'verified'; body: Record<string, unknown>; jwtFingerprint: string }
  | { outcome: 'invalid'; reason: string }
  | { outcome: 'unverifiable'; reason: string };

export interface VerifyPlaidWebhookDeps {
  keyResolver: PlaidWebhookKeyResolver;
}

const LOWER_HEX_SHA256 = /^[a-f0-9]{64}$/;

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
};

/** Fixed-length XOR accumulation after strict format validation. */
export const constantTimeSha256Equal = (claimed: string, actual: string): boolean => {
  if (!LOWER_HEX_SHA256.test(claimed) || !LOWER_HEX_SHA256.test(actual)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= claimed.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidPlaidWebhookJwk = (
  value: unknown,
  requestedKid: string,
): value is jose.JWK => {
  if (!isRecord(value)) return false;
  return value['kty'] === 'EC' &&
    value['crv'] === 'P-256' &&
    (value['alg'] === undefined || value['alg'] === 'ES256') &&
    (value['use'] === undefined || value['use'] === 'sig') &&
    value['kid'] === requestedKid &&
    typeof value['x'] === 'string' && value['x'].length > 0 &&
    typeof value['y'] === 'string' && value['y'].length > 0 &&
    !Object.hasOwn(value, 'd');
};

const invalid = (reason: string): PlaidWebhookVerdict => ({ outcome: 'invalid', reason });
const unverifiable = (reason: string): PlaidWebhookVerdict => ({
  outcome: 'unverifiable',
  reason,
});

const safeStaleAllowed = (
  resolution: PlaidWebhookKeyResolution,
  tokenIat: number,
  nowMs: number,
): boolean => {
  if (!resolution.stale || !resolution.outage || !resolution.fetchedAt) return false;
  const fetchedAtMs = Date.parse(resolution.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return false;
  const staleAgeMs = nowMs - fetchedAtMs;
  if (staleAgeMs < 0 || staleAgeMs > PLAID_WEBHOOK_STALE_GRACE_MS) return false;
  if (resolution.keyExpiredAt !== null && resolution.keyExpiredAt !== undefined) {
    const expiredAtMs = Date.parse(resolution.keyExpiredAt);
    if (!Number.isFinite(expiredAtMs) || expiredAtMs <= tokenIat * 1000) return false;
  }
  return true;
};

export const verifyPlaidWebhook = async (
  bodyBytes: Uint8Array,
  verificationHeader: string | null,
  deps: VerifyPlaidWebhookDeps,
): Promise<PlaidWebhookVerdict> => {
  if (bodyBytes.byteLength > MAX_WEBHOOK_BYTES) return invalid('webhook body too large');
  if (!verificationHeader) return invalid('missing Plaid-Verification header');
  if (verificationHeader.length > MAX_VERIFICATION_HEADER_BYTES) {
    return invalid('Plaid-Verification header too large');
  }

  let protectedHeader: jose.JWSHeaderParameters;
  try {
    protectedHeader = jose.decodeProtectedHeader(verificationHeader);
  } catch {
    return invalid('malformed verification token');
  }
  if (protectedHeader.alg !== 'ES256') return invalid('verification algorithm rejected');
  if (protectedHeader.typ !== 'JWT') return invalid('verification token type rejected');
  if (typeof protectedHeader.kid !== 'string' ||
    protectedHeader.kid.length === 0 || protectedHeader.kid.length > 128) {
    return invalid('verification key id rejected');
  }

  let unverifiedPayload: jose.JWTPayload;
  try {
    unverifiedPayload = jose.decodeJwt(verificationHeader);
  } catch {
    return invalid('malformed verification payload');
  }
  if (!Number.isInteger(unverifiedPayload.iat)) return invalid('verification iat rejected');
  const tokenIat = unverifiedPayload.iat as number;
  const nowMs = Date.now();
  if (tokenIat * 1000 > nowMs + 5000) return invalid('verification iat is in the future');

  let resolution: PlaidWebhookKeyResolution;
  try {
    resolution = await deps.keyResolver(protectedHeader.kid);
  } catch {
    return unverifiable('verification key resolution failed');
  }
  if (resolution.notFound) return invalid('verification key id not found');
  if (resolution.outage) {
    if (!resolution.jwk) return unverifiable('verification key unavailable');
    if (!safeStaleAllowed(resolution, tokenIat, nowMs)) {
      return unverifiable('stale verification key is outside the safe window');
    }
  }
  if (!resolution.jwk || !isValidPlaidWebhookJwk(resolution.jwk, protectedHeader.kid)) {
    return unverifiable('verification key shape invalid');
  }

  let key: CryptoKey | Uint8Array;
  try {
    key = await jose.importJWK(resolution.jwk, 'ES256');
  } catch {
    return unverifiable('verification key import failed');
  }

  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(verificationHeader, key, {
      algorithms: ['ES256'],
      maxTokenAge: '300s',
      clockTolerance: '5s',
    }));
  } catch {
    return invalid('verification signature rejected');
  }
  if (!Number.isInteger(payload.iat) || (payload.iat as number) * 1000 > Date.now() + 5000) {
    return invalid('verification iat rejected');
  }

  const claimedHash = payload['request_body_sha256'];
  if (typeof claimedHash !== 'string' || !LOWER_HEX_SHA256.test(claimedHash)) {
    return invalid('verification body hash rejected');
  }
  const actualHash = await sha256Hex(bodyBytes);
  if (!constantTimeSha256Equal(claimedHash, actualHash)) {
    return invalid('verification body hash mismatch');
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return invalid('verified webhook body is not JSON');
  }
  if (!isRecord(body)) return invalid('verified webhook body is not an object');
  if (body['environment'] !== 'sandbox') return invalid('webhook environment rejected');

  return {
    outcome: 'verified',
    reason: 'verified',
    body,
    jwtFingerprint: await sha256Hex(new TextEncoder().encode(verificationHeader)),
  };
};
