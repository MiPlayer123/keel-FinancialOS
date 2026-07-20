export const REIMBURSEMENT_FORMULA_VERSION='claim-settlement-v1' as const;
export interface ClaimInput { readonly claimId:string; readonly amountMinor:string; readonly status:'open'|'settled'|'reversed' }
export interface SettlementInput { readonly settlementId:string; readonly claimId:string; readonly transactionId:string; readonly amountMinor:string; readonly status:'active'|'reversed' }
export type ClaimViolation =
  | {readonly code:'claim_overallocated';readonly claimId:string;readonly claimMinor:string;readonly allocatedMinor:string}
  | {readonly code:'claim_inactive';readonly claimId:string;readonly allocatedMinor:string}
  | {readonly code:'transaction_overallocated';readonly transactionId:string;readonly capacityMinor:string;readonly allocatedMinor:string};

const parse=(wire:string,label:string):bigint=>{
  if(!/^(0|[1-9][0-9]*)$/u.test(wire)) throw new RangeError(`${label} must be canonical non-negative minor units`);
  return BigInt(wire);
};

export const reconcileClaims=(
  claims:readonly ClaimInput[],settlements:readonly SettlementInput[],transactionCapacities:Readonly<Record<string,string>>,
):{readonly ok:boolean;readonly incomeImpactMinor:'0';readonly remainingByClaim:Readonly<Record<string,string>>;readonly violations:readonly ClaimViolation[]}=>{
  const claimMap=new Map<string,{row:ClaimInput;amount:bigint}>();
  for(const claim of claims){
    if(!claim.claimId||claimMap.has(claim.claimId)) throw new RangeError('claim ids must be unique and non-empty');
    claimMap.set(claim.claimId,{row:claim,amount:parse(claim.amountMinor,'claim amount')});
  }
  const settlementIds=new Set<string>(); const byClaim=new Map<string,bigint>(); const byTxn=new Map<string,bigint>();
  for(const settlement of settlements){
    if(!settlement.settlementId||settlementIds.has(settlement.settlementId)) throw new RangeError('settlement ids must be unique and non-empty');
    settlementIds.add(settlement.settlementId);
    if(!claimMap.has(settlement.claimId)) throw new RangeError('settlement references unknown claim');
    const amount=parse(settlement.amountMinor,'settlement amount');
    if(settlement.status==='reversed') continue;
    if(transactionCapacities[settlement.transactionId]===undefined) throw new RangeError('settlement transaction has no capacity evidence');
    byClaim.set(settlement.claimId,(byClaim.get(settlement.claimId)??0n)+amount);
    byTxn.set(settlement.transactionId,(byTxn.get(settlement.transactionId)??0n)+amount);
  }
  const violations:ClaimViolation[]=[]; const remainingByClaim:Record<string,string>={};
  for(const [claimId,{row,amount}] of claimMap){
    const allocated=byClaim.get(claimId)??0n;
    if(row.status==='reversed'){
      remainingByClaim[claimId]='0';
      if(allocated>0n) violations.push({code:'claim_inactive',claimId,allocatedMinor:allocated.toString()});
    }else{
      remainingByClaim[claimId]=(allocated>=amount?0n:amount-allocated).toString();
      if(allocated>amount) violations.push({code:'claim_overallocated',claimId,claimMinor:amount.toString(),allocatedMinor:allocated.toString()});
    }
  }
  for(const [transactionId,allocated] of [...byTxn].sort(([a],[b])=>a.localeCompare(b))){
    const capacity=parse(transactionCapacities[transactionId] as string,'transaction capacity');
    if(allocated>capacity) violations.push({code:'transaction_overallocated',transactionId,capacityMinor:capacity.toString(),allocatedMinor:allocated.toString()});
  }
  return {ok:violations.length===0,incomeImpactMinor:'0',remainingByClaim,violations};
};

// ---- Expected (future-dated) reimbursements — AR math ----
// An expected reimbursement is money someone owes you, tracked BEFORE it lands.
// It is never an economic event (income impact is always 0). Remaining balance
// is the expected amount minus every ACTIVE receipt; status is derived purely
// from that balance + explicit lifecycle transitions. Mirrors the DB's
// keel_expected_reimbursement_remaining / list-status so UI + server agree.
export const EXPECTED_REIMBURSEMENT_FORMULA_VERSION='expected-reimbursement-v1' as const;
export type ExpectedReimbursementStatus='open'|'received'|'written_off';
export interface ExpectedReceiptInput {readonly receiptId:string;readonly allocatedMinor:string;readonly status:'active'|'reversed'}
export interface ExpectedReimbursementInput {
  readonly expectedId:string;
  readonly expectedMinor:string;
  /** Explicit lifecycle status set by write-off/reopen/full-receipt close. */
  readonly status:ExpectedReimbursementStatus;
  readonly receipts:readonly ExpectedReceiptInput[];
}
export type ExpectedViolation=
  | {readonly code:'expected_overallocated';readonly expectedId:string;readonly expectedMinor:string;readonly allocatedMinor:string}
  | {readonly code:'receipt_on_written_off';readonly expectedId:string;readonly allocatedMinor:string};

/**
 * Pure reconciliation for one expected reimbursement. Returns the remaining
 * balance, whether the receipts fully cover it, and the effective status a
 * viewer sees. `incomeImpactMinor` is always '0' — settling an expectation must
 * never be booked as income (Law 2/9).
 */
export const reconcileExpected=(
  row:ExpectedReimbursementInput,
):{
  readonly remainingMinor:string;
  readonly allocatedMinor:string;
  readonly fullyCovered:boolean;
  readonly incomeImpactMinor:'0';
  readonly effectiveStatus:ExpectedReimbursementStatus;
  readonly violations:readonly ExpectedViolation[];
}=>{
  const expected=parse(row.expectedMinor,'expected amount');
  if(expected<=0n) throw new RangeError('expected amount must be positive');
  const seen=new Set<string>();
  let allocated=0n;
  for(const r of row.receipts){
    if(!r.receiptId||seen.has(r.receiptId)) throw new RangeError('receipt ids must be unique and non-empty');
    seen.add(r.receiptId);
    const amount=parse(r.allocatedMinor,'receipt amount');
    if(r.status==='active') allocated+=amount;
  }
  const violations:ExpectedViolation[]=[];
  if(allocated>expected) violations.push({code:'expected_overallocated',expectedId:row.expectedId,expectedMinor:expected.toString(),allocatedMinor:allocated.toString()});
  if(row.status==='written_off'&&allocated>0n) violations.push({code:'receipt_on_written_off',expectedId:row.expectedId,allocatedMinor:allocated.toString()});
  const remaining=allocated>=expected?0n:expected-allocated;
  // A written-off expectation stays written off regardless of coverage; a fully
  // covered open one presents as received; otherwise it is what it is.
  const effectiveStatus:ExpectedReimbursementStatus=
    row.status==='written_off'?'written_off':remaining===0n?'received':'open';
  return {
    remainingMinor:remaining.toString(),
    allocatedMinor:allocated.toString(),
    fullyCovered:remaining===0n,
    incomeImpactMinor:'0',
    effectiveStatus,
    violations,
  };
};
