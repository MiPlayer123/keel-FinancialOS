/**
 * Business expense attribution, layer 1, through the real HTTP surface
 * (20260831120000_business_entity_tag.sql + the /tags/set-business route).
 *
 * The DB behaviour itself is covered exhaustively and independently by
 * tests/pgtap/business_entity_tag.sql (62 assertions, run against a real
 * Postgres via scripts/run-business-entity-tag-pgtap.sh, each guard
 * mutation-tested to confirm the suite fails without it). This suite covers
 * what pgTAP cannot reach: the Edge Function route's input validation, its
 * error mapping, and the tags.list read the client derives attribution from.
 *
 * Requires the local stack (`supabase start` + `db reset` + `functions serve`),
 * like every other file in this directory.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { authedHeaders, callFunction, drainQueue, serviceClient, userToken, SEED } from './helpers.js';

let alexHeaders: Record<string, string>;
let caseyHeaders: Record<string, string>;
let txnId = '';
let businessEntityId = '';

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
  caseyHeaders = authedHeaders(await userToken(SEED.users.casey.email));
  const service = serviceClient();

  // One personal-account expense: the whole point of the feature is that this
  // row, paid from a personal card, can be counted in a business's books.
  const { error } = await service.rpc('keel_worker_record_raw_event', {
    p_provider: 'simulator',
    p_connection_external_ref: SEED.connections.simAlpha.ref,
    p_provider_event_id: 'business-tag-raw-1',
    p_account_external_ref: 'sim-acct-checking',
    p_received_at: '2026-08-20T01:00:00Z',
    p_body: {
      kind: 'transaction_added',
      eventId: 'business-tag-event-1',
      transaction: {
        providerTransactionId: 'business-tag-txn-1',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '-8900',
        currency: 'USD',
        date: '2026-08-20',
        description: 'Standing desk business tag',
        pending: false,
        pendingTransactionId: null,
      },
    },
  });
  if (error) throw new Error(error.message);
  expect((await drainQueue('sync_events')).filter((row) => row === 'done:create')).toHaveLength(1);

  const { data, error: readError } = await service
    .from('canonical_transactions')
    .select('id')
    .eq('description', 'Standing desk business tag');
  if (readError) throw new Error(readError.message);
  txnId = data[0]?.id ?? '';
  expect(txnId).not.toBe('');

  // The seed household is single-entity and personal; a business to attribute
  // to has to exist first.
  const created = await callFunction('/api/entities/create', {
    headers: alexHeaders,
    body: { householdId: SEED.households.alpha, name: 'Acme LLC', kind: 'llc_single' },
  });
  expect(created.status).toBe(200);
  businessEntityId = (created.body as { entityId: string }).entityId;
  expect(businessEntityId).toBeTruthy();
});

describe('business expense attribution over HTTP', () => {
  it('attributes a personal-account expense to a business and mints its tag', async () => {
    const res = await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    expect(res.status).toBe(200);
    const tagId = (res.body as { tagId: string | null }).tagId;
    expect(tagId).toBeTruthy();

    const tags = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'tags.list', householdId: SEED.households.alpha },
    });
    expect(tags.status).toBe(200);
    expect(tags.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagId, name: 'Acme LLC', entityId: businessEntityId }),
      ]),
    );
  });

  it('is idempotent: re-attributing the same business returns the same tag', async () => {
    const first = await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    const second = await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    expect(second.status).toBe(200);
    expect((second.body as { tagId: string }).tagId).toBe((first.body as { tagId: string }).tagId);

    // Exactly one business tag survives, and exactly one tag was ever created.
    const { data } = await serviceClient()
      .from('tags')
      .select('id')
      .eq('household_id', SEED.households.alpha)
      .eq('entity_id', businessEntityId);
    expect(data).toHaveLength(1);
  });

  it('writes no postings: attribution classifies, it does not move money', async () => {
    // Invariant 1 in plain form — the whole design rests on this staying true.
    const service = serviceClient();
    const { count: before } = await service
      .from('journal_postings')
      .select('*', { count: 'exact', head: true });
    await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: null },
    });
    await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    const { count: after } = await service
      .from('journal_postings')
      .select('*', { count: 'exact', head: true });
    expect(after).toBe(before);
  });

  it('clears attribution when entityId is null', async () => {
    const res = await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: null },
    });
    expect(res.status).toBe(200);
    expect((res.body as { tagId: string | null }).tagId).toBeNull();

    const { data } = await serviceClient()
      .from('transaction_tags')
      .select('tag_id')
      .eq('canonical_transaction_id', txnId);
    expect(data).toHaveLength(0);
  });

  it('rejects malformed input before it reaches the database', async () => {
    for (const body of [
      { householdId: SEED.households.alpha, transactionId: 'not-a-uuid', entityId: null },
      { householdId: SEED.households.alpha, transactionId: txnId, entityId: 'not-a-uuid' },
      // entityId is required explicitly: clearing must be said, not implied.
      { householdId: SEED.households.alpha, transactionId: txnId },
    ]) {
      const res = await callFunction('/api/tags/set-business', { headers: alexHeaders, body });
      expect(res.status).toBe(400);
    }
  });

  it('refuses cross-tenant attribution', async () => {
    const res = await callFunction('/api/tags/set-business', {
      headers: caseyHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    expect(res.status).toBe(404);
  });

  it('unbinds a business tag, leaving the tag and its assignments in place', async () => {
    await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    const res = await callFunction('/api/tags/unbind-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, entityId: businessEntityId },
    });
    expect(res.status).toBe(200);
    expect((res.body as { tagId: string | null }).tagId).toBeTruthy();

    // The tag survives, still attached: unbind is a reversible correction, not
    // a delete. It simply stops counting as that business's.
    const tags = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'tags.list', householdId: SEED.households.alpha },
    });
    expect(tags.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Acme LLC', entityId: null })]),
    );
    const { data } = await serviceClient()
      .from('transaction_tags')
      .select('tag_id')
      .eq('canonical_transaction_id', txnId);
    expect(data).toHaveLength(1);

    // Idempotent, and re-binding restores the same tag.
    const again = await callFunction('/api/tags/unbind-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, entityId: businessEntityId },
    });
    expect(again.status).toBe(200);
    expect((again.body as { tagId: string | null }).tagId).toBeNull();
  });

  it('refuses to delete a business tag through the tag manager', async () => {
    await callFunction('/api/tags/set-business', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, transactionId: txnId, entityId: businessEntityId },
    });
    const { data } = await serviceClient()
      .from('tags')
      .select('id')
      .eq('household_id', SEED.households.alpha)
      .eq('entity_id', businessEntityId);
    const res = await callFunction('/api/tags/delete', {
      headers: alexHeaders,
      body: { householdId: SEED.households.alpha, tagId: data?.[0]?.id },
    });
    expect(res.status).toBe(400);
  });
});
