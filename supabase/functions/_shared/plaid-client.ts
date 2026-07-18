// deno-lint-ignore no-explicit-any
type AdminClient = any;

import {
  meterCall,
  PLAID_DAILY_CALL_LIMIT,
  refundProviderCall,
  reserveProviderCall,
  type ProviderCallKind,
} from './plaid-meter.ts';

export interface PlaidErrorFields {
  error_code: string | null;
  error_type: string | null;
  request_id: string | null;
}

// Law 12 (post-build review finding #1): provider-controlled strings must be
// allowlisted before they reach the browser, audit_log, removal_attempts, or
// link_attempts.last_reap_error. Recognized Plaid codes pass through; anything
// unexpected collapses to a constant so a reflected/token-shaped value can never
// escape the boundary.
const ALLOWED_PLAID_ERROR_CODES = new Set<string>([
  'ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND', 'ITEM_ERROR', 'INVALID_ACCESS_TOKEN',
  'INVALID_CREDENTIALS', 'INVALID_REQUEST', 'INVALID_INPUT', 'INVALID_FIELD',
  'INTERNAL_SERVER_ERROR', 'RATE_LIMIT_EXCEEDED', 'PLANNED_MAINTENANCE',
  'PRODUCT_NOT_READY', 'INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING',
  'ITEM_LOCKED', 'USER_SETUP_REQUIRED', 'ACCESS_NOT_GRANTED',
  'ACCOUNTS_LIMIT', 'ACCOUNTS_BALANCE_GET_LIMIT', 'ADDITION_LIMIT', 'AUTH_LIMIT',
  'BALANCE_LIMIT', 'CREDITS_EXHAUSTED', 'IDENTITY_LIMIT', 'INSTITUTIONS_GET_LIMIT',
  'INSTITUTIONS_GET_BY_ID_LIMIT', 'INSTITUTION_RATE_LIMIT',
  'INVESTMENT_HOLDINGS_GET_LIMIT', 'INVESTMENT_TRANSACTIONS_LIMIT', 'ITEM_GET_LIMIT',
  'RATE_LIMIT', 'TRANSACTIONS_LIMIT', 'TRANSACTIONS_REFRESH_LIMIT',
  'TRANSACTIONS_SYNC_LIMIT', 'TRIAL_CONNECTION_LIMIT',
]);
const ALLOWED_PLAID_ERROR_TYPES = new Set<string>([
  'INVALID_REQUEST', 'INVALID_INPUT', 'INVALID_RESULT', 'INSTITUTION_ERROR',
  'RATE_LIMIT_EXCEEDED', 'API_ERROR', 'ITEM_ERROR', 'ASSET_REPORT_ERROR',
  'AUTH_ERROR', 'BANK_TRANSFER_ERROR', 'OAUTH_ERROR',
]);
const normalizeCode = (raw: string | null): string | null =>
  raw === null ? null : ALLOWED_PLAID_ERROR_CODES.has(raw) ? raw : 'provider_error';
const normalizeType = (raw: string | null): string | null =>
  raw === null ? null : ALLOWED_PLAID_ERROR_TYPES.has(raw) ? raw : 'provider_error';
const normalizeRequestId = (raw: string | null): string | null =>
  raw !== null && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;

export class PlaidClientError extends Error {
  readonly errorCode: string | null;
  readonly errorType: string | null;
  readonly requestId: string | null;

  constructor(fields: PlaidErrorFields) {
    super('Plaid request failed');
    this.name = 'PlaidClientError';
    // Normalized at construction so EVERY downstream read (browser response,
    // failure_code, last_reap_error, audit) is already boundary-safe.
    this.errorCode = normalizeCode(fields.error_code);
    this.errorType = normalizeType(fields.error_type);
    this.requestId = normalizeRequestId(fields.request_id);
  }
}

export class ProviderBudgetExhaustedError extends Error {
  constructor() {
    super('Provider call budget exhausted');
    this.name = 'ProviderBudgetExhaustedError';
  }
}

export interface PlaidClient {
  linkTokenCreate(scopeKey: string, requestBody: Record<string, unknown>): Promise<Record<string, unknown>>;
  sandboxPublicTokenCreate(scopeKey: string, requestBody?: Record<string, unknown>): Promise<{ public_token: string }>;
  publicTokenExchange(scopeKey: string, requestBody: { public_token: string }): Promise<{ access_token: string; item_id: string }>;
  accountsGet(scopeKey: string, requestBody: { access_token: string }): Promise<Record<string, unknown>>;
  investmentsHoldingsGet(scopeKey: string, requestBody: { access_token: string }): Promise<Record<string, unknown>>;
  itemRemove(scopeKey: string, requestBody: { access_token: string }): Promise<boolean>;
}

export interface PlaidClientConfig {
  env: string;
  clientId?: string;
  secret?: string;
  householdId?: string | null;
  dailyLimit?: number;
  fetchImpl?: typeof fetch;
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plaid response is invalid');
  }
  return value as Record<string, unknown>;
};

const errorFields = (body: Record<string, unknown>): PlaidErrorFields => ({
  error_code: typeof body['error_code'] === 'string' ? body['error_code'] : null,
  error_type: typeof body['error_type'] === 'string' ? body['error_type'] : null,
  request_id: typeof body['request_id'] === 'string' ? body['request_id'] : null,
});

const requiredString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('Plaid response is invalid');
  return value;
};

