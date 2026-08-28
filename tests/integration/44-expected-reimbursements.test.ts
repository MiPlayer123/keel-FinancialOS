/**
 * Expected (future-dated / pending) reimbursements — an accounts-receivable
 * line tracked BEFORE the money arrives (migration 20260723000000). Proves:
 * create standalone + from an expense; a partial receipt leaves a remainder;
 * a second receipt settles it to received; a never-arrives expectation is
 * written off then reopened; a receipt is reversed; and none of it writes a
 * single journal posting (no fake income — Law 2/9). Cross-tenant reads 404.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { authedHeaders, callFunction, drainQueue, envelope, serviceClient, userToken, SEED } from './helpers.js';

let alexHeaders: Record<string, string>;
let caseyHeaders: Record<string, string>;
let expenseTxn = '';
let inbound1 = '';
let inbound2 = '';
let standaloneId = '';
let fromExpenseId = '';
let receipt1Id = '';

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
  caseyHeaders = authedHeaders(await userToken(SEED.users.casey.email));
  const service = serviceClient();
  for (const [ordinal, amountMinor, description] of [
    [1, '-15000', 'Cruise tickets expected slice'],
    [2, '5000', 'Partial payback expected slice'],
    [3, '10000', 'Final payback expected slice'],
  ] as const) {
    const { error } = await service.rpc('keel_worker_record_raw_event', {
      p_provider: 'simulator',
      p_connection_external_ref: SEED.connections.simAlpha.ref,
      p_provider_event_id: `expected-raw-${ordinal.toString()}`,
      p_account_external_ref: 'sim-acct-checking',
      p_received_at: `2026-07-20T0${ordinal.toString()}:00:00Z`,
      p_body: {
        kind: 'transaction_added',
        eventId: `expected-event-${ordinal.toString()}`,
        transaction: {
          providerTransactionId: `expected-txn-${ordinal.toString()}`,
          accountExternalRef: 'sim-acct-checking',
          amountMinor,
          currency: 'USD',
          date: `2026-07-0${ordinal.toString()}`,
          description,
          pending: false,
          pendingTransactionId: null,
        },
      },
    });
    if (error) throw new Error(error.message);
  }
  expect((await drainQueue('sync_events')).filter((row) => row === 'done:create')).toHaveLength(3);
  const { data, error } = await service
    .from('canonical_transactions')
    .select('id,description')
    .in('description', [
      'Cruise tickets expected slice',
      'Partial payback expected slice',
      'Final payback expected slice',
    ]);
  if (error) throw new Error(error.message);
  expenseTxn = data.find((r) => r.description === 'Cruise tickets expected slice')?.id ?? '';
  inbound1 = data.find((r) => r.description === 'Partial payback expected slice')?.id ?? '';
  inbound2 = data.find((r) => r.description === 'Final payback expected slice')?.id ?? '';
  expect(expenseTxn && inbound1 && inbound2).toBeTruthy();
});

describe('expected reimbursement vertical slice', () => {
  it('creates a standalone expectation (no source expense) and replays idempotently', async () => {
    const request = envelope(
      'expected_reimbursements.create',
      SEED.households.alpha,
      SEED.users.alex.id,
      {
        counterpartyName: 'Leo',
        kind: 'friend',
        amountMinor: '15000',
        currency: 'USD',
        expectedDate: '2026-07-24',
        description: 'Cruise tickets — Leo owes me back',
      },
      'expected-standalone',
    );
    const created = await callFunction('/api/commands', { headers: alexHeaders, body: request });
    expect(created.status).toBe(200);
    const effects = (created.body as { effects: { expectedId: string; remainingMinor: string; status: string } }).effects;
    standaloneId = effects.expectedId;
    expect(effects.remainingMinor).toBe('15000');
    expect(effects.status).toBe('open');
    const replay = await callFunction('/api/commands', { headers: alexHeaders, body: request });
    expect((replay.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
  });

  it('creates an expectation carved from an existing expense (capped at the expense)', async () => {
    const created = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.create',
        SEED.households.alpha,
        SEED.users.alex.id,
        {
          counterpartyName: 'Leo',
          kind: 'friend',
          amountMinor: '15000',
          currency: 'USD',
          expectedDate: '2026-07-24',
          description: 'from the cruise expense',
          sourceTransactionId: expenseTxn,
        },
        'expected-from-expense',
      ),
    });
    expect(created.status).toBe(200);
    fromExpenseId = (created.body as { effects: { expectedId: string } }).effects.expectedId;
    // carving more than the source expense is rejected
    const tooBig = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.create',
        SEED.households.alpha,
        SEED.users.alex.id,
        { counterpartyName: 'Leo', kind: 'friend', amountMinor: '20000', currency: 'USD', expectedDate: '2026-07-24', description: 'too big', sourceTransactionId: expenseTxn },
        'expected-too-big',
      ),
    });
    expect(tooBig.status).toBe(400);
  });

  it('records a partial receipt (remainder stays open) then a full one (received) — no postings', async () => {
    const service = serviceClient();
    const { count: before } = await service.from('journal_postings').select('*', { count: 'exact', head: true });

    const partial = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.record_receipt',
        SEED.households.alpha,
        SEED.users.alex.id,
        { expectedId: standaloneId, transactionId: inbound1, amountMinor: '5000', note: 'Venmo part 1' },
        'expected-receipt-1',
      ),
    });
    expect(partial.status).toBe(200);
    const partialEffects = (partial.body as { effects: { receiptId: string; remainingMinor: string; status: string } }).effects;
    receipt1Id = partialEffects.receiptId;
    expect(partialEffects.remainingMinor).toBe('10000');
    expect(partialEffects.status).toBe('open');

    const full = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.record_receipt',
        SEED.households.alpha,
        SEED.users.alex.id,
        { expectedId: standaloneId, transactionId: inbound2, amountMinor: '10000', note: 'Venmo part 2' },
        'expected-receipt-2',
      ),
    });
    expect(full.status).toBe(200);
    expect((full.body as { effects: { remainingMinor: string; status: string } }).effects).toMatchObject({ remainingMinor: '0', status: 'received' });

    const { count: after } = await service.from('journal_postings').select('*', { count: 'exact', head: true });
    expect(after).toBe(before);

    const list = await callFunction('/api/queries', { headers: alexHeaders, body: { query: 'expected_reimbursements.list', householdId: SEED.households.alpha } });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ formulaVersion: 'expected-reimbursement-v1' });
    const rows = (list.body as { rows: { expectedId: string; status: string; remainingMinor: string; incomeImpactMinor: string }[] }).rows;
    expect(rows.find((r) => r.expectedId === standaloneId)).toMatchObject({ status: 'received', remainingMinor: '0', incomeImpactMinor: '0' });
  });

  it('reverses a receipt — the settled expectation reopens with the remainder restored', async () => {
    const reversed = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.reverse_receipt',
        SEED.households.alpha,
        SEED.users.alex.id,
        { receiptId: receipt1Id, reason: 'wrong deposit' },
        'expected-reverse-receipt',
      ),
    });
    expect(reversed.status).toBe(200);
    expect((reversed.body as { effects: { status: string; remainingMinor: string } }).effects).toMatchObject({ status: 'reversed', remainingMinor: '5000' });
  });

  it('writes off a never-arrives expectation, then reopens it (reversible remainder)', async () => {
    const writeOff = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.write_off',
        SEED.households.alpha,
        SEED.users.alex.id,
        { expectedId: fromExpenseId, reason: 'Leo never paid' },
        'expected-write-off',
      ),
    });
    expect(writeOff.status).toBe(200);
    expect((writeOff.body as { effects: { status: string } }).effects.status).toBe('written_off');

    const reopen = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: envelope(
        'expected_reimbursements.reopen',
        SEED.households.alpha,
        SEED.users.alex.id,
        { expectedId: fromExpenseId, reason: 'he says it is coming' },
        'expected-reopen',
      ),
    });
    expect(reopen.status).toBe(200);
    expect((reopen.body as { effects: { status: string; remainingMinor: string } }).effects).toMatchObject({ status: 'open', remainingMinor: '15000' });
  });

  it('audits every mutation append-only and never books income', async () => {
    const { data: audits } = await serviceClient()
      .from('audit_log')
      .select('action')
      .in('object_id', [standaloneId, fromExpenseId, receipt1Id]);
    expect(audits?.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'expected_reimbursements.create',
        'expected_reimbursements.record_receipt',
        'expected_reimbursements.reverse_receipt',
        'expected_reimbursements.write_off',
        'expected_reimbursements.reopen',
      ]),
    );
  });

  it('returns 404 for cross-tenant reads and reference smuggling', async () => {
    const read = await callFunction('/api/queries', { headers: caseyHeaders, body: { query: 'expected_reimbursements.list', householdId: SEED.households.alpha } });
    expect(read.status).toBe(404);
    const smuggle = await callFunction('/api/commands', {
      headers: caseyHeaders,
      body: envelope(
        'expected_reimbursements.create',
        SEED.households.beta,
        SEED.users.casey.id,
        { counterpartyName: 'Leo', kind: 'friend', amountMinor: '1', currency: 'USD', expectedDate: '2026-07-24', description: 'smuggle', sourceTransactionId: expenseTxn },
        'expected-smuggle',
      ),
    });
    expect(smuggle.status).toBe(404);
  });
});
