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
