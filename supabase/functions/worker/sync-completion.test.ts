import { abandonLiveSyncAttempt, completeSyncAttempt } from './sync-completion.ts';

const assertEquals = (actual: unknown, expected: unknown, message = 'values differ'): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
};

Deno.test('C5c live partial completion opens a fresh notification before terminal finalization', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: name === 'keel_enqueue' ? 42 : { completed: true }, error: null };
    },
  };
  const common = {
    attemptId: 'attempt-partial',
    owner: 'owner-partial',
    connectionId: 'connection-partial',
    nextCursor: 'cursor-partial',
  };

  await completeSyncAttempt(admin, { ...common, status: 'partial' });
  await completeSyncAttempt(admin, {
    ...common,
    attemptId: 'attempt-terminal',
    owner: 'owner-terminal',
    nextCursor: 'cursor-terminal',
    status: 'terminal',
  });

  assertEquals(calls, [
    {
      name: 'keel_worker_complete_attempt',
      args: {
        p_attempt_id: 'attempt-partial',
        p_owner: 'owner-partial',
        p_next_cursor: 'cursor-partial',
        p_fully_synced: false,
      },
    },
    {
      name: 'keel_enqueue',
      args: {
        queue_name: 'sync_events',
        message: {
          jobType: 'sync_notification',
          economicEventKey: 'plaid:sync-continuation:attempt-partial',
          refs: { connectionId: 'connection-partial' },
        },
      },
    },
    {
      name: 'keel_worker_complete_attempt',
      args: {
        p_attempt_id: 'attempt-terminal',
        p_owner: 'owner-terminal',
        p_next_cursor: 'cursor-terminal',
        p_fully_synced: true,
      },
    },
  ]);
  if (JSON.stringify(calls).includes('keelSyncContinuation')) {
    throw new Error('live partial completion must not reuse the same-attempt continuation');
  }
});

Deno.test('C5c disabled no-op completes without setting sync health or enqueueing', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await completeSyncAttempt(
    {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: { completed: true }, error: null };
      },
    },
    {
      attemptId: 'attempt-noop',
      owner: 'owner-noop',
      connectionId: 'connection-noop',
      nextCursor: 'cursor-unchanged',
      status: 'noop',
    },
  );
  assertEquals(calls, [{
    name: 'keel_worker_complete_attempt',
    args: {
      p_attempt_id: 'attempt-noop',
      p_owner: 'owner-noop',
      p_next_cursor: 'cursor-unchanged',
      p_fully_synced: false,
    },
  }]);
});

Deno.test('C5c partial enqueue failure reports that the cursor was already committed', async () => {
  try {
    await completeSyncAttempt(
      {
        rpc: async (name: string) => ({
          data: name === 'keel_worker_complete_attempt' ? { completed: true } : null,
          error: name === 'keel_enqueue' ? { message: 'queue unavailable' } : null,
        }),
      },
      {
        attemptId: 'attempt-enqueue-failure',
        owner: 'owner-enqueue-failure',
        connectionId: 'connection-enqueue-failure',
        nextCursor: 'cursor-committed',
        status: 'partial',
      },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertEquals(error.name, 'SyncCompletionError');
    assertEquals((error as Error & { attemptCompleted?: boolean }).attemptCompleted, true);
    return;
  }
  throw new Error('expected partial enqueue failure');
});

Deno.test('C5c live catch cleanup calls owner-fenced abandon-and-release', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await abandonLiveSyncAttempt(
    {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: null, error: null };
      },
    },
    { attemptId: 'attempt-failed-live', owner: 'owner-failed-live' },
  );
  assertEquals(calls, [{
    name: 'keel_worker_abandon_and_release',
    args: {
      p_attempt_id: 'attempt-failed-live',
      p_owner: 'owner-failed-live',
    },
  }]);
});
