/**
 * TASK-000 tests 3 + 7 (+ test 2 wire half, PLAN §3.5.6/§3.5.9):
 * idempotent commands, atomic mutation+audit+event+queue, string-only money.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  envelope,
  serviceClient,
  userToken,
  authedHeaders,
  SEED,
} from './helpers.js';

let alexHeaders: Record<string, string>;

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
});

const postBatchPayload = () => ({
  description: 'integration groceries',
  effectiveDate: '2026-07-02',
  postings: [
    {
      ledgerAccountId: SEED.ledgerAccounts.alphaGroceries,
      amountMinor: '8742',
      currency: 'USD',
    },
    {
      ledgerAccountId: SEED.ledgerAccounts.alphaChecking,
      amountMinor: '-8742',
      currency: 'USD',
    },
  ],
});

describe('journal.post_batch — happy path and idempotency (test 3)', () => {
  it('posts a balanced batch, then replays the same key as a no-op', async () => {
    const env = envelope(
      'journal.post_batch',
      SEED.households.alpha,
      SEED.users.alex.id,
      postBatchPayload(),
      'idem',
    );

    const first = await callFunction('/api/commands', { headers: alexHeaders, body: env });
    expect(first.status).toBe(200);
    const firstBody = first.body as {
      idempotentReplay: boolean;
      effects: { batchId: string; postings: Array<{ amountMinor: string }> };
    };
    expect(firstBody.idempotentReplay).toBe(false);
    expect(firstBody.effects.batchId).toBeTruthy();
    // Money leaves the API as strings, never JSON numbers (test 2 wire half).
    for (const p of firstBody.effects.postings) {
      expect(typeof p.amountMinor).toBe('string');
    }

    const replay = await callFunction('/api/commands', { headers: alexHeaders, body: env });
    expect(replay.status).toBe(200);
    expect((replay.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    expect((replay.body as { effects: { batchId: string } }).effects.batchId).toBe(
      firstBody.effects.batchId,
    );

    // Exactly ONE batch exists for that command key.
    const svc = serviceClient();
    const { count } = await svc
      .from('journal_batches')
      .select('*', { count: 'exact', head: true })
      .eq('id', firstBody.effects.batchId);
    expect(count).toBe(1);
  });

  it('same key + different payload is a hard conflict, not a silent replay', async () => {
    const env = envelope(
      'journal.post_batch',
      SEED.households.alpha,
      SEED.users.alex.id,
      postBatchPayload(),
      'conflict',
    );
    expect((await callFunction('/api/commands', { headers: alexHeaders, body: env })).status).toBe(
      200,
    );

    const mutated = {
      ...env,
      commandId: crypto.randomUUID(),
      payload: { ...postBatchPayload(), description: 'tampered description' },
    };
    const res = await callFunction('/api/commands', { headers: alexHeaders, body: mutated });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('idempotency_conflict');
  });
});

describe('atomicity — test 7', () => {
  it('a failing command persists NOTHING: no batch, no audit, no event, no queue growth', async () => {
    const svc = serviceClient();
    const counts = async () => {
      const [audit, events, batches] = await Promise.all([
        svc.from('audit_log').select('*', { count: 'exact', head: true }),
        svc.from('domain_events').select('*', { count: 'exact', head: true }),
        svc.from('journal_batches').select('*', { count: 'exact', head: true }),
      ]);
      const { data: q } = await svc.rpc('keel_worker_queue_read', {
        p_queue: 'transaction_enrichment',
        p_vt: 0,
        p_qty: 100,
      });
      return {
        audit: audit.count,
        events: events.count,
        batches: batches.count,
        queued: (q ?? []).length,
      };
    };

    const before = await counts();

    // Unbalanced: passes zod shape validation, dies at the deferred trigger
    // AFTER the batch insert + audit + event + enqueue ran in the proc.
    const env = envelope('journal.post_batch', SEED.households.alpha, SEED.users.alex.id, {
      description: 'unbalanced atomicity probe',
      effectiveDate: '2026-07-02',
      postings: [
        { ledgerAccountId: SEED.ledgerAccounts.alphaGroceries, amountMinor: '5000', currency: 'USD' },
        { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '-4999', currency: 'USD' },
      ],
    });
    const res = await callFunction('/api/commands', { headers: alexHeaders, body: env });
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe('unbalanced_batch');

    expect(await counts()).toEqual(before);
  });
});

describe('money wire format — test 2', () => {
  it('rejects numeric amounts at the boundary', async () => {
    const env = envelope('journal.post_batch', SEED.households.alpha, SEED.users.alex.id, {
      description: 'float smuggling',
      effectiveDate: '2026-07-02',
      postings: [
        { ledgerAccountId: SEED.ledgerAccounts.alphaGroceries, amountMinor: 87.42, currency: 'USD' },
        { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: -87.42, currency: 'USD' },
      ],
    });
    const res = await callFunction('/api/commands', { headers: alexHeaders, body: env });
    expect(res.status).toBe(400);
  });

  it('trial balance returns balances as strings', async () => {
    const res = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'ledger.trial_balance', householdId: SEED.households.alpha },
    });
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: Array<{ balanceMinor: unknown }> }).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.balanceMinor).toBe('string');
    }
  });
});
