/** Stage 1D gate 7: expense claim → P2P settlement → reversible correction. */
import { beforeAll,describe,expect,it } from 'vitest';
import { authedHeaders,callFunction,drainQueue,envelope,serviceClient,userToken,SEED } from './helpers.js';

let alexHeaders:Record<string,string>;let caseyHeaders:Record<string,string>;
let expenseTxn='';let settlementTxn='';let claimId='';let settlementId='';let settleEnvelope:Record<string,unknown>;

beforeAll(async()=>{
 alexHeaders=authedHeaders(await userToken(SEED.users.alex.email));caseyHeaders=authedHeaders(await userToken(SEED.users.casey.email));
 const service=serviceClient();
 for(const [ordinal,amountMinor,description] of [[1,'-10000','Shared dinner gate seven'],[2,'4000','Venmo Sam gate seven']] as const){
  const {error}=await service.rpc('keel_worker_record_raw_event',{p_provider:'simulator',p_connection_external_ref:SEED.connections.simAlpha.ref,
   p_provider_event_id:`reimburse-raw-${ordinal.toString()}`,p_account_external_ref:'sim-acct-checking',p_received_at:`2026-07-12T0${ordinal.toString()}:00:00Z`,
   p_body:{kind:'transaction_added',eventId:`reimburse-event-${ordinal.toString()}`,transaction:{providerTransactionId:`reimburse-txn-${ordinal.toString()}`,
    accountExternalRef:'sim-acct-checking',amountMinor,currency:'USD',date:`2026-07-0${ordinal.toString()}`,description,pending:false,pendingTransactionId:null}}});
  if(error)throw new Error(error.message);
 }
 expect((await drainQueue('sync_events')).filter((row)=>row==='done:create')).toHaveLength(2);
 const {data,error}=await service.from('canonical_transactions').select('id,description').in('description',['Shared dinner gate seven','Venmo Sam gate seven']);
 if(error)throw new Error(error.message);expenseTxn=data.find((row)=>row.description==='Shared dinner gate seven')?.id??'';
 settlementTxn=data.find((row)=>row.description==='Venmo Sam gate seven')?.id??'';expect(expenseTxn).not.toBe('');expect(settlementTxn).not.toBe('');
});

describe('reimbursement vertical slice',()=>{
 it('creates a first-class bill-split claim and replays idempotently',async()=>{
  const request=envelope('reimbursements.create_claim',SEED.households.alpha,SEED.users.alex.id,{originalTransactionId:expenseTxn,
   counterpartyName:'Sam',kind:'friend',amountMinor:'4000',currency:'USD',description:'Sam share of dinner'},'claim');
  const created=await callFunction('/api/commands',{headers:alexHeaders,body:request});expect(created.status).toBe(200);
  claimId=(created.body as {effects:{claimId:string}}).effects.claimId;
  const replay=await callFunction('/api/commands',{headers:alexHeaders,body:request});expect(replay.status).toBe(200);
  expect((replay.body as {idempotentReplay:boolean}).idempotentReplay).toBe(true);
 });

 it('settles the claim without writing postings or reporting income',async()=>{
  const service=serviceClient();const {count:before}=await service.from('journal_postings').select('*',{count:'exact',head:true});
  settleEnvelope=envelope('reimbursements.settle',SEED.households.alpha,SEED.users.alex.id,{transactionId:settlementTxn,
   allocations:[{claimId,amountMinor:'4000'}],note:'Venmo received'},'settle');
  const settled=await callFunction('/api/commands',{headers:alexHeaders,body:settleEnvelope});expect(settled.status).toBe(200);
  settlementId=(settled.body as {effects:{settlementId:string}}).effects.settlementId;
  const replay=await callFunction('/api/commands',{headers:alexHeaders,body:settleEnvelope});expect((replay.body as {idempotentReplay:boolean}).idempotentReplay).toBe(true);
  const {count:after}=await service.from('journal_postings').select('*',{count:'exact',head:true});expect(after).toBe(before);
  const list=await callFunction('/api/queries',{headers:alexHeaders,body:{query:'reimbursements.list',householdId:SEED.households.alpha}});
  expect(list.status).toBe(200);expect(list.body).toMatchObject({formulaVersion:'claim-settlement-v1',rows:[{
   claimId,originalTransactionId:expenseTxn,amountMinor:'4000',remainingMinor:'0',status:'settled',incomeImpactMinor:'0',
  }]});
 });

 it('returns 404 for cross-tenant reads and reference smuggling',async()=>{
  const read=await callFunction('/api/queries',{headers:caseyHeaders,body:{query:'reimbursements.list',householdId:SEED.households.alpha}});expect(read.status).toBe(404);
  const smuggle=await callFunction('/api/commands',{headers:caseyHeaders,body:envelope('reimbursements.create_claim',SEED.households.beta,SEED.users.casey.id,
   {originalTransactionId:expenseTxn,counterpartyName:'Sam',kind:'friend',amountMinor:'1',currency:'USD',description:'smuggle'},'smuggle')});
  expect(smuggle.status).toBe(404);
 });

 it('reverses settlement then claim with audited append-only events',async()=>{
  for(const [command,payload,status] of [
   ['reimbursements.reverse_settlement',{settlementId,reason:'wrong payment'},'reversed'],
   ['reimbursements.reverse_claim',{claimId,reason:'not owed'},'reversed'],
  ] as const){const response=await callFunction('/api/commands',{headers:alexHeaders,body:envelope(command,SEED.households.alpha,SEED.users.alex.id,payload,command)});
   expect(response.status).toBe(200);expect((response.body as {effects:{status:string}}).effects.status).toBe(status);}
  const list=await callFunction('/api/queries',{headers:alexHeaders,body:{query:'reimbursements.list',householdId:SEED.households.alpha}});
  expect(list.body).toMatchObject({rows:[{claimId,status:'reversed',remainingMinor:'0',incomeImpactMinor:'0'}]});
  const {data:audits}=await serviceClient().from('audit_log').select('action,before,after').in('object_id',[claimId,settlementId]);
  expect(audits?.map((row)=>row.action)).toEqual(expect.arrayContaining(['reimbursements.create_claim','reimbursements.settle','reimbursements.reverse_settlement','reimbursements.reverse_claim']));
  expect(audits?.filter((row)=>row.action.startsWith('reimbursements.reverse')).every((row)=>row.before&&row.after)).toBe(true);
 });
});
