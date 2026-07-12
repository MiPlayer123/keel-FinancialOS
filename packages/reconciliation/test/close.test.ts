import{describe,expect,it}from'vitest';import{evaluateStatementClose}from'../src/index.js';
describe('evaluateStatementClose',()=>{
 it('closes only when line arithmetic, explanations, and ledger difference all tie exactly',()=>{
  expect(evaluateStatementClose({openingMinor:'10000000000000000',endingMinor:'10000000000002500',ledgerEndingMinor:'10000000000002000',
   lines:[{lineId:'deposit',amountMinor:'3000'},{lineId:'fee',amountMinor:'-500'}],explainedLineIds:['deposit','fee'],adjustments:[{kind:'stale_balance',amountMinor:'500'}]})).toEqual({
   canClose:true,statementComputedEndingMinor:'10000000000002500',differenceMinor:'500',adjustmentTotalMinor:'500',unexplainedLineIds:[],violations:[],
  });
 });
 it('reports every independent unexplained difference',()=>{
  expect(evaluateStatementClose({openingMinor:'100',endingMinor:'120',ledgerEndingMinor:'110',lines:[{lineId:'a',amountMinor:'10'},{lineId:'b',amountMinor:'5'}],explainedLineIds:['a'],adjustments:[{kind:'duplicate',amountMinor:'9'}]}).violations)
   .toEqual(['statement_lines_do_not_reconcile','unexplained_statement_lines','ledger_difference_unexplained']);
 });
 it.each(['1.0','01','-0',''])('rejects invalid money %j',(openingMinor)=>{expect(()=>evaluateStatementClose({openingMinor,endingMinor:'0',ledgerEndingMinor:'0',lines:[],explainedLineIds:[],adjustments:[]})).toThrow(RangeError);});
 it('rejects duplicate line identities and unknown explanations',()=>{
  expect(()=>evaluateStatementClose({openingMinor:'0',endingMinor:'2',ledgerEndingMinor:'2',lines:[{lineId:'a',amountMinor:'1'},{lineId:'a',amountMinor:'1'}],explainedLineIds:['a'],adjustments:[]})).toThrow(RangeError);
  expect(()=>evaluateStatementClose({openingMinor:'0',endingMinor:'0',ledgerEndingMinor:'0',lines:[],explainedLineIds:['missing'],adjustments:[]})).toThrow(RangeError);
 });
});
