export const RECONCILIATION_FORMULA_VERSION='statement-close-v1'as const;
interface CloseInput{readonly openingMinor:string;readonly endingMinor:string;readonly ledgerEndingMinor:string;readonly lines:readonly{readonly lineId:string;readonly amountMinor:string}[];readonly explainedLineIds:readonly string[];readonly adjustments:readonly{readonly kind:string;readonly amountMinor:string}[]}
const parse=(wire:string):bigint=>{if(!/^-?(0|[1-9][0-9]*)$/u.test(wire)||wire==='-0')throw new RangeError('money must be canonical integer minor units');return BigInt(wire)};
export const evaluateStatementClose=(input:CloseInput)=>{
 const opening=parse(input.openingMinor),ending=parse(input.endingMinor),ledger=parse(input.ledgerEndingMinor);const ids=new Set<string>();
 for(const line of input.lines){if(!line.lineId||ids.has(line.lineId))throw new RangeError('statement line ids must be unique and non-empty');ids.add(line.lineId)}
 const explained=new Set(input.explainedLineIds);if(explained.size!==input.explainedLineIds.length||[...explained].some((id)=>!ids.has(id)))throw new RangeError('explanations must uniquely reference statement lines');
 const computed=opening+input.lines.reduce((sum,line)=>sum+parse(line.amountMinor),0n);const difference=ending-ledger;
 const adjustmentTotal=input.adjustments.reduce((sum,row)=>sum+parse(row.amountMinor),0n);const unexplained=[...ids].filter((id)=>!explained.has(id));const violations:string[]=[];
 if(computed!==ending)violations.push('statement_lines_do_not_reconcile');if(unexplained.length)violations.push('unexplained_statement_lines');if(adjustmentTotal!==difference)violations.push('ledger_difference_unexplained');
 return{canClose:violations.length===0,statementComputedEndingMinor:computed.toString(),differenceMinor:difference.toString(),adjustmentTotalMinor:adjustmentTotal.toString(),unexplainedLineIds:unexplained,violations};
};
