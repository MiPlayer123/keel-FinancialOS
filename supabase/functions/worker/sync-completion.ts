import type { SyncPageStatus } from '../_shared/plaid-sync.ts';

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export interface CompleteSyncAttemptInput {
  attemptId: string;
  owner: string;
  connectionId: string;
  nextCursor: string;
  status: SyncPageStatus;
}

export class SyncCompletionError extends Error {
  readonly attemptCompleted: boolean;

  constructor(message: string, attemptCompleted: boolean) {
    super(message);
    this.name = 'SyncCompletionError';
    this.attemptCompleted = attemptCompleted;
  }
}

export const abandonLiveSyncAttempt = async (
  admin: AdminClient,
  input: { attemptId: string; owner: string },
): Promise<void> => {
  const { error } = await admin.rpc('keel_worker_abandon_and_release', {
    p_attempt_id: input.attemptId,
    p_owner: input.owner,
  });
  if (error) throw new Error('live sync cleanup failed');
};

/** Commit one cursor window and, only for live partials, schedule a new attempt. */
export const completeSyncAttempt = async (
  admin: AdminClient,
  input: CompleteSyncAttemptInput,
): Promise<void> => {
  const fullySynced = input.status === 'terminal';
  const { error: completeError } = await admin.rpc('keel_worker_complete_attempt', {
    p_attempt_id: input.attemptId,
    p_owner: input.owner,
    p_next_cursor: input.nextCursor,
    p_fully_synced: fullySynced,
  });
  if (completeError) throw new SyncCompletionError('attempt completion failed', false);

  if (input.status !== 'partial') return;
  const { error: enqueueError } = await admin.rpc('keel_enqueue', {
    queue_name: 'sync_events',
    message: {
      jobType: 'sync_notification',
      economicEventKey: `plaid:sync-continuation:${input.attemptId}`,
      refs: { connectionId: input.connectionId },
    },
  });
  if (enqueueError) throw new SyncCompletionError('sync continuation enqueue failed', true);
};
