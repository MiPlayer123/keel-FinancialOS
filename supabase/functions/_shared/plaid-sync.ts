import {
  parsePlaidJsonPreservingAmountLexemes,
  PlaidBankProvider,
  PlaidMutationRestart,
} from './vendor/keel-domain.mjs';
import { decryptToken, type EncryptedRecord } from './credential-crypto.ts';
import { getKek } from './credential-kek.ts';
import {
  meterCall,
  PLAID_DAILY_CALL_LIMIT,
  reserveProviderCall,
} from './plaid-meter.ts';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export { PlaidMutationRestart };

export interface InjectedSyncPage {
  pageIndex: number;
  bodyText: string;
}

export interface ParsedPlaidSyncPage {
  events: Array<Awaited<ReturnType<InstanceType<typeof PlaidBankProvider>['sync']>>['events'][number]>;
  nextCursor: string;
  hasMore: boolean;
  skippedTransactions: Awaited<ReturnType<InstanceType<typeof PlaidBankProvider>['sync']>>['skippedTransactions'];
}

const MUTATION_ERROR_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const PLAID_REAUTH_CODES = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION'] as const;
const MAX_LIVE_RESTARTS = 3;
const PLAID_SYNC_TIMEOUT_MS = 10_000;

export type SyncPageSource = 'injected' | 'live' | 'disabled';
export type SyncPageStatus = 'terminal' | 'partial' | 'noop';
export type PlaidReauthCode = (typeof PLAID_REAUTH_CODES)[number];

export interface LiveSyncResult {
  source: SyncPageSource;
  status: SyncPageStatus;
  pages: InjectedSyncPage[];
  hasMore: boolean;
  nextCursor: string;
}

export type PlaidPost = (
  path: string,
  body: Record<string, unknown>,
) => Promise<Response>;

export interface LiveSyncOptions {
  baseCursor: string;
  externalRef: string;
  maxPages: number;
  plaidPost?: PlaidPost;
  renewLease: () => Promise<void>;
}

interface CredentialEnvelope extends EncryptedRecord {
  credentialId: string;
  householdId: string;
  provider: string;
}

type PlaidSyncFailureKind =
  | 'credential_rpc'
  | 'credential_decrypt'
  | 'lease_renewal'
  | 'budget'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'mutation_restart_exhausted'
  | 'stalled_cursor';

export class PlaidSyncTransientError extends Error {
  readonly kind: PlaidSyncFailureKind;
  readonly errorCode:
    | typeof MUTATION_ERROR_CODE
    | PlaidReauthCode
    | 'provider_budget_exhausted'
    | 'provider_error'
    | null;
  readonly reauthCode: PlaidReauthCode | null;

  constructor(
    kind: PlaidSyncFailureKind,
    errorCode:
      | typeof MUTATION_ERROR_CODE
      | PlaidReauthCode
      | 'provider_budget_exhausted'
      | 'provider_error'
      | null = null,
  ) {
    super(`Plaid sync request failed (${kind})`);
    this.name = 'PlaidSyncTransientError';
    this.kind = kind;
    this.errorCode = errorCode;
    this.reauthCode = isPlaidReauthCode(errorCode) ? errorCode : null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plaid sync page must be a JSON object');
  }
  return value as Record<string, unknown>;
};

const disabledResult = (baseCursor: string): LiveSyncResult => ({
  source: 'disabled',
  status: 'noop',
  pages: [],
  hasMore: false,
  nextCursor: baseCursor,
});

// Live sync runs against Sandbox or Production. Production was gated behind a
// human ⚑ checkpoint (CLAUDE.md Law 12); the operator has crossed it — the same
// crossing already applied to plaid-client.ts (link-token/exchange). The host
// is chosen from PLAID_ENV below; no other environment is honored.
const liveGateEnabled = (): boolean =>
  typeof Deno !== 'undefined' &&
  Deno.env.get('KEEL_LIVE_SYNC_ENABLED') === 'true' &&
  (Deno.env.get('PLAID_ENV') === 'sandbox' || Deno.env.get('PLAID_ENV') === 'production') &&
  Boolean(Deno.env.get('PLAID_CLIENT_ID')) &&
  Boolean(Deno.env.get('PLAID_SECRET'));

const isPlaidReauthCode = (value: unknown): value is PlaidReauthCode =>
  typeof value === 'string' && (PLAID_REAUTH_CODES as readonly string[]).includes(value);

const normalizeErrorCode = (
  value: unknown,
): typeof MUTATION_ERROR_CODE | PlaidReauthCode | 'provider_error' | null => {
  if (value === MUTATION_ERROR_CODE) return MUTATION_ERROR_CODE;
  if (isPlaidReauthCode(value)) return value;
  return typeof value === 'string' ? 'provider_error' : null;
};

