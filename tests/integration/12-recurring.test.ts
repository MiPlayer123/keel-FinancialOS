/** Stage 1D gate 5: ledger-backed suggestion → explicit approval → replay. */
import { beforeAll, describe, expect, it } from 'vitest';
import { backtest, type RecurringSeries, type RecurringTransaction } from '@keel/detectors';
import {
  authedHeaders,
  callFunction,
  drainQueue,
  envelope,
  serviceClient,
  userToken,
  SEED,
} from './helpers.js';

let alexHeaders: Record<string, string>;
let caseyHeaders: Record<string, string>;
interface ListedRecurringSeries extends RecurringSeries {
  readonly seriesId: string;
  readonly candidateVersionId: string;
  readonly occurrences: readonly {
    readonly expectedDate: string;
    readonly expectedAmountMinor: string;
    readonly status: 'expected' | 'matched' | 'skipped' | 'unexpected' | 'paused' | 'cancelled';
  }[];
}

let candidate: ListedRecurringSeries;

const simulatorEvent = (ordinal: number, date: string): Record<string, unknown> => ({
  kind: 'transaction_added',
  eventId: `recurring-rent-event-${ordinal}`,
  transaction: {
    providerTransactionId: `recurring-rent-txn-${ordinal}`,
    accountExternalRef: 'sim-acct-checking',
    amountMinor: '-250000',
    currency: 'USD',
    date,
    description: 'Monthly Rent Store #0042',
    pending: false,
    pendingTransactionId: null,
  },
});

const recurringCommand = (
  command: 'recurring.confirm' | 'recurring.pause' | 'recurring.resume' | 'recurring.cancel',
  effectiveDate: string,
): Record<string, unknown> => envelope(
  command,
  SEED.households.alpha,
  SEED.users.alex.id,
  {
    seriesId: candidate.seriesId,
    effectiveDate,
    ...(command === 'recurring.confirm' || command === 'recurring.resume'
      ? { horizonDays: 120 }
      : {}),
  },
  command.replace('.', '-'),
);

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
  caseyHeaders = authedHeaders(await userToken(SEED.users.casey.email));
  const service = serviceClient();

  for (const [index, date] of ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'].entries()) {
    const { error } = await service.rpc('keel_worker_record_raw_event', {
      p_provider: 'simulator',
      p_connection_external_ref: SEED.connections.simAlpha.ref,
      p_provider_event_id: `recurring-rent-raw-${index + 1}`,
      p_account_external_ref: 'sim-acct-checking',
      p_body: simulatorEvent(index + 1, date),
      p_received_at: `2026-07-12T0${index}:00:00Z`,
    });
    if (error) throw new Error(error.message);
  }
  const syncOutcomes = await drainQueue('sync_events');
  expect(syncOutcomes.filter((item) => item === 'done:create')).toHaveLength(4);

  const { data: enqueued, error: enqueueError } = await service.rpc(
    'keel_cron_enqueue_recurring_detection',
    { p_min_interval_seconds: 3601 },
  );
  if (enqueueError) throw new Error(enqueueError.message);
  expect(Number(enqueued)).toBeGreaterThan(0);
  expect(await drainQueue('recurring_detection')).toContain('done:recurring candidates: 1');
});

describe('suggest-only detector worker', () => {
  it('creates evidence-bearing suggested candidate and no occurrence before approval', async () => {
    const response = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'recurring.list', householdId: SEED.households.alpha },
    });
    expect(response.status).toBe(200);
    const rows = (response.body as { rows: ListedRecurringSeries[] }).rows;
    candidate = rows.find((row) => row.counterpartyKey === 'monthly rent')!;
    expect(candidate).toBeTruthy();
    expect(candidate).toMatchObject({
      status: 'suggested',
      cadence: 'monthly',
      amountKind: 'fixed',
      representativeAmountMinor: '-250000',
      requiresApproval: true,
      detectorVersion: 'recurring-grid-v1',
      confidenceVersion: 'recurring-score-bps-v1',
      occurrences: [],
    });
    // as_of is the enqueue proc's idempotency BUCKET start
    // (floor(epoch/3601)*3601 — keel_cron_enqueue_recurring_detection), not
    // wall-clock "today": in the first ~hour after midnight UTC the bucket
    // starts on the previous date. Asserting equality with the runner's
    // clock made CI red only between 00:00 and ~01:00 UTC (found the hard
    // way). Accept today or yesterday in UTC.
    {
      const now = Date.now();
      const utcDates = [now, now - 24 * 3600 * 1000].map((t) =>
        new Date(t).toISOString().slice(0, 10),
      );
      expect(utcDates).toContain(candidate.asOf);
    }
    expect(candidate.evidence).toHaveLength(4);
    expect(Number.isInteger(candidate.scoreBps)).toBe(true);
    expect(candidate.candidateVersionHash).toMatch(/^[a-f0-9]{64}$/u);

    const service = serviceClient();
    const { count } = await service.from('recurring_occurrences')
      .select('*', { count: 'exact', head: true })
      .eq('household_id', SEED.households.alpha);
    expect(count).toBe(0);
  });

  it('does not expose alpha candidates to beta and rejects cross-tenant reference smuggling', async () => {
    const betaList = await callFunction('/api/queries', {
      headers: caseyHeaders,
      body: { query: 'recurring.list', householdId: SEED.households.beta },
    });
    expect(betaList.status).toBe(200);
    expect((betaList.body as { rows: unknown[] }).rows).toEqual([]);

    const smuggle = await callFunction('/api/commands', {
      headers: caseyHeaders,
      body: {
        ...recurringCommand('recurring.confirm', '2026-07-12'),
        householdId: SEED.households.beta,
        actor: { kind: 'user', userId: SEED.users.casey.id },
      },
    });
    expect(smuggle.status).toBe(404);

    const service = serviceClient();
    const { error } = await service.rpc('keel_recurring_upsert_candidates', {
      p_household_id: SEED.households.beta,
      p_run_key: 'itest:recurring:smuggle:beta',
      // Match the candidate's OWN derivation date so the metadata-mismatch
      // guard (P0009) can't fire before the tenant check under test (P0006).
      p_as_of: `${candidate.asOf}T12:00:00Z`,
      p_detector_version: candidate.detectorVersion,
      p_confidence_version: candidate.confidenceVersion,
      p_normalizer_version: candidate.normalizerVersion,
      p_candidates: [{ ...candidate, seriesKey: 'smuggled-alpha-account' }],
    });
    expect(error?.code).toBe('P0006');
  });
});

