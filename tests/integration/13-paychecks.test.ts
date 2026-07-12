/** Stage 1D gate 6: gross-to-net paycheck and destination reconciliation. */
import { beforeAll, describe, expect, it } from 'vitest';
import { authedHeaders, callFunction, drainQueue, envelope, serviceClient, userToken, SEED } from './helpers.js';

let alexHeaders: Record<string,string>;
let caseyHeaders: Record<string,string>;
let paycheckId: string;
let createEnvelope: Record<string,unknown>;

let depositTxn: string;
let retirementTxn: string;

beforeAll(async () => {
  alexHeaders = authedHeaders(await userToken(SEED.users.alex.email));
  caseyHeaders = authedHeaders(await userToken(SEED.users.casey.email));
  const service = serviceClient();
  for (const [ordinal,amountMinor,description] of [
    [1,'70000','Payroll direct deposit'], [2,'15000','Payroll retirement destination'],
  ] as const) {
    const { error } = await service.rpc('keel_worker_record_raw_event', {
      p_provider:'simulator', p_connection_external_ref:SEED.connections.simAlpha.ref,
      p_provider_event_id:`paycheck-raw-${ordinal.toString()}`, p_account_external_ref:'sim-acct-checking',
      p_received_at:`2026-07-12T0${ordinal.toString()}:00:00Z`,
      p_body:{ kind:'transaction_added',eventId:`paycheck-event-${ordinal.toString()}`,transaction:{
        providerTransactionId:`paycheck-txn-${ordinal.toString()}`,accountExternalRef:'sim-acct-checking',
        amountMinor,currency:'USD',date:'2026-07-12',description,pending:false,pendingTransactionId:null,
      } },
    });
    if (error) throw new Error(error.message);
  }
  expect((await drainQueue('sync_events')).filter((row) => row === 'done:create')).toHaveLength(2);
  const { data: promoted, error: promotedError } = await service.from('canonical_transactions')
    .select('id,description').in('description',['Payroll direct deposit','Payroll retirement destination']);
  if (promotedError) throw new Error(promotedError.message);
  depositTxn = promoted.find((row) => row.description === 'Payroll direct deposit')?.id ?? '';
  retirementTxn = promoted.find((row) => row.description === 'Payroll retirement destination')?.id ?? '';
  expect(depositTxn).not.toBe(''); expect(retirementTxn).not.toBe('');
  createEnvelope = envelope('paychecks.create', SEED.households.alpha, SEED.users.alex.id, {
    employerName: 'Keel Labs', payDate: '2026-07-12', grossMinor: '100000', netMinor: '70000', currency: 'USD',
    components: [
      { key: 'salary', kind: 'gross_salary', amountMinor: '100000' },
      { key: 'federal', kind: 'federal_withholding', amountMinor: '20000' },
      { key: '401k', kind: 'retirement_401k', amountMinor: '10000' },
      { key: 'match', kind: 'employer_match', amountMinor: '5000' },
      { key: 'deposit', kind: 'direct_deposit', amountMinor: '70000' },
    ],
    matches: [
      { transactionId: depositTxn, componentKey: 'deposit', amountMinor: '70000' },
      { transactionId: retirementTxn, componentKey: '401k', amountMinor: '10000' },
      { transactionId: retirementTxn, componentKey: 'match', amountMinor: '5000' },
    ],
    source: { kind: 'paystub', ref: 'stub-2026-07-12', contentHash: 'a'.repeat(64) },
  }, 'paycheck-create');
});

describe('paycheck vertical slice', () => {
  it('creates one reconciled paycheck and replays idempotently', async () => {
    const created = await callFunction('/api/commands', { headers: alexHeaders, body: createEnvelope });
    expect(created.status).toBe(200);
    paycheckId = (created.body as { effects: { paycheckId: string } }).effects.paycheckId;
    const replay = await callFunction('/api/commands', { headers: alexHeaders, body: createEnvelope });
    expect(replay.status).toBe(200);
    expect((replay.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    const { count } = await serviceClient().from('paychecks').select('*',{ count:'exact',head:true })
      .eq('household_id',SEED.households.alpha);
    expect(count).toBe(1);
  });

  it('returns exact reproducible decomposition and blocks cross-tenant references as 404', async () => {
    const list = await callFunction('/api/queries', { headers: alexHeaders,
      body: { query:'paychecks.list',householdId:SEED.households.alpha } });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ formulaVersion:'paycheck-reconciliation-v1', rows:[{
      paycheckId, grossMinor:'100000', netMinor:'70000', status:'active',
    }] });
    const probe = await callFunction('/api/queries', { headers: caseyHeaders,
      body: { query:'paychecks.list',householdId:SEED.households.alpha } });
    expect(probe.status).toBe(404);
    const smuggle = structuredClone(createEnvelope);
    smuggle['commandId'] = crypto.randomUUID(); smuggle['economicEventKey'] = 'itest:paycheck:smuggle';
    smuggle['householdId'] = SEED.households.beta;
    smuggle['actor'] = { kind:'user',userId:SEED.users.casey.id };
    const rejected = await callFunction('/api/commands', { headers: caseyHeaders, body: smuggle });
    expect(rejected.status).toBe(404);
  });

  it('rejects a gross-to-net mismatch without persisting partial rows', async () => {
    const invalid = structuredClone(createEnvelope);
    invalid['commandId'] = crypto.randomUUID(); invalid['economicEventKey'] = 'itest:paycheck:invalid-net';
    (invalid['payload'] as Record<string,unknown>)['netMinor'] = '70001';
    ((invalid['payload'] as Record<string,unknown>)['source'] as Record<string,unknown>)['ref'] = 'invalid-net';
    const response = await callFunction('/api/commands', { headers: alexHeaders, body: invalid });
    expect(response.status).toBe(400);
    const { count } = await serviceClient().from('paychecks').select('*',{ count:'exact',head:true })
      .eq('household_id',SEED.households.alpha);
    expect(count).toBe(1);
  });

  it('reverses and restores through audited append-only correction events', async () => {
    for (const [command,reason,status] of [
      ['paychecks.reverse','duplicate paystub','reversed'],
      ['paychecks.restore','verified original','active'],
    ] as const) {
      const response = await callFunction('/api/commands', { headers: alexHeaders, body: envelope(
        command,SEED.households.alpha,SEED.users.alex.id,{ paycheckId,reason },command,
      ) });
      expect(response.status).toBe(200);
      expect((response.body as { effects:{status:string} }).effects.status).toBe(status);
    }
    const { data: events } = await serviceClient().from('paycheck_status_events').select('transition')
      .eq('paycheck_id',paycheckId).order('created_at');
    expect(events?.map((row) => row.transition)).toEqual(['created','reversed','restored']);
    const { data: audits } = await serviceClient().from('audit_log').select('action,before,after').eq('object_id',paycheckId);
    expect(audits?.map((row) => row.action)).toEqual(expect.arrayContaining([
      'paychecks.create','paychecks.reverse','paychecks.restore',
    ]));
    expect(audits?.filter((row) => row.action !== 'paychecks.create').every((row) => row.before && row.after)).toBe(true);
  });
});
