/**
 * OFX statement parser tests (Law 4 no-floats string math, Law 5 inert data +
 * entity-free). Covers OFX 1.x SGML bank, 2.x XML card, 2.x XML investment,
 * malformed→null-never-throw, DTD / billion-laughs / external-entity rejection,
 * and RED_TEAM_STRINGS in NAME/MEMO/SECNAME stored verbatim as inert strings.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseOfxStatement, scanOfxSafety, tokenizeOfx } from '../src/statement/index.js';
import {
  GARBAGE,
  OFX_1X_BANK,
  OFX_2X_CARD,
  OFX_2X_INVESTMENT,
  OFX_BILLION_LAUGHS,
  OFX_EXTERNAL_ENTITY,
  OFX_BAD_DATES,
  OFX_INV_IDENTITY_EDGES,
  OFX_INV_MINIMAL_SEC,
  OFX_MINIMAL_BANK,
  OFX_SPARSE_BANK,
  OFX_SPARSE_INVESTMENT,
  OFX_WITH_DTD,
  RED_TEAM_STRINGS,
  ofxWithRedTeamText,
} from './fixtures/statement-cases.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('OFX 1.x SGML bank', () => {
  const rec = parseOfxStatement(OFX_1X_BANK);
  it('kind bank, currency, account hint, period', () => {
    expect(rec.kindHint).toBe('bank');
    expect(rec.currency).toBe('USD');
    expect(rec.accountHint).toBe('000111222');
    expect(rec.periodStart).toBe('2026-07-01');
    expect(rec.periodEnd).toBe('2026-07-31');
  });
  it('parses lines with string-math money (no floats)', () => {
    expect(rec.lines).toHaveLength(2);
    expect(rec.lines[0]!.amountMinor).toBe('-450');
    expect(rec.lines[0]!.descriptionRaw).toBe('Coffee cart');
    expect(rec.lines[0]!.externalId).toBe('A1');
    expect(rec.lines[1]!.amountMinor).toBe('200000');
  });
  it('ending balance from LEDGERBAL.BALAMT', () => {
    expect(rec.endingMinor).toBe('199550');
    expect(rec.openingMinor).toBeNull();
    expect(rec.provenance.endingMinor.ofx_path).toBe('LEDGERBAL.BALAMT');
  });
});

describe('OFX 2.x XML credit card', () => {
  const rec = parseOfxStatement(OFX_2X_CARD);
  it('kind card, negative ending balance', () => {
    expect(rec.kindHint).toBe('card');
    expect(rec.accountHint).toBe('4444333322221111');
    expect(rec.lines[0]!.amountMinor).toBe('-5210');
    expect(rec.endingMinor).toBe('-15210');
    expect(rec.periodStart).toBe('2026-06-01');
    expect(rec.periodEnd).toBe('2026-06-30');
  });
});

describe('OFX 2.x XML investment', () => {
  const rec = parseOfxStatement(OFX_2X_INVESTMENT);
  it('kind investment, holdings with CUSIP + ticker + name', () => {
    expect(rec.kindHint).toBe('investment');
    expect(rec.holdings).toHaveLength(2);
    const h0 = rec.holdings[0]!;
    expect(h0.cusip).toBe('037833100');
    expect(h0.symbol).toBe('FRUT');
    expect(h0.nameRaw).toBe('Fictional Fruit Co');
    expect(h0.qty).toBe('10.5'); // decimal string, not money, not summed
    expect(h0.priceMinor).toBe('15025');
    expect(h0.valueMinor).toBe('157763');
  });
  it('no bank lines on an investment statement', () => {
    expect(rec.lines).toHaveLength(0);
  });
});

describe('entity-free safety (Law 5)', () => {
  it('scanOfxSafety flags DTD, entity decl, numeric + external entities', () => {
    expect(scanOfxSafety('<!DOCTYPE x>').safe).toBe(false);
    expect(scanOfxSafety('<!ENTITY x "y">').safe).toBe(false);
    expect(scanOfxSafety('<a>&xxe;</a>').safe).toBe(false);
    expect(scanOfxSafety('<a>&#38;</a>').safe).toBe(false);
    expect(scanOfxSafety('<a>&amp;&lt;&gt;</a>').safe).toBe(true);
  });

  it('rejects a DTD-bearing OFX to an inert record (hostile null_reason)', () => {
    const rec = parseOfxStatement(OFX_WITH_DTD);
    expect(rec.lines).toHaveLength(0);
    expect(rec.holdings).toHaveLength(0);
    expect(rec.rawEvidence['rejected']).toBe('dtd_forbidden');
    expect(rec.provenance.currency.null_reason).toBe('hostile');
  });

  it('rejects billion-laughs entity expansion', () => {
    const rec = parseOfxStatement(OFX_BILLION_LAUGHS);
    expect(rec.rawEvidence['rejected']).toBe('dtd_forbidden');
  });

  it('rejects a standalone external-entity reference', () => {
    const rec = parseOfxStatement(OFX_EXTERNAL_ENTITY);
    expect(rec.rawEvidence['rejected']).toBe('external_entity_forbidden');
  });

  it('decodes the five allowed built-in entities in text', () => {
    const bytes = enc(
      '<OFX><STMTRS><CURDEF>USD<BANKTRANLIST><DTSTART>20260701<DTEND>20260731' +
        '<STMTTRN><DTPOSTED>20260702<TRNAMT>-1.00<NAME>A &amp; B &lt;co&gt;</STMTTRN>' +
        '</BANKTRANLIST></STMTRS></OFX>',
    );
    const rec = parseOfxStatement(bytes);
    expect(rec.lines[0]!.descriptionRaw).toBe('A & B <co>');
  });
});

describe('sparse / absent / malformed field provenance', () => {
  it('bank rows with malformed + absent fields yield null values with reasons', () => {
    const rec = parseOfxStatement(OFX_SPARSE_BANK);
    const [r1, r2] = rec.lines;
    // row 1: absent DTPOSTED, malformed TRNAMT, no description, no fitid
    expect(r1!.lineDate).toBeNull();
    expect(r1!.provenance.lineDate.null_reason).toBe('absent');
    expect(r1!.amountMinor).toBeNull();
    expect(r1!.provenance.amountMinor.null_reason).toBe('unparseable');
    expect(r1!.descriptionRaw).toBeNull();
    expect(r1!.provenance.descriptionRaw.null_reason).toBe('absent');
    expect(r1!.externalId).toBeNull();
    // row 2: malformed DTPOSTED (unparseable), absent TRNAMT, MEMO description
    expect(r2!.provenance.lineDate.null_reason).toBe('unparseable');
    expect(r2!.provenance.amountMinor.null_reason).toBe('absent');
    expect(r2!.descriptionRaw).toBe('memo only');
    // malformed ledger balance → null ending, unparseable
    expect(rec.endingMinor).toBeNull();
    expect(rec.provenance.endingMinor.null_reason).toBe('unparseable');
  });

  it('a minimal bank statement: no currency/account/ledger/period, still parses lines', () => {
    const rec = parseOfxStatement(OFX_MINIMAL_BANK);
    expect(rec.currency).toBeNull();
    expect(rec.accountHint).toBeNull();
    expect(rec.endingMinor).toBeNull();
    expect(rec.periodStart).toBeNull();
    expect(rec.periodEnd).toBeNull();
    expect(rec.provenance.currency.null_reason).toBe('absent');
    expect(rec.provenance.accountHint.null_reason).toBe('absent');
    expect(rec.provenance.endingMinor.null_reason).toBe('absent');
    expect(rec.lines[0]!.amountMinor).toBe('-100');
  });

  it('rejects OFX dates on every guard operand + tolerates root-level text', () => {
    const rec = parseOfxStatement(OFX_BAD_DATES);
    // DTSTART 20260732 (day 32) and DTEND 20261301 (month 13) both → null
    expect(rec.periodStart).toBeNull();
    expect(rec.periodEnd).toBeNull();
    // DTPOSTED 20260700 (day 00) → null date, amount still parses
    expect(rec.lines[0]!.lineDate).toBeNull();
    expect(rec.lines[0]!.amountMinor).toBe('-100');
  });

  it('position matched to a bare SECINFO (no ticker/name), cusip from position, absent units', () => {
    const rec = parseOfxStatement(OFX_INV_MINIMAL_SEC);
    const h = rec.holdings[0]!;
    expect(h.cusip).toBe('555'); // from position SECID (info had no cusip resolution difference)
    expect(h.symbol).toBeNull();
    expect(h.nameRaw).toBeNull();
    expect(h.qty).toBeNull();
    expect(h.provenance.qty.null_reason).toBe('absent'); // no UNITS tag
    expect(h.priceMinor).toBe('100');
    expect(h.valueMinor).toBe('200');
  });

  it('resolves ISIN/non-CUSIP identity and absent price/value branches', () => {
    const rec = parseOfxStatement(OFX_INV_IDENTITY_EDGES);
    // POSSTOCK + POSMF + POSOTHER order: the two POSOTHER, then POSSTOCK
    const byUnits = (u: string) => rec.holdings.find((h) => h.qty === u)!;
    const isin = byUnits('4');
    // matched SECINFO carried ticker/name but not a cusip (ISIN type)
    expect(isin.isin).toBe('ISIN123');
    expect(isin.cusip).toBeNull();
    expect(isin.symbol).toBe('OTH');
    expect(isin.nameRaw).toBe('Other Security');
    expect(isin.priceMinor).toBe('300');
    expect(isin.valueMinor).toBe('1200');

    const other = byUnits('1');
    expect(other.cusip).toBeNull();
    expect(other.isin).toBeNull();
    // absent UNITPRICE / MKTVAL tags → null + absent reason
    expect(other.priceMinor).toBeNull();
    expect(other.provenance.priceMinor.null_reason).toBe('absent');
    expect(other.valueMinor).toBeNull();
    expect(other.provenance.valueMinor.null_reason).toBe('absent');

    // CUSIP-typed position with no matching SECINFO → cusip from its own SECID
    const noMatch = byUnits('2');
    expect(noMatch.cusip).toBe('NOMATCH');
    expect(noMatch.symbol).toBeNull();

    // position with no SECID identity at all → all identifiers null
    const bare = byUnits('9');
    expect(bare.cusip).toBeNull();
    expect(bare.isin).toBeNull();
    expect(bare.symbol).toBeNull();
  });

  it('investment position with absent SECLIST + malformed numbers → null fields', () => {
    const rec = parseOfxStatement(OFX_SPARSE_INVESTMENT);
    const h = rec.holdings[0]!;
    expect(h.isin).toBe('999'); // UNIQUEIDTYPE ISIN carried
    expect(h.cusip).toBeNull();
    expect(h.symbol).toBeNull();
    expect(h.nameRaw).toBeNull();
    expect(h.qty).toBeNull();
    expect(h.provenance.qty.null_reason).toBe('unparseable');
    expect(h.priceMinor).toBeNull();
    expect(h.provenance.priceMinor.null_reason).toBe('unparseable');
    expect(h.valueMinor).toBeNull();
    expect(h.provenance.valueMinor.null_reason).toBe('unparseable');
  });
});

describe('malformed OFX never throws', () => {
  it('garbage bytes → inert record', () => {
    expect(() => parseOfxStatement(GARBAGE)).not.toThrow();
    const rec = parseOfxStatement(GARBAGE);
    expect(rec.rawEvidence['error']).toBe('no_statement_aggregate');
  });

  it('no statement aggregate → inert', () => {
    const rec = parseOfxStatement(enc('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>'));
    expect(rec.rawEvidence['error']).toBe('no_statement_aggregate');
  });

  it('truncated STMTTRN → line with null fields, no throw', () => {
    const rec = parseOfxStatement(
      enc('<OFX><STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><TRNAMT>abc</STMTTRN></BANKTRANLIST></STMTRS></OFX>'),
    );
    expect(rec.lines[0]!.amountMinor).toBeNull();
    expect(rec.lines[0]!.provenance.amountMinor.null_reason).toBe('unparseable');
  });
});

describe('red-team: OFX NAME/MEMO/SECNAME stored verbatim inert (Law 5)', () => {
  it('stores hostile NAME/MEMO exactly as inert strings', () => {
    const rec = parseOfxStatement(ofxWithRedTeamText());
    const expectedName = RED_TEAM_STRINGS[0]!.replace(/[<>&]/g, ' ');
    expect(rec.lines[0]!.descriptionRaw).toBe(expectedName);
  });

  it('stores hostile SECNAME exactly as an inert holding name', () => {
    const payload = RED_TEAM_STRINGS[5]!.replace(/[<>&]/g, ' ');
    const bytes = enc(
      '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD' +
        '<INVPOSLIST><POSSTOCK><INVPOS><SECID><UNIQUEID>111<UNIQUEIDTYPE>CUSIP</SECID>' +
        '<UNITS>1<UNITPRICE>2.00<MKTVAL>2.00</INVPOS></POSSTOCK></INVPOSLIST>' +
        `<SECLIST><STOCKINFO><SECINFO><SECID><UNIQUEID>111<UNIQUEIDTYPE>CUSIP</SECID>` +
        `<SECNAME>${payload}<TICKER>XX</SECINFO></STOCKINFO></SECLIST>` +
        '</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
    );
    const rec = parseOfxStatement(bytes);
    expect(rec.holdings[0]!.nameRaw).toBe(payload);
  });
});

describe('tokenizer + fuzz', () => {
  it('tokenizeOfx builds a tree and never throws on junk', () => {
    expect(() => tokenizeOfx('<A><B>x</B><C>y</A>')).not.toThrow();
    const root = tokenizeOfx('<A><B>x</B></A>');
    expect(root.children[0]!.tag).toBe('A');
  });

  it('tolerates text at the root level (no parent to hoist to)', () => {
    // "hi" appears while cur === #root, whose parent is null → the hoist guard
    // takes its false branch and the text is absorbed at root.
    const root = tokenizeOfx('hi<A>x</A>');
    expect(root.text).toBe('hi');
    expect(root.children[0]!.tag).toBe('A');
  });

  it('property: arbitrary bytes never throw and never leak a float amount', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        const rec = parseOfxStatement(enc(`<OFX><STMTRS><CURDEF>USD${s}</STMTRS></OFX>`));
        for (const line of rec.lines) {
          if (line.amountMinor !== null) expect(/^-?\d+$/.test(line.amountMinor)).toBe(true);
        }
        for (const h of rec.holdings) {
          if (h.priceMinor !== null) expect(/^-?\d+$/.test(h.priceMinor)).toBe(true);
          if (h.valueMinor !== null) expect(/^-?\d+$/.test(h.valueMinor)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
