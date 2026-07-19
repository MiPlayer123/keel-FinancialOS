/**
 * Red-team + golden statement fixtures (Law 5: ingested CSV/OFX text is inert
 * data — it can never trigger a tool, write, fetch, or RPC). These build hostile
 * CSV and OFX byte streams carrying formula-injection headers and the shared
 * RED_TEAM_STRINGS in every text-bearing position (headers, descriptions,
 * debit/credit columns, OFX NAME/MEMO/SECNAME). The tests assert the parsers
 * store the text VERBATIM as inert strings and that the module structurally
 * cannot reach IO (proven by the capability-boundary gate + no-IO-import test).
 *
 * All fixtures are fictional. No real merchant/employer/account strings.
 */
import { RED_TEAM_STRINGS } from '@keel/test-fixtures';

export { RED_TEAM_STRINGS };

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Safe indexed access into the shared red-team corpus (never undefined). */
export const rt = (i: number): string => RED_TEAM_STRINGS[i] ?? '';
/** Safe indexed access into the formula-injection headers. */
const fh = (i: number): string => FORMULA_INJECTION_HEADERS[i] ?? '';

/** Formula-injection header tokens (CSV/spreadsheet injection). */
export const FORMULA_INJECTION_HEADERS = [
  '=cmd|/c calc',
  '@SUM(A1:A9)',
  '+1234',
  '-2+3',
  '=HYPERLINK("https://attacker.invalid","x")',
] as const;

/** A well-formed single-Amount CSV (golden). */
export const CSV_SIMPLE = enc(
  ['Date,Description,Amount', '2026-07-01,Coffee cart,-4.50', '2026-07-03,Refund,12.00'].join('\n'),
);

/** A debit/credit split CSV with US dates and $/comma/paren money (golden). */
export const CSV_DEBIT_CREDIT = enc(
  [
    'Posted Date,Payee,Debit,Credit',
    '07/01/2026,Grocery run,"$1,234.56",',
    '07/02/2026,Paycheck,,"$2,000.00"',
    '07/05/2026,Reversal,($10.00),',
  ].join('\n'),
);

/** A CSV whose header row is entirely formula-injection + a hostile description. */
export const CSV_HOSTILE_HEADERS = enc(
  [
    `${fh(0)},${fh(1)},Amount,Description`,
    `2026-07-01,x,-5.00,"${rt(0)}"`,
  ].join('\n'),
);

/** A CSV whose debit/credit columns carry red-team payloads instead of numbers.
 * Inner double-quotes are doubled per RFC-4180 so the payloads round-trip
 * verbatim through the tokenizer. */
const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
export const CSV_HOSTILE_MONEY = enc(
  [
    'Date,Description,Debit,Credit',
    `2026-07-01,${q(rt(3))},${q(rt(5))},`,
    `2026-07-02,${q(rt(8))},,${q('=cmd')}`,
  ].join('\n'),
);

/** A CSV description column carrying every RED_TEAM_STRING (verbatim check). */
export const csvWithRedTeamDescriptions = (): Uint8Array => {
  const rows = ['Date,Amount,Description'];
  RED_TEAM_STRINGS.forEach((s, i) => {
    // embed the payload as a quoted field; doubled quotes per RFC-4180
    const safe = s.replace(/"/g, '""').replace(/\n/g, ' ');
    rows.push(`2026-07-${String((i % 28) + 1).padStart(2, '0')},-1.00,"${safe}"`);
  });
  return enc(rows.join('\n'));
};

/** RFC-4180 stress: embedded comma, embedded newline, doubled quote. */
export const CSV_RFC4180 = enc(
  [
    'Date,Description,Amount',
    '2026-07-01,"Store, with comma",-1.00',
    '2026-07-02,"Line one\nline two",-2.00',
    '2026-07-03,"He said ""hi""",-3.00',
  ].join('\n'),
);

/** A CSV with a UTF-8 BOM prefix. */
export const CSV_BOM = enc('﻿Date,Amount,Description\n2026-07-01,-9.00,BOM row');

/** OFX 1.x SGML bank statement (leaf tags, no closing tags). */
export const OFX_1X_BANK = enc(
  [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    '',
    '<OFX>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS>',
    '<CURDEF>USD',
    '<BANKACCTFROM><ACCTID>000111222<ACCTTYPE>CHECKING</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20260701',
    '<DTEND>20260731',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260703<TRNAMT>-4.50<FITID>A1<NAME>Coffee cart</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260705<TRNAMT>2000.00<FITID>A2<NAME>Paycheck<MEMO>net</STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>1995.50<DTASOF>20260731</LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
    '</OFX>',
  ].join('\n'),
);

/** OFX 2.x XML credit-card statement (closing tags). */
export const OFX_2X_CARD = enc(
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE"?>',
    '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
    '<CURDEF>USD</CURDEF>',
    '<CCACCTFROM><ACCTID>4444333322221111</ACCTID></CCACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20260601</DTSTART><DTEND>20260630</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260610</DTPOSTED>',
    '<TRNAMT>-52.10</TRNAMT><FITID>C1</FITID><NAME>Bookshop</NAME></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>-152.10</BALAMT><DTASOF>20260630</DTASOF></LEDGERBAL>',
    '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
  ].join('\n'),
);