const normalizeRequestId = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

const parseControlBody = (bodyText: string): Record<string, unknown> => {
  try {
    return asRecord(parsePlaidJsonPreservingAmountLexemes(bodyText));
  } catch {
    throw new PlaidSyncTransientError('invalid_response');
  }
};

const defaultPlaidPost = async (
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => {
  if (path !== '/transactions/sync') throw new PlaidSyncTransientError('http');
  if (Deno.env.get('KEEL_PLAID_FETCH_SPY') === 'true') {
    console.warn('KEEL_PLAID_SYNC_FETCH_ATTEMPT');
  }
  if (Deno.env.get('KEEL_PLAID_FETCH_DENY') === 'true') {
    throw new PlaidSyncTransientError('network');
  }
  const plaidEnv = Deno.env.get('PLAID_ENV') === 'production' ? 'production' : 'sandbox';
  return fetch(`https://${plaidEnv}.plaid.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      ...body,
    }),
    signal: AbortSignal.timeout(PLAID_SYNC_TIMEOUT_MS),
  });
};

/** Fetch one bounded, mutation-clean live cursor window from Plaid Sandbox. */
export const fetchSyncPagesLive = async (
  admin: AdminClient,
  connectionId: string,
  opts: LiveSyncOptions,
): Promise<LiveSyncResult> => {
  if (!liveGateEnabled()) return disabledResult(opts.baseCursor);
  if (!Number.isSafeInteger(opts.maxPages) || opts.maxPages <= 0) {
    throw new PlaidSyncTransientError('invalid_response');
  }
  // externalRef is part of the source contract and intentionally never enters
  // the provider request body; Plaid identifies the Item only by access token.
  void opts.externalRef;

  let envelopeResult: { data: CredentialEnvelope | null; error: unknown };
  try {
    envelopeResult = await admin.rpc('keel_get_connection_credential_envelope', {
      p_connection_id: connectionId,
    });
  } catch {
    throw new PlaidSyncTransientError('credential_rpc');
  }
  if (envelopeResult.error) throw new PlaidSyncTransientError('credential_rpc');
  if (envelopeResult.data === null) return disabledResult(opts.baseCursor);

  const envelope = envelopeResult.data;
  let token = '';
  try {
    try {
      token = await decryptToken(
        envelope,
        envelope.credentialId,
        envelope.householdId,
        'plaid',
        getKek(envelope.kekVersion),
      );
    } catch {
      throw new PlaidSyncTransientError('credential_decrypt');
    }

    const plaidPost = opts.plaidPost ?? defaultPlaidPost;
    let cursor = opts.baseCursor ?? '';
    let restarts = 0;
    let pages: InjectedSyncPage[] = [];

    while (pages.length < opts.maxPages) {
      try {
        await opts.renewLease();
      } catch {
        throw new PlaidSyncTransientError('lease_renewal');
      }

      const requestCursor = cursor;
      const liveNetworkBoundary = opts.plaidPost === undefined;
      if (liveNetworkBoundary) {
        const reserved = await reserveProviderCall(admin, 'plaid', PLAID_DAILY_CALL_LIMIT);
        if (!reserved) {
          await meterCall(admin, {
            provider: 'plaid',
            kind: 'budget_refused',
            householdId: envelope.householdId,
            start: Date.now(),
            ok: false,
            errorCode: 'provider_budget_exhausted',
            itemRef: connectionId,
          });
          throw new PlaidSyncTransientError('budget', 'provider_budget_exhausted');
        }
      }

      const requestStart = Date.now();
      const meterLiveRequest = async (
        ok: boolean,
        errorCode: string | null = null,
        requestId: string | null = null,
      ): Promise<void> => {
        if (!liveNetworkBoundary) return;
        await meterCall(admin, {
          provider: 'plaid',
          kind: 'transactions_sync',
          householdId: envelope.householdId,
          start: requestStart,
          ok,
          errorCode,
          requestId,
          itemRef: connectionId,
        });
      };

      let response: Response;
      try {
        response = await plaidPost('/transactions/sync', {
          access_token: token,
          cursor: requestCursor || undefined,
          count: 100,
        });
      } catch (error) {
        await meterLiveRequest(
          false,
          error instanceof PlaidSyncTransientError
            ? (error.errorCode ?? 'provider_error')
            : 'provider_error',
        );
        if (error instanceof PlaidSyncTransientError) throw error;
        throw new PlaidSyncTransientError('network');
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        await meterLiveRequest(false, 'provider_error');
        throw new PlaidSyncTransientError('network');
      }
      let control: Record<string, unknown>;
      try {
        control = parseControlBody(bodyText);
      } catch (error) {
        await meterLiveRequest(false, 'provider_error');
        throw error;
      }
      const requestId = normalizeRequestId(control['request_id']);

      if (!response.ok) {
        const errorCode = normalizeErrorCode(control['error_code']);
        await meterLiveRequest(false, errorCode, requestId);
        if (response.status === 400 && errorCode === MUTATION_ERROR_CODE) {
          if (restarts >= MAX_LIVE_RESTARTS) {
            throw new PlaidSyncTransientError('mutation_restart_exhausted', errorCode);
          }
          pages = [];
          cursor = opts.baseCursor ?? '';
          restarts += 1;
          continue;
        }
        throw new PlaidSyncTransientError('http', errorCode);
      }

      const nextCursor = control['next_cursor'];
      const hasMore = control['has_more'];
      if (typeof nextCursor !== 'string' || typeof hasMore !== 'boolean') {
        await meterLiveRequest(false, 'provider_error', requestId);
        throw new PlaidSyncTransientError('invalid_response');
      }
      if (hasMore && (nextCursor.length === 0 || nextCursor === requestCursor)) {
        await meterLiveRequest(false, 'provider_error', requestId);
        throw new PlaidSyncTransientError('stalled_cursor');
      }
      await meterLiveRequest(true, null, requestId);

      pages.push({ pageIndex: pages.length, bodyText });
      cursor = nextCursor;
      if (!hasMore) {
        return {
          source: 'live',
          status: 'terminal',
          pages,
          hasMore: false,
          nextCursor: cursor,
        };
      }
    }

    return {
      source: 'live',
      status: 'partial',
      pages,
      hasMore: true,
      nextCursor: cursor,
    };
  } finally {
    token = '';
  }
};

/** Single dispatcher: deterministic injected pages always take precedence. */
export const readSyncPages = async (
  admin: AdminClient,
  connectionId: string,
  opts: LiveSyncOptions,
): Promise<LiveSyncResult> => {
  const { data, error } = await admin
    .from('sync_test_pages')
    .select('page_index, body_text')
    .eq('connection_id', connectionId)
    .order('page_index');
  if (error) throw new Error(`sync page read failed: ${error.message}`);

  const pages = (data ?? []).map((row: { page_index: number; body_text: string }) => ({
    pageIndex: row.page_index,
    bodyText: row.body_text,
  }));
  if (pages.length > 0) {
    for (const page of pages) {
      const start = Date.now();
      let ok = false;
      let errorCode: typeof MUTATION_ERROR_CODE | PlaidReauthCode | 'provider_error' | null =
        'provider_error';
      let requestId: string | null = null;
      try {
        const control = parseControlBody(page.bodyText);
        errorCode = normalizeErrorCode(control['error_code']);
        requestId = normalizeRequestId(control['request_id']);
        ok = errorCode === null;
      } catch {
        // The worker still owns parsing/classification; metering records only a
        // sanitized failure and never copies the injected response body.
      }
      await meterCall(admin, {
        provider: 'plaid',
        kind: 'transactions_sync',
        start,
        ok,
        errorCode,
        requestId,
        itemRef: connectionId,
      });
      if (isPlaidReauthCode(errorCode)) {
        throw new PlaidSyncTransientError('http', errorCode);
      }
    }
    return {
      source: 'injected',
      status: 'terminal',
      pages,
      hasMore: false,
      nextCursor: opts.baseCursor,
    };
  }
  return fetchSyncPagesLive(admin, connectionId, opts);
};

/**
 * Parse and map one raw /transactions/sync body through the shared Plaid
 * adapter. That keeps lossless decimal handling, USD sign conversion, and
 * non-USD skip recording identical to @keel/plaid.
 */
export const parsePlaidSyncPage = async (
  bodyText: string,
  connectionExternalRef = 'injected-plaid-item',
  cursor = '',
): Promise<ParsedPlaidSyncPage> => {
  const parsed = asRecord(parsePlaidJsonPreservingAmountLexemes(bodyText));
  if (parsed['error_code'] === MUTATION_ERROR_CODE) {
    throw new PlaidMutationRestart(
      cursor,
      typeof parsed['request_id'] === 'string' ? parsed['request_id'] : null,
      typeof parsed['error_message'] === 'string' ? parsed['error_message'] : MUTATION_ERROR_CODE,
    );
  }

  const provider = new PlaidBankProvider([
    {
      connectionExternalRef,
      cursor,
      status: 200,
      rawResponseText: bodyText,
    },
  ]);
  const page = await provider.sync(connectionExternalRef, cursor);
  return {
    events: [...page.events],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    skippedTransactions: page.skippedTransactions,
  };
};
