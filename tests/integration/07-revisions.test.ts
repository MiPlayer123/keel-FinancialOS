/**
 * TASK-000 test 4 end-to-end: a revision/reversal preserves the original
 * record; reversing twice is refused; audit trail captures both.
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

describe('journal.reverse_batch (test 4)', () => {
  it('reversal preserves the original and nets to zero', async () => {
    const post = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope('journal.post_batch', SEED.households.alpha, SEED.users.alex.id, {
        description: 'to be reversed',
        effectiveDate: '2026-07-04',
        postings: [
          { ledgerAccountId: SEED.ledgerAccounts.alphaGroceries, amountMinor: '12345', currency: 'USD' },
          { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '-12345', currency: 'USD' },
        ],
      }),
    });
    expect(post.status).toBe(200);
    const batchId = (post.body as { effects: { batchId: string } }).effects.batchId;

    const svc = serviceClient();
    const originalBefore = await svc.from('journal_postings').select('*').eq('batch_id', batchId);

    const reverse = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope('journal.reverse_batch', SEED.households.alpha, SEED.users.alex.id, {
        batchId,
        reason: 'integration reversal test',
      }),
    });
    expect(reverse.status).toBe(200);
    const reversalId = (reverse.body as { effects: { reversalBatchId: string } }).effects
      .reversalBatchId;

    // Original postings are byte-identical after the reversal.
    const originalAfter = await svc.from('journal_postings').select('*').eq('batch_id', batchId);
    expect(originalAfter.data).toEqual(originalBefore.data);

    // Original + reversal sum to zero per account.
    const { data: reversalPostings } = await svc
      .from('journal_postings')
      .select('ledger_account_id, amount_minor')
      .eq('batch_id', reversalId);
    const byAccount = new Map<string, bigint>();
    for (const p of [...(originalAfter.data ?? []), ...(reversalPostings ?? [])]) {
      byAccount.set(
        p.ledger_account_id,
        (byAccount.get(p.ledger_account_id) ?? 0n) + BigInt(p.amount_minor),
      );
    }
    for (const [, sum] of byAccount) expect(sum).toBe(0n);

    // Revision lineage recorded.
    const { data: revision } = await svc
      .from('journal_revisions')
      .select('reversal_batch_id, reason')
      .eq('original_batch_id', batchId)
      .single();
    expect(revision!.reversal_batch_id).toBe(reversalId);

    // Double-reversal is refused: corrections are explicit, not repeatable.
    const again = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope('journal.reverse_batch', SEED.households.alpha, SEED.users.alex.id, {
        batchId,
        reason: 'second reversal attempt',
      }),
    });
    expect(again.status).toBe(409);

    // Both mutations hit the audit log (Law 2).
    const { data: audits } = await svc
      .from('audit_log')
      .select('action')
      .in('action', ['journal.post_batch', 'journal.reverse_batch'])
      .order('id', { ascending: false })
      .limit(10);
    const actions = (audits ?? []).map((a) => a.action);
    expect(actions).toContain('journal.post_batch');
    expect(actions).toContain('journal.reverse_batch');
  });
});
