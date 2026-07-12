import { beforeAll, describe, expect, it } from 'vitest';
import { authedHeaders, callFunction, drainQueue, envelope, serviceClient, userToken, SEED } from './helpers.js';

let alex: Record<string, string>;
let casey: Record<string, string>;
let txnId = '';
let statementId = '';
let lineId = '';
let sessionId = '';
let closeRequest: Record<string, unknown>;
let ledgerEndingMinor = 0n;

beforeAll(async () => {
  alex = authedHeaders(await userToken(SEED.users.alex.email));
  casey = authedHeaders(await userToken(SEED.users.casey.email));
  const svc = serviceClient();
  const { error } = await svc.rpc('keel_worker_record_raw_event', {
    p_provider: 'simulator',
    p_connection_external_ref: SEED.connections.simAlpha.ref,
    p_provider_event_id: 'statement-raw-1',
    p_account_external_ref: 'sim-acct-checking',
    p_received_at: '2026-07-12T01:00:00Z',
    p_body: {
      kind: 'transaction_added',
      eventId: 'statement-event-1',
      transaction: {
        providerTransactionId: 'statement-txn-1',
        accountExternalRef: 'sim-acct-checking',
        amountMinor: '120',
        currency: 'USD',
        date: '2026-06-15',
        description: 'Statement close deposit',
        pending: false,
        pendingTransactionId: null,
      },
    },
  });
  if (error) throw new Error(error.message);
  expect(await drainQueue('sync_events')).toContain('done:create');

  const { data: txn, error: txnError } = await svc
    .from('canonical_transactions')
    .select('id')
    .eq('description', 'Statement close deposit')
    .single();
  if (txnError) throw new Error(txnError.message);
  txnId = txn.id as string;

  // Earlier integration suites intentionally create large ledger values. Read
  // the canonical export, whose bigint fields are strings, so this close test
  // remains deterministic and never routes minor units through JS Number.
  const { data: exported, error: exportError } = await svc.rpc('keel_export_household', {
    p_household_id: SEED.households.alpha,
  });
  if (exportError) throw new Error(exportError.message);
  const tables = (exported as {
    tables: {
      journal_batches: { id: string; household_id: string; effective_date: string }[];
      journal_postings: { batch_id: string; ledger_account_id: string; amount_minor: string }[];
    };
  }).tables;
  const eligibleBatches = new Set(
    tables.journal_batches
      .filter((batch) => batch.household_id === SEED.households.alpha && batch.effective_date <= '2026-06-30')
      .map((batch) => batch.id),
  );
  ledgerEndingMinor = tables.journal_postings
    .filter(
      (posting) =>
        posting.ledger_account_id === SEED.ledgerAccounts.alphaChecking && eligibleBatches.has(posting.batch_id),
    )
    .reduce((sum, posting) => sum + BigInt(posting.amount_minor), 0n);
});

describe('statement close vertical slice', () => {
  it('captures immutable independent statement evidence and replays', async () => {
    const request = envelope(
      'statements.create',
      SEED.households.alpha,
      SEED.users.alex.id,
      {
        accountId: SEED.accounts.alphaChecking,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        openingMinor: (ledgerEndingMinor - 120n).toString(),
        endingMinor: ledgerEndingMinor.toString(),
        currency: 'USD',
        sourceHash: 'd'.repeat(64),
        lines: [
          {
            lineKey: 'deposit',
            date: '2026-06-15',
            amountMinor: '120',
            description: 'statement deposit',
          },
        ],
      },
      'statement',
    );
    const created = await callFunction('/api/commands', { headers: alex, body: request });
    expect(created.status).toBe(200);
    statementId = (created.body as { effects: { statementId: string } }).effects.statementId;
    expect(
      (await callFunction('/api/commands', { headers: alex, body: request }).then((response) => response.body) as {
        idempotentReplay: boolean;
      }).idempotentReplay,
    ).toBe(true);
    const list = await callFunction('/api/queries', {
      headers: alex,
      body: { query: 'statements.list', householdId: SEED.households.alpha },
    });
    lineId = (list.body as { rows: { lines: { lineId: string }[] }[] }).rows[0]!.lines[0]!.lineId;
  });

  it('closes only with every difference explained and locks history', async () => {
    const bad = await callFunction('/api/commands', {
      headers: alex,
      body: envelope(
        'reconciliations.close',
        SEED.households.alpha,
        SEED.users.alex.id,
        {
          statementId,
          items: [{ lineId, resolution: 'matched_transaction', transactionId: txnId, explanation: 'matched' }],
          adjustments: [{ kind: 'stale_balance', amountMinor: '1', explanation: 'wrong' }],
        },
        'bad-close',
      ),
    });
    expect(bad.status).toBe(400);
    closeRequest = envelope(
      'reconciliations.close',
      SEED.households.alpha,
      SEED.users.alex.id,
      {
        statementId,
        items: [{ lineId, resolution: 'matched_transaction', transactionId: txnId, explanation: 'matched' }],
        adjustments: [],
      },
      'close',
    );
    const closed = await callFunction('/api/commands', { headers: alex, body: closeRequest });
    expect(closed.status).toBe(200);
    sessionId = (closed.body as { effects: { sessionId: string } }).effects.sessionId;
    expect((closed.body as { effects: { differenceMinor: string } }).effects.differenceMinor).toBe('0');
    expect(
      (await callFunction('/api/commands', { headers: alex, body: closeRequest }).then((response) => response.body) as {
        idempotentReplay: boolean;
      }).idempotentReplay,
    ).toBe(true);
    const locked = await callFunction('/api/commands', {
      headers: alex,
      body: envelope(
        'journal.post_batch',
        SEED.households.alpha,
        SEED.users.alex.id,
        {
          description: 'locked mutation',
          effectiveDate: '2026-06-20',
          postings: [
            { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '1', currency: 'USD' },
            { ledgerAccountId: '00000000-0000-4000-8000-00000000a318', amountMinor: '-1', currency: 'USD' },
          ],
        },
        'locked',
      ),
    });
    expect(locked.status).toBe(423);
  });

  it('returns 404 cross-tenant and reopens with reason before allowing correction', async () => {
    expect(
      (
        await callFunction('/api/queries', {
          headers: casey,
          body: { query: 'statements.list', householdId: SEED.households.alpha },
        })
      ).status,
    ).toBe(404);
    const reopened = await callFunction('/api/commands', {
      headers: alex,
      body: envelope(
        'reconciliations.reopen',
        SEED.households.alpha,
        SEED.users.alex.id,
        { sessionId, reason: 'statement correction' },
        'reopen',
      ),
    });
    expect(reopened.status).toBe(200);
    const allowed = await callFunction('/api/commands', {
      headers: alex,
      body: envelope(
        'journal.post_batch',
        SEED.households.alpha,
        SEED.users.alex.id,
        {
          description: 'reopened mutation',
          effectiveDate: '2026-06-20',
          postings: [
            { ledgerAccountId: SEED.ledgerAccounts.alphaChecking, amountMinor: '1', currency: 'USD' },
            { ledgerAccountId: '00000000-0000-4000-8000-00000000a318', amountMinor: '-1', currency: 'USD' },
          ],
        },
        'reopened',
      ),
    });
    expect(allowed.status).toBe(200);
    const { data } = await serviceClient()
      .from('audit_log')
      .select('before,after')
      .eq('action', 'reconciliations.reopen')
      .eq('object_id', sessionId)
      .single();
    expect(data?.before).toBeTruthy();
    expect(data?.after).toBeTruthy();
  });
});
