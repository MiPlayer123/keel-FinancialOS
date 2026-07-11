import type {
  BankProviderAdapter,
  ProviderSyncEvent,
  ProviderTransaction,
  SyncPage,
} from '@keel/contracts';
import { parsePlaidJsonPreservingAmountLexemes } from './lossless.js';
import { plaidAmountToKeelMinor } from './sign.js';

export interface PlaidRecordedSyncResponse {
  readonly connectionExternalRef: string;
  readonly cursor: string;
  readonly status: number;
  readonly rawResponseText: string;
}

export interface PlaidSkippedTransaction {
  readonly kind: 'transaction_added' | 'transaction_modified';
  readonly providerTransactionId: string;
  readonly currency: string | null;
  readonly reason: 'non_usd_currency';
}

export interface PlaidSyncPage extends SyncPage {
  readonly skippedTransactions: readonly PlaidSkippedTransaction[];
}

export class PlaidProviderError extends Error {
  readonly errorCode: string;
  readonly requestId: string | null;
  readonly status: number;

  constructor(errorCode: string, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'PlaidProviderError';
    this.errorCode = errorCode;
    this.requestId = requestId;
    this.status = status;
  }
}

export class PlaidMutationRestart extends PlaidProviderError {
  readonly cursor: string;

  constructor(cursor: string, requestId: string | null, message: string) {
    super('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', message, 400, requestId);
    this.name = 'PlaidMutationRestart';
    this.cursor = cursor;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (message: string): PlaidProviderError =>
  new PlaidProviderError('INVALID_RECORDED_RESPONSE', message, 0, null);

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw invalidResponse(`${label} must be an object`);
  return value;
};

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string') throw invalidResponse(`${key} must be a string`);
  return value;
};

const readNullableString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw invalidResponse(`${key} must be a string or null`);
  return value;
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (typeof value !== 'boolean') throw invalidResponse(`${key} must be a boolean`);
  return value;
};

const readArray = (record: Record<string, unknown>, key: string): unknown[] => {
  const value = record[key];
  if (!Array.isArray(value)) throw invalidResponse(`${key} must be an array`);
  return value;
};

const eventId = (requestId: string, change: string, transactionId: string): string =>
  `plaid:${requestId}:${change}:${transactionId}`;

const mapTransaction = (raw: Record<string, unknown>): ProviderTransaction => {
  const currency = readNullableString(raw, 'iso_currency_code');
  if (currency !== 'USD') {
    throw invalidResponse('non-USD transaction reached USD mapper');
  }

  return {
    providerTransactionId: readString(raw, 'transaction_id'),
    accountExternalRef: readString(raw, 'account_id'),
    amountMinor: plaidAmountToKeelMinor(readString(raw, 'amount'), currency).toString(),
    currency,
    date: readString(raw, 'date'),
    description: readString(raw, 'name'),
    pending: readBoolean(raw, 'pending'),
    pendingTransactionId: readNullableString(raw, 'pending_transaction_id'),
  };
};

const parseError = (
  response: PlaidRecordedSyncResponse,
  parsed: Record<string, unknown>,
): PlaidProviderError => {
  const errorCode = readString(parsed, 'error_code');
  const requestId = readNullableString(parsed, 'request_id');
  const messageValue = parsed['error_message'];
  const message = typeof messageValue === 'string' ? messageValue : errorCode;

  if (errorCode === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
    return new PlaidMutationRestart(response.cursor, requestId, message);
  }
  return new PlaidProviderError(errorCode, message, response.status, requestId);
};

export class PlaidBankProvider implements BankProviderAdapter {
  readonly name = 'plaid' as const;
  readonly #responses: readonly PlaidRecordedSyncResponse[];

  constructor(responses: readonly PlaidRecordedSyncResponse[]) {
    this.#responses = responses;
  }

  sync(connectionExternalRef: string, cursor: string): Promise<PlaidSyncPage> {
    return Promise.resolve().then(() => {
      const response = this.#responses.find(
        (candidate) =>
          candidate.connectionExternalRef === connectionExternalRef && candidate.cursor === cursor,
      );
      if (response === undefined) {
        throw new PlaidProviderError(
          'RECORDED_PAGE_NOT_FOUND',
          'No injected Plaid response matches the connection and cursor',
          0,
          null,
        );
      }

      const parsed = asRecord(
        parsePlaidJsonPreservingAmountLexemes(response.rawResponseText),
        'Plaid response',
      );
      if (response.status >= 400) throw parseError(response, parsed);

      const requestId = readString(parsed, 'request_id');
      const events: ProviderSyncEvent[] = [];
      const skippedTransactions: PlaidSkippedTransaction[] = [];

      const mapChanges = (
        key: 'added' | 'modified',
        kind: 'transaction_added' | 'transaction_modified',
      ): void => {
        for (const value of readArray(parsed, key)) {
          const transaction = asRecord(value, `${key} transaction`);
          const transactionId = readString(transaction, 'transaction_id');
          const currency = readNullableString(transaction, 'iso_currency_code');
          if (currency !== 'USD') {
            skippedTransactions.push({
              kind,
              providerTransactionId: transactionId,
              currency,
              reason: 'non_usd_currency',
            });
            continue;
          }
          events.push({
            kind,
            eventId: eventId(requestId, key, transactionId),
            transaction: mapTransaction(transaction),
          });
        }
      };

      mapChanges('added', 'transaction_added');
      mapChanges('modified', 'transaction_modified');
      for (const value of readArray(parsed, 'removed')) {
        const removed = asRecord(value, 'removed transaction');
        const transactionId = readString(removed, 'transaction_id');
        events.push({
          kind: 'transaction_removed',
          eventId: eventId(requestId, 'removed', transactionId),
          providerTransactionId: transactionId,
        });
      }

      return {
        provider: 'plaid',
        events,
        nextCursor: readString(parsed, 'next_cursor'),
        hasMore: readBoolean(parsed, 'has_more'),
        skippedTransactions,
      };
    });
  }
}
