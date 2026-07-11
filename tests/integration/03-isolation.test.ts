/**
 * TASK-000 test 5 + 6: cross-household access fails through API, SQL/RLS,
 * and query services (PLAN §3.6.10); canonical tables reject direct
 * authenticated-client writes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  callFunction,
  envelope,
  signIn,
  userToken,
  authedHeaders,
  SEED,
} from './helpers.js';

let caseyHeaders: Record<string, string>;

beforeAll(async () => {
  caseyHeaders = authedHeaders(await userToken(SEED.users.casey.email));
});

describe('query services fail closed (test 5)', () => {
  it('casey (beta) probing alpha trial balance learns nothing', async () => {
    const res = await callFunction('/api/queries', {
      headers: caseyHeaders,
      body: { query: 'ledger.trial_balance', householdId: SEED.households.alpha },
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('balanceMinor');
  });

  it('casey probing alpha transactions learns nothing', async () => {
    const res = await callFunction('/api/queries', {
      headers: caseyHeaders,
      body: { query: 'transactions.list', householdId: SEED.households.alpha },
    });
    expect(res.status).toBe(404);
  });

  it('viewer role can read but not write (role lattice end-to-end)', async () => {
    // alex is a VIEWER in beta: reads pass, writes are denied.
    const alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
    const read = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'transactions.list', householdId: SEED.households.beta },
    });
    expect(read.status).toBe(200);

    const write = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope('journal.post_batch', SEED.households.beta, SEED.users.alex.id, {
        description: 'viewer write attempt',
        effectiveDate: '2026-07-02',
        postings: [
          { ledgerAccountId: SEED.ledgerAccounts.alphaGroceries, amountMinor: '100', currency: 'USD' },
          { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '-100', currency: 'USD' },
        ],
      }),
    });
    expect(write.status).toBe(403);
  });
});

describe('API command scope (test 5)', () => {
  it('casey cannot post into alpha — answered as not_found, no existence leak', async () => {
    const res = await callFunction('/api/commands', {
      headers: caseyHeaders,
      body: envelope('journal.post_batch', SEED.households.alpha, SEED.users.casey.id, {
        description: 'cross-tenant write attempt',
        effectiveDate: '2026-07-02',
        postings: [
          { ledgerAccountId: SEED.ledgerAccounts.alphaGroceries, amountMinor: '100', currency: 'USD' },
          { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '-100', currency: 'USD' },
        ],
      }),
    });
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('not_found');
  });
});

describe('SQL/RLS reads fail closed (test 5)', () => {
  it('casey sees zero alpha rows through the publishable client', async () => {
    const casey = await signIn(SEED.users.casey.email);
    const tables = ['households', 'accounts', 'canonical_transactions', 'journal_batches'];
    for (const table of tables) {
      const { data, error } = await casey
        .from(table)
        .select('id')
        .eq(table === 'households' ? 'id' : 'household_id', SEED.households.alpha);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });
});

describe('direct client writes rejected (test 6)', () => {
  it('authenticated users cannot write canonical tables even in their own household', async () => {
    const casey = await signIn(SEED.users.casey.email);
    const { error: insertErr } = await casey.from('canonical_transactions').insert({
      household_id: SEED.households.beta,
      entity_id: '00000000-0000-4000-8000-00000000b101',
      account_id: '00000000-0000-4000-8000-00000000b401',
      status: 'posted',
      source: 'manual',
      description: 'smuggled',
      effective_date: '2026-07-02',
      economic_event_key: 'smuggle:client:0001',
    });
    expect(insertErr).not.toBeNull();

    const { error: updateErr } = await casey
      .from('journal_postings')
      .update({ amount_minor: '999999' })
      .eq('batch_id', '00000000-0000-4000-8000-000000000000');
    expect(updateErr).not.toBeNull();
  });
});
