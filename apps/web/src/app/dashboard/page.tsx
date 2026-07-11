'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { getSupabaseBrowserClient } from '../../lib/supabase';

export default function DashboardPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [householdId, setHouseholdId] = useState('');
  const [result, setResult] = useState('Run an API check to inspect its response.');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    async function loadSession() {
      try {
        const { data, error } = await getSupabaseBrowserClient().auth.getSession();

        if (error) {
          throw error;
        }

        if (!data.session) {
          router.replace('/');
          return;
        }

        if (isActive) {
          setEmail(data.session.user.email ?? 'Email unavailable');
          setIsLoading(false);
        }
      } catch (error) {
        if (isActive) {
          setResult(formatError(error));
          setIsLoading(false);
        }
      }
    }

    void loadSession();

    return () => {
      isActive = false;
    };
  }, [router]);

  async function invokeHealth() {
    await runRequest(() =>
      getSupabaseBrowserClient().functions.invoke('api/health', { method: 'GET' }),
    );
  }

  async function invokeTransactions() {
    await runRequest(() =>
      getSupabaseBrowserClient().functions.invoke('api/queries', {
        body: { query: 'transactions.list', householdId },
      }),
    );
  }

  async function invokeTrialBalance() {
    await runRequest(() =>
      getSupabaseBrowserClient().functions.invoke('api/queries', {
        body: { query: 'ledger.trial_balance', householdId },
      }),
    );
  }

  async function runRequest(
    request: () => Promise<{ data: unknown; error: { message: string } | null }>,
  ) {
    setIsLoading(true);

    try {
      const { data, error } = await request();
      setResult(JSON.stringify({ data, error: error?.message ?? null }, null, 2));
    } catch (error) {
      setResult(formatError(error));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSignOut() {
    setIsLoading(true);

    try {
      const { error } = await getSupabaseBrowserClient().auth.signOut();

      if (error) {
        setResult(formatError(error));
        setIsLoading(false);
        return;
      }

      router.replace('/');
    } catch (error) {
      setResult(formatError(error));
      setIsLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="panel dashboard-panel" aria-labelledby="dashboard-heading">
        <div className="stage-label">KEEL · Stage 1A engineering shell</div>
        <div className="panel-body">
          <header className="dashboard-header">
            <div>
              <p className="eyebrow">Authenticated function checks</p>
              <h1 id="dashboard-heading">API smoke dashboard</h1>
              <p className="signed-in-as">Signed in as {email ?? 'Checking session…'}</p>
            </div>
            <button
              className="button-secondary"
              type="button"
              onClick={() => {
                void handleSignOut();
              }}
            >
              Sign out
            </button>
          </header>

          <div className="field-block">
            <label htmlFor="household-id">Household ID</label>
            <input
              id="household-id"
              name="householdId"
              value={householdId}
              onChange={(event) => setHouseholdId(event.target.value)}
              placeholder="UUID used by query calls"
            />
          </div>

          <div className="button-row button-row--wrap">
            <button
              type="button"
              onClick={() => {
                void invokeHealth();
              }}
              disabled={isLoading}
            >
              API health
            </button>
            <button
              type="button"
              onClick={() => {
                void invokeTransactions();
              }}
              disabled={isLoading}
            >
              List transactions
            </button>
            <button
              type="button"
              onClick={() => {
                void invokeTrialBalance();
              }}
              disabled={isLoading}
            >
              Trial balance
            </button>
          </div>

          <section className="result-block" aria-labelledby="result-heading">
            <div className="result-heading-row">
              <h2 id="result-heading">Raw response</h2>
              <span>{isLoading ? 'Running…' : 'Ready'}</span>
            </div>
            <pre>{result}</pre>
          </section>
        </div>
      </section>
    </main>
  );
}

function formatError(error: unknown): string {
  return JSON.stringify(
    { error: error instanceof Error ? error.message : 'An unknown error occurred.' },
    null,
    2,
  );
}
