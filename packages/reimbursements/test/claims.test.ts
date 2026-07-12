import { describe,expect,it } from 'vitest';
import { reconcileClaims,type ClaimInput } from '../src/index.js';

const claims: ClaimInput[] = [
  { claimId:'rent-alex',amountMinor:'9007199254740993',status:'open' },
  { claimId:'dinner-sam',amountMinor:'2500',status:'open' },
];

describe('reconcileClaims',()=>{
  it('reduces claims by active settlements without creating fake income',()=>{
    expect(reconcileClaims(claims,[
      { settlementId:'s1',claimId:'rent-alex',transactionId:'venmo-1',amountMinor:'9007199254740000',status:'active' },
      { settlementId:'s2',claimId:'rent-alex',transactionId:'venmo-2',amountMinor:'993',status:'active' },
      { settlementId:'s3',claimId:'dinner-sam',transactionId:'venmo-2',amountMinor:'500',status:'reversed' },
    ],{'venmo-1':'9007199254740000','venmo-2':'993'})).toEqual({
      ok:true,incomeImpactMinor:'0',remainingByClaim:{'rent-alex':'0','dinner-sam':'2500'},violations:[],
    });
  });

  it('rejects claim over-settlement and transaction over-allocation independently',()=>{
    const result = reconcileClaims(claims,[
      { settlementId:'s1',claimId:'dinner-sam',transactionId:'venmo',amountMinor:'2501',status:'active' },
    ],{venmo:'2500'});
    expect(result.violations).toEqual([
      {code:'claim_overallocated',claimId:'dinner-sam',claimMinor:'2500',allocatedMinor:'2501'},
      {code:'transaction_overallocated',transactionId:'venmo',capacityMinor:'2500',allocatedMinor:'2501'},
    ]);
  });

  it('ignores reversed claims and settlements in active economics',()=>{
    expect(reconcileClaims([{claimId:'x',amountMinor:'10',status:'reversed'}],[
      {settlementId:'s',claimId:'x',transactionId:'t',amountMinor:'10',status:'active'},
    ],{t:'10'})).toMatchObject({ok:false,remainingByClaim:{x:'0'}});
  });

  it.each(['1.2','01','-1','-0',''])('rejects invalid minor-unit wire %j',(amountMinor)=>{
    expect(()=>reconcileClaims([{claimId:'x',amountMinor,status:'open'}],[],{})).toThrow(RangeError);
  });

  it('rejects duplicate identities and unknown references/capacity',()=>{
    expect(()=>reconcileClaims([...claims,claims[0]!],[],{})).toThrow(RangeError);
    expect(()=>reconcileClaims(claims,[{settlementId:'s',claimId:'missing',transactionId:'t',amountMinor:'1',status:'active'}],{t:'1'})).toThrow(RangeError);
    expect(()=>reconcileClaims(claims,[{settlementId:'s',claimId:'dinner-sam',transactionId:'missing',amountMinor:'1',status:'active'}],{})).toThrow(RangeError);
  });
});