describe('approve and replay user-owned timeline', () => {
  it('maps impossible civil dates and caller occurrence DTOs to invalid_command', async () => {
    const impossibleDate = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: recurringCommand('recurring.confirm', '2026-99-99'),
    });
    expect(impossibleDate.status).toBe(400);
    expect(impossibleDate.body).toMatchObject({ code: 'invalid_command' });

    const forgedProjection = recurringCommand('recurring.confirm', '2026-07-12');
    (forgedProjection['payload'] as Record<string, unknown>)['occurrences'] = [{
      expectedDate: '2099-12-31', expectedAmountMinor: '999999999',
    }];
    const forged = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: forgedProjection,
    });
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({ code: 'invalid_command' });
  });

  it('confirms the locked candidate and atomically creates evidence-bearing occurrences', async () => {
    const response = await callFunction('/api/commands', {
      headers: alexHeaders,
      body: recurringCommand('recurring.confirm', '2026-07-12'),
    });
    expect(response.status).toBe(200);
    expect((response.body as { effects: { status: string } }).effects.status).toBe('confirmed');

    const list = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'recurring.list', householdId: SEED.households.alpha },
    });
    candidate = (list.body as { rows: ListedRecurringSeries[] }).rows
      .find((row) => row.seriesId === candidate.seriesId)!;
    expect(candidate.status).toBe('confirmed');
    expect(candidate.occurrences.map((row) => row.expectedDate)).toEqual([
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31',
    ]);
    expect(candidate.occurrences.every((row) => row.expectedAmountMinor === '-250000')).toBe(true);
  });

  it('pauses, resumes, cancels, and replays the effective-date timeline deterministically', async () => {
    for (const [command, date] of [
      ['recurring.pause', '2026-08-01'],
      ['recurring.resume', '2026-09-01'],
      ['recurring.cancel', '2026-10-01'],
    ] as const) {
      const response = await callFunction('/api/commands', {
        headers: alexHeaders,
        body: recurringCommand(command, date),
      });
      expect(response.status).toBe(200);
    }

    const list = await callFunction('/api/queries', {
      headers: alexHeaders,
      body: { query: 'recurring.list', householdId: SEED.households.alpha },
    });
    candidate = (list.body as { rows: ListedRecurringSeries[] }).rows
      .find((row) => row.seriesId === candidate.seriesId)!;
    expect(candidate.status).toBe('cancelled');
    expect(candidate.occurrences.map((row) => [row.expectedDate, row.status])).toEqual([
      ['2026-07-31', 'expected'],
      ['2026-08-31', 'paused'],
      ['2026-09-30', 'expected'],
      ['2026-10-31', 'cancelled'],
      ['2026-11-30', 'cancelled'],
    ]);

    const actual = (id: string, date: string): RecurringTransaction => ({
      txnId: id, batchId: `batch-${id}`, postingId: `posting-${id}`,
      accountId: candidate.accountId, ledgerAccountId: candidate.ledgerAccountId,
      effectiveDate: date, amountMinor: '-250000', currency: 'USD',
      description: 'Monthly Rent',
    });
    const replay = backtest(candidate, [
      actual('july', '2026-07-31'),
      actual('september', '2026-09-30'),
      actual('october-after-cancel', '2026-10-31'),
    ], { fromDate: '2026-07-01', toDate: '2026-11-30' });
    expect(replay.matched.map((row) => row.txnId)).toEqual(['july', 'september']);
    expect(replay.skipped).toEqual([]);
    expect(replay.unexpected.map((row) => row.txnId)).toEqual(['october-after-cancel']);

    const service = serviceClient();
    const { data: audits } = await service.from('audit_log').select('action')
      .eq('object_id', candidate.seriesId);
    expect(audits?.map((row) => row.action)).toEqual(expect.arrayContaining([
      'recurring.suggested', 'recurring.confirmed', 'recurring.paused',
      'recurring.resumed', 'recurring.cancelled',
    ]));
    const { data: meters } = await service.from('usage_events')
      .select('provider, kind, ok')
      .eq('kind', 'recurring_detection')
      .eq('household_id', SEED.households.alpha);
    expect(meters).toContainEqual({ provider: null, kind: 'recurring_detection', ok: true });
  });
});