export const createPlaidClient = (
  admin: AdminClient,
  config: PlaidClientConfig,
): PlaidClient => {
  if (config.env !== 'sandbox' && config.env !== 'production') {
    throw new Error('Plaid client env must be sandbox or production');
  }

  const request = async (
    scopeKey: string,
    kind: ProviderCallKind,
    path: string,
    requestBody: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const fetchDenied = Deno.env.get('KEEL_PLAID_FETCH_DENY') === 'true';
    let { data: injected, error: injectionError } = await admin.rpc(
      'keel_consume_plaid_test_response',
      { p_scope_key: scopeKey, p_kind: kind },
    );
    if (injectionError) throw new Error('Plaid test response unavailable');
    if (typeof injected !== 'string' && fetchDenied) {
      const recheck = await admin.rpc('keel_consume_plaid_test_response', {
        p_scope_key: scopeKey,
        p_kind: kind,
      });
      injected = recheck.data;
      injectionError = recheck.error;
      if (injectionError) throw new Error('Plaid test response unavailable');
    }

    if (typeof injected === 'string') {
      const start = Date.now();
      let body: Record<string, unknown>;
      let result: Record<string, unknown>;
      try {
        body = asRecord(JSON.parse(injected) as unknown);
        if (kind === 'item_public_token_exchange') {
          result = {
            access_token: `access-sandbox-${scopeKey}`,
            item_id: requiredString(body, 'item_id'),
          };
        } else if (kind === 'sandbox_public_token_create') {
          result = { public_token: `public-sandbox-${scopeKey}` };
        } else {
          result = body;
        }
      } catch (error) {
        await meterCall(admin, {
          provider: 'plaid',
          kind,
          householdId: config.householdId,
          start,
          ok: false,
          errorCode: 'provider_error',
          itemRef: scopeKey,
        });
        throw error;
      }
      await meterCall(admin, {
        provider: 'plaid',
        kind,
        householdId: config.householdId,
        start,
        ok: true,
        requestId: normalizeRequestId(
          typeof body['request_id'] === 'string' ? body['request_id'] : null,
        ),
        itemRef: scopeKey,
      });
      return result;
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
        householdId: config.householdId,
        start: Date.now(),
        ok: false,
        errorCode: 'provider_budget_exhausted',
        itemRef: scopeKey,
      });
      throw new ProviderBudgetExhaustedError();
    }
    if (fetchDenied) {
      await refundProviderCall(admin, 'plaid');
      throw new Error('Plaid fetch disabled in integration');
    }
    // Budget refusal must be independent of provider configuration: the gate
    // runs first (with an exact refund here) so an unconfigured environment
    // still answers 503 provider_budget_exhausted, not a 500.
    if (!config.clientId || !config.secret) {
      await refundProviderCall(admin, 'plaid');
      throw new Error('plaid unavailable');
    }

    const start = Date.now();
    try {
      const response = await (config.fetchImpl ?? fetch)(
        `https://${config.env}.plaid.com${path}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: config.clientId,
            secret: config.secret,
            ...requestBody,
          }),
        },
      );
      let body: Record<string, unknown>;
      try {
        body = asRecord(await response.json());
      } catch {
        throw new PlaidClientError({ error_code: null, error_type: null, request_id: null });
      }
      if (!response.ok) throw new PlaidClientError(errorFields(body));
      await meterCall(admin, {
        provider: 'plaid',
        kind,
        householdId: config.householdId,
        start,
        ok: true,
        requestId: normalizeRequestId(
          typeof body['request_id'] === 'string' ? body['request_id'] : null,
        ),
        itemRef: scopeKey,
      });
      return body;
    } catch (error) {
      await meterCall(admin, {
        provider: 'plaid',
        kind,
        householdId: config.householdId,
        start,
        ok: false,
        errorCode: error instanceof PlaidClientError ? error.errorCode : 'provider_error',
        requestId: error instanceof PlaidClientError ? error.requestId : null,
        itemRef: scopeKey,
      });
      throw error;
    }
  };

  return {
    linkTokenCreate: (scopeKey, requestBody) =>
      request(scopeKey, 'link_token_create', '/link/token/create', requestBody),

    sandboxPublicTokenCreate: async (scopeKey, requestBody = {}) => {
      const body = await request(
        scopeKey,
        'sandbox_public_token_create',
        '/sandbox/public_token/create',
        requestBody,
      );
      return { public_token: requiredString(body, 'public_token') };
    },

    publicTokenExchange: async (scopeKey, requestBody) => {
      const body = await request(
        scopeKey,
        'item_public_token_exchange',
        '/item/public_token/exchange',
        requestBody,
      );
      return {
        access_token: requiredString(body, 'access_token'),
        item_id: requiredString(body, 'item_id'),
      };
    },

    accountsGet: (scopeKey, requestBody) =>
      request(scopeKey, 'accounts_get', '/accounts/get', requestBody),

    investmentsHoldingsGet: (scopeKey, requestBody) =>
      request(scopeKey, 'investments_holdings_get', '/investments/holdings/get', requestBody),

    itemRemove: async (scopeKey, requestBody) => {
      let body: Record<string, unknown>;
      try {
        body = await request(scopeKey, 'item_remove', '/item/remove', requestBody);
      } catch (error) {
        if (error instanceof PlaidClientError && error.errorCode === 'ITEM_NOT_FOUND') return true;
        throw error;
      }
      const fields = errorFields(body);
      if (fields.error_code === 'ITEM_NOT_FOUND') return true;
      if (fields.error_code !== null) throw new PlaidClientError(fields);
      return true;
    },
  };
};
