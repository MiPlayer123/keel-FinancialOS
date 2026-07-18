'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { keelQuery, type QueryResult } from '@/lib/keel-api';

/**
 * Shared cache-key prefix for every `useKeelQuery`/`useKeelQuerySilent` read.
 * Query results are cached (stale-while-revalidate — see `QueryProvider`'s
 * `staleTime`) so repeat navigation across dashboard pages shows data
 * instantly instead of a full loading skeleton.
 *
 * The `refetch()` each hook returns invalidates every key under this prefix,
 * not just the one query it belongs to: a single save (categorize a
 * transaction, settle a claim, contribute to a goal...) can change data
 * behind several *different* queries — including ones not currently
 * mounted, like the Home dashboard's trial balance while the user is on the
 * Ledger page. A stale cached balance surviving a save would be worse than
 * no cache at all, so we invalidate broadly rather than trying to enumerate
 * exactly which query names each mutation touches.
 */
const KEEL_QUERY_KEY = 'keel-query';

/**
 * Cache key for one `useKeelQuery` read — exported so surfaces that share a
 * list (Review's suggest→approve queues + the nav ReviewBadge) can target the
 * exact key for optimistic updates and list-only invalidation (F-003/F-004).
 */
export function keelQueryKey(query: string, householdId: string | null) {
  return [KEEL_QUERY_KEY, query, householdId] as const;
}

/**
 * WS-H (F-005): SCOPED invalidation. The blanket `['keel-query']` prefix nuke
 * (still the `refetch()` default below) re-downloads EVERYTHING mounted on
 * every save — the single biggest cause of the "app is slow" report after the
 * unbounded read itself. This helper invalidates only the named query prefixes
 * for the given household, so a categorize edit refreshes the transaction lists
 * + trial balance without also re-pulling budgets, goals, recurring, holdings,
 * investments, connections, etc.
 *
 * Correctness contract: a caller MUST pass every query a mutation can dirty. If
 * unsure, prefer the broad `refetch()` — a missed key means a stale number,
 * which is worse than an over-fetch. We only narrow the two heaviest surfaces
 * (ledger, account-detail) where the dirtied set is well understood.
 *
 * Both the exact-name key `[prefix, query, householdId]` AND the extra-param
 * variants `[prefix, query, householdId, extraKey]` (silent/envelope reads,
 * and the paginated rich page) start with `[prefix, query, householdId]`, so a
 * single prefix-scoped `invalidateQueries` covers every variant of that query.
 */
export function invalidateKeelQueries(
  queryClient: QueryClient,
  queries: readonly string[],
  householdId: string | null,
): Promise<void> {
  return Promise.all(
    queries.map((query) =>
      queryClient.invalidateQueries({ queryKey: [KEEL_QUERY_KEY, query, householdId] }),
    ),
  ).then(() => undefined);
}

/**
 * The transaction-list reads a categorize/split/transfer/void/tag edit dirties:
 * every rich surface (paginated + unbounded), the trial balance that renders
 * account/category balances, and the Review suggestion queue + its badge count.
 * Curated so the heavy pages can invalidate precisely instead of nuking the
 * whole cache. Cash-flow / net-worth aggregates are intentionally NOT here:
 * they live on Home/Reports, are date-bounded, and already refetch on their own
 * mount — a ledger edit does not need to re-pull them while you're on the
 * ledger (they revalidate on next navigation via staleTime). If a future
 * mutation is found to need one of those live, add it to this list.
 */
export const TRANSACTION_MUTATION_KEYS = [
  'transactions.rich',
  'transactions.rich_page',
  'ledger.trial_balance',
  'categorization.suggestions',
] as const;

/**
 * Hook returning a scoped invalidator bound to the current household. Use in
 * the heavy list pages after a mutation instead of the per-read `refetch()`
 * so unrelated mounted data is not re-downloaded (WS-H F-005).
 */
export function useKeelInvalidate(householdId: string | null) {
  const queryClient = useQueryClient();
  return useCallback(
    (queries: readonly string[]) => invalidateKeelQueries(queryClient, queries, householdId),
    [queryClient, householdId],
  );
}

type State<Row> = {
  rows: Row[];
  asOf: string | null;
  loading: boolean;
  error: string | null;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load.';
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Row is caller-specified and types the returned rows
export function useKeelQuery<Row>(query: string, householdId: string | null) {
  const queryClient = useQueryClient();

  const result = useQuery({
    queryKey: keelQueryKey(query, householdId),
    queryFn: async (): Promise<QueryResult<Row>> => {
      if (!householdId) throw new Error('useKeelQuery: disabled (no household)');
      return keelQuery<Row>(query, householdId);
    },
    enabled: householdId !== null,
  });

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [KEEL_QUERY_KEY] });
  }, [queryClient]);

  const state: State<Row> = {
    rows: result.data?.rows ?? [],
    asOf: result.data?.asOf ?? null,
    loading: result.isLoading,
    error: result.isError ? toErrorMessage(result.error) : null,
  };

  return { ...state, refetch };
}

/**
 * Silent variant for progressive sections (charts, mixes): `null` while
 * loading, `[]` on error or empty — the section simply doesn't render until
 * the backend supports the query. Extra params are serialized for identity.
 */
/**
 * Silent variant that KEEPS the query envelope (asOf + formulaVersion), for
 * surfaces that must stamp reproducibility metadata next to the number
 * (Law 9). `null` while loading; `{ rows: [], asOf: null }` on error/disabled
 * so the section can fall back without crashing.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Row is caller-specified and types the returned rows
export function useKeelQueryEnvelope<Row>(
  query: string,
  householdId: string | null,
  extra?: Record<string, unknown>,
): { rows: Row[]; asOf: string | null } | null {
  const extraKey = JSON.stringify(extra ?? {});

  const result = useQuery({
    queryKey: [KEEL_QUERY_KEY, query, householdId, extraKey],
    queryFn: async (): Promise<QueryResult<Row>> => {
      if (!householdId) throw new Error('useKeelQueryEnvelope: disabled (no household)');
      return keelQuery<Row>(query, householdId, JSON.parse(extraKey) as Record<string, unknown>);
    },
    enabled: householdId !== null,
  });

  if (householdId === null) return { rows: [], asOf: null };
  if (result.isSuccess) return { rows: result.data.rows, asOf: result.data.asOf };
  if (result.isError) return { rows: [], asOf: null };
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Row is caller-specified and types the returned rows
export function useKeelQuerySilent<Row>(
  query: string,
  householdId: string | null,
  extra?: Record<string, unknown>,
): Row[] | null {
  const extraKey = JSON.stringify(extra ?? {});

  const result = useQuery({
    queryKey: [KEEL_QUERY_KEY, query, householdId, extraKey],
    queryFn: async (): Promise<QueryResult<Row>> => {
      if (!householdId) throw new Error('useKeelQuerySilent: disabled (no household)');
      return keelQuery<Row>(query, householdId, JSON.parse(extraKey) as Record<string, unknown>);
    },
    enabled: householdId !== null,
  });

  if (householdId === null) return [];
  if (result.isSuccess) return result.data.rows;
  if (result.isError) return [];
  return null;
}
