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
    if (!householdId) {
      setState({ rows: [], asOf: null, loading: false, error: null });
      return;
    }
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
  const [rows, setRows] = useState<Row[] | null>(null);
  const extraKey = JSON.stringify(extra ?? {});

  useEffect(() => {
    if (!householdId) {
      setRows([]);
      return;
    }
    let active = true;
    setRows(null);
    keelQuery<Row>(query, householdId, JSON.parse(extraKey) as Record<string, unknown>)
      .then((res) => {
        if (active) setRows(res.rows);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [query, householdId, extraKey]);

  return rows;
}
