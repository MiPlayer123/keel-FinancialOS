import {
  parsePlaidJsonPreservingAmountLexemes,
  PlaidBankProvider,
  PlaidMutationRestart,
  type PlaidSkippedTransaction,
  type ProviderSyncEvent,
} from './vendor/keel-domain.mjs';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export { PlaidMutationRestart };

export interface InjectedSyncPage {
  pageIndex: number;
  bodyText: string;
}

export interface ParsedPlaidSyncPage {
  events: ProviderSyncEvent[];
  nextCursor: string;
  hasMore: boolean;
  skippedTransactions: readonly PlaidSkippedTransaction[];
}

const MUTATION_ERROR_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plaid sync page must be a JSON object');
  }
  return value as Record<string, unknown>;
};

/** Read the deterministic response script used by integration tests. */
export const readSyncPages = async (
  admin: AdminClient,
  connectionId: string,
): Promise<InjectedSyncPage[]> => {
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
  if (pages.length === 0 && typeof Deno !== 'undefined' && Deno.env.get('PLAID_SECRET')) {
    // Live /transactions/sync belongs here once the production HTTP path is
    // enabled. C5b intentionally completes an empty sync without networking.
    console.warn('Plaid live sync path is configured but not enabled in C5b');
  }
  return pages;
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
