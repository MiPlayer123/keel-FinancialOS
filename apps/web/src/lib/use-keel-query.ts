'use client';

import { useCallback, useEffect, useState } from 'react';
import { keelQuery, type QueryResult } from '@/lib/keel-api';

type State<Row> = {
  rows: Row[];
  asOf: string | null;
  loading: boolean;
  error: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Row is caller-specified and types the returned rows
export function useKeelQuery<Row>(query: string, householdId: string | null) {
  const [state, setState] = useState<State<Row>>({
    rows: [],
    asOf: null,
    loading: true,
    error: null,
  });

  const run = useCallback(async () => {
    if (!householdId) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res: QueryResult<Row> = await keelQuery<Row>(query, householdId);
      setState({ rows: res.rows, asOf: res.asOf, loading: false, error: null });
    } catch (err) {
      setState({
        rows: [],
        asOf: null,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load.',
      });
    }
  }, [query, householdId]);

  useEffect(() => {
    void run();
  }, [run]);

  return { ...state, refetch: run };
}