/** OFX 2.x XML investment statement with positions + SECLIST. */
export const OFX_2X_INVESTMENT = enc(
  [
    '<?xml version="1.0"?>',
    '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS>',
    '<CURDEF>USD</CURDEF>',
    '<INVACCTFROM><ACCTID>Z9988</ACCTID></INVACCTFROM>',
    '<INVPOSLIST>',
    '<POSSTOCK><INVPOS><SECID><UNIQUEID>037833100</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID>',
    '<UNITS>10.5</UNITS><UNITPRICE>150.25</UNITPRICE><MKTVAL>1577.63</MKTVAL></INVPOS></POSSTOCK>',
    '<POSMF><INVPOS><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID>',
    '<UNITS>3</UNITS><UNITPRICE>410.00</UNITPRICE><MKTVAL>1230.00</MKTVAL></INVPOS></POSMF>',
    '</INVPOSLIST>',
    '<SECLIST>',
    '<STOCKINFO><SECINFO><SECID><UNIQUEID>037833100</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID>',
    '<SECNAME>Fictional Fruit Co</SECNAME><TICKER>FRUT</TICKER></SECINFO></STOCKINFO>',
    '<MFINFO><SECINFO><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID>',
    '<SECNAME>Broad Index Fund</SECNAME><TICKER>BIDX</TICKER></SECINFO></MFINFO>',
    '</SECLIST>',
    '</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
  ].join('\n'),
);

/** OFX carrying RED_TEAM_STRINGS in NAME/MEMO/SECNAME (verbatim inert check). */
export const ofxWithRedTeamText = (): Uint8Array => {
  const name = rt(0).replace(/[<>&]/g, ' ');
  const memo = rt(5).replace(/[<>&]/g, ' ');
  return enc(
    [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
      '<CURDEF>USD',
      '<BANKACCTFROM><ACCTID>1<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260701<DTEND>20260731',
      `<STMTTRN><DTPOSTED>20260702<TRNAMT>-1.00<FITID>R1<NAME>${name}<MEMO>${memo}</STMTTRN>`,
      '</BANKTRANLIST>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n'),
  );
};

/** OFX with a DOCTYPE/DTD — must be rejected (entity-expansion vector). */
export const OFX_WITH_DTD = enc(
  [
    '<?xml version="1.0"?>',
    '<!DOCTYPE OFX [ <!ENTITY foo "bar"> ]>',
    '<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>',
  ].join('\n'),
);

/** Billion-laughs style entity-expansion payload — must be rejected. */
export const OFX_BILLION_LAUGHS = enc(
  [
    '<?xml version="1.0"?>',
    '<!DOCTYPE lolz [',
    '<!ENTITY lol "lol">',
    '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">',
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;">',
    ']>',
    '<OFX><NAME>&lol3;</NAME></OFX>',
  ].join('\n'),
);

/** OFX with an external-entity reference (no DTD line) — must be rejected. */
export const OFX_EXTERNAL_ENTITY = enc(
  '<OFX><STMTRS><CURDEF>USD</CURDEF><NAME>&xxe;</NAME></STMTRS></OFX>',
);

/** A bank OFX whose STMTTRN rows exercise absent + malformed field paths:
 *  row 1: no DTPOSTED, malformed TRNAMT, no NAME/MEMO, no FITID;
 *  row 2: malformed DTPOSTED, absent TRNAMT, MEMO-only description. */
export const OFX_SPARSE_BANK = enc(
  [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>',
    '<CURDEF>USD',
    '<BANKTRANLIST>',
    '<STMTTRN><TRNAMT>abc</STMTTRN>',
    '<STMTTRN><DTPOSTED>notadate<MEMO>memo only</STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>bad</LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n'),
);

/** A bank OFX with NO currency, NO account, NO ledger balance, NO period. */
export const OFX_MINIMAL_BANK = enc(
  '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>' +
    '<STMTTRN><DTPOSTED>20260701<TRNAMT>-1.00<NAME>x</STMTTRN>' +
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
);

/** An investment OFX whose position has absent/malformed UNITS/PRICE/MKTVAL and
 *  no matching SECLIST entry (so ticker/name/cusip resolve to null). */
