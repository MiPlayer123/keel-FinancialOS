import {
  parsePlaidJsonPreservingAmountLexemes,
  PlaidBankProvider,
  PlaidMutationRestart,
} from './vendor/keel-domain.mjs';
import { decryptToken, type EncryptedRecord } from './credential-crypto.ts';
import { getKek } from './credential-kek.ts';

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
const MAX_LIVE_RESTARTS = 3;
const PLAID_SYNC_TIMEOUT_MS = 10_000;

export type SyncPageSource = 'injected' | 'live' | 'disabled';
export type SyncPageStatus = 'terminal' | 'partial' | 'noop';

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
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'mutation_restart_exhausted'
  | 'stalled_cursor';

export class PlaidSyncTransientError extends Error {
  readonly kind: PlaidSyncFailureKind;
  readonly errorCode: typeof MUTATION_ERROR_CODE | 'provider_error' | null;

  constructor(
    kind: PlaidSyncFailureKind,
    errorCode: typeof MUTATION_ERROR_CODE | 'provider_error' | null = null,
  ) {
    super(`Plaid sync request failed (${kind})`);
    this.name = 'PlaidSyncTransientError';
    this.kind = kind;
    this.errorCode = errorCode;
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

const liveGateEnabled = (): boolean =>
  typeof Deno !== 'undefined' &&
  Deno.env.get('KEEL_LIVE_SYNC_ENABLED') === 'true' &&
  Deno.env.get('PLAID_ENV') === 'sandbox' &&
  Boolean(Deno.env.get('PLAID_CLIENT_ID')) &&
  Boolean(Deno.env.get('PLAID_SECRET'));

const normalizeErrorCode = (
  value: unknown,
): typeof MUTATION_ERROR_CODE | 'provider_error' | null => {
  if (value === MUTATION_ERROR_CODE) return MUTATION_ERROR_CODE;
  return typeof value === 'string' ? 'provider_error' : null;
};

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
  return fetch(`https://sandbox.plaid.com${path}`, {
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
      let response: Response;
      try {
        response = await plaidPost('/transactions/sync', {
          access_token: token,
          cursor: requestCursor || undefined,
          count: 100,
        });
      } catch (error) {
        if (error instanceof PlaidSyncTransientError) throw error;
        throw new PlaidSyncTransientError('network');
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        throw new PlaidSyncTransientError('network');
      }
      const control = parseControlBody(bodyText);

      if (!response.ok) {
        const errorCode = normalizeErrorCode(control['error_code']);
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
        throw new PlaidSyncTransientError('invalid_response');
      }
      if (hasMore && (nextCursor.length === 0 || nextCursor === requestCursor)) {
        throw new PlaidSyncTransientError('stalled_cursor');
      }

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
