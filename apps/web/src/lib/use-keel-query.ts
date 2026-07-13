'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
    queryKey: [KEEL_QUERY_KEY, query, householdId],
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