export const OFX_SPARSE_INVESTMENT = enc(
  [
    '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD',
    '<INVPOSLIST>',
    '<POSOTHER><INVPOS><SECID><UNIQUEID>999<UNIQUEIDTYPE>ISIN</SECID>',
    '<UNITS>notaqty<UNITPRICE>bad<MKTVAL>worse</INVPOS></POSOTHER>',
    '</INVPOSLIST>',
    '</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
  ].join('\n'),
);

/** Bank OFX with dates that fail on different guard operands + root-level text. */
export const OFX_BAD_DATES = enc(
  'leading root text' +
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>' +
    '<DTSTART>20260732<DTEND>20261301' + // invalid day, invalid month
    '<STMTTRN><DTPOSTED>20260700<TRNAMT>-1.00<NAME>bad day zero</STMTTRN>' + // day 00
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
);

/** Investment OFX: a position matched to a SECLIST entry with NO ticker/name,
 *  a cusip carried on the POSITION's own SECID, and an ABSENT UNITS tag. */
export const OFX_INV_MINIMAL_SEC = enc(
  [
    '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD',
    '<INVPOSLIST>',
    '<POSSTOCK><INVPOS><SECID><UNIQUEID>555<UNIQUEIDTYPE>CUSIP</SECID>',
    '<UNITPRICE>1.00<MKTVAL>2.00</INVPOS></POSSTOCK>', // no UNITS tag
    '</INVPOSLIST>',
    '<SECLIST><OTHERINFO><SECINFO><SECID><UNIQUEID>555<UNIQUEIDTYPE>CUSIP</SECID>',
    '</SECINFO></OTHERINFO></SECLIST>', // SECINFO with no TICKER, no SECNAME
    '</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
  ].join('\n'),
);

/** Investment OFX exercising SECINFO/position identity edge branches:
 *  - a SECINFO with NO UNIQUEID (skipped);
 *  - a SECINFO with a non-CUSIP (OTHER) UNIQUEIDTYPE (cusip stays null);
 *  - a position with ISIN type, matched to that SECINFO (ticker present);
 *  - a position with a non-CUSIP/non-ISIN type and NO price/value tags. */
export const OFX_INV_IDENTITY_EDGES = enc(
  [
    '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD',
    '<INVPOSLIST>',
    // ISIN position matched to the OTHER-typed SECINFO below
    '<POSOTHER><INVPOS><SECID><UNIQUEID>ISIN123<UNIQUEIDTYPE>ISIN</SECID>',
    '<UNITS>4<UNITPRICE>3.00<MKTVAL>12.00</INVPOS></POSOTHER>',
    // position with a non-CUSIP/non-ISIN type and no price/value tags
    '<POSOTHER><INVPOS><SECID><UNIQUEID>OTHR9<UNIQUEIDTYPE>OTHER</SECID>',
    '<UNITS>1</INVPOS></POSOTHER>',
    // CUSIP-typed position with NO matching SECINFO → cusip falls back to SECID
    '<POSSTOCK><INVPOS><SECID><UNIQUEID>NOMATCH<UNIQUEIDTYPE>CUSIP</SECID>',
    '<UNITS>2<UNITPRICE>5.00<MKTVAL>10.00</INVPOS></POSSTOCK>',
    // position with NO UNIQUEID and NO UNIQUEIDTYPE at all
    '<POSOTHER><INVPOS><SECID></SECID><UNITS>9</INVPOS></POSOTHER>',
    '</INVPOSLIST>',
    '<SECLIST>',
    // SECINFO missing UNIQUEID entirely → skipped
    '<OTHERINFO><SECINFO><SECID><UNIQUEIDTYPE>CUSIP</SECID><SECNAME>Ghost</SECINFO></OTHERINFO>',
    // SECINFO with NO UNIQUEIDTYPE (exercises the ?? "" fallback) → skipped-ish
    '<OTHERINFO><SECINFO><SECID><UNIQUEID>NOTYPE1</SECID><SECNAME>Typeless</SECINFO></OTHERINFO>',
    // SECINFO with a non-CUSIP type → cusip null but ticker/name carried
    '<OTHERINFO><SECINFO><SECID><UNIQUEID>ISIN123<UNIQUEIDTYPE>ISIN</SECID>',
    '<TICKER>OTH<SECNAME>Other Security</SECINFO></OTHERINFO>',
    '</SECLIST>',
    '</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
  ].join('\n'),
);

/** Garbage bytes that are neither valid CSV nor OFX. */
export const GARBAGE = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80]);

/** A .csv-named file that is actually random non-tabular bytes. */
export const CSV_NOT_TABULAR = enc('not,a\nreal;;statement\x00\x01');
