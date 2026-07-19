/**
 * Tolerant OFX parser — 1.x SGML and 2.x XML — that is ENTITY-FREE by
 * construction (Law 5: ingested files can never trigger fetches or expansion).
 * Before tokenizing we REJECT any DOCTYPE/DTD, any `<!ENTITY` declaration, and
 * any `&name;` entity reference beyond the five inert XML built-ins — closing
 * off external-entity and billion-laughs/entity-expansion attacks structurally.
 *
 * Structure handled:
 *   Bank/card: STMTRS / CCSTMTRS → BANKTRANLIST(DTSTART/DTEND) with STMTTRN rows
 *     (DTPOSTED, TRNAMT, NAME/MEMO, FITID); LEDGERBAL(BALAMT,DTASOF) → ending;
 *     ACCTID → accountHint; kindHint bank | card (CCSTMTRS ⇒ card).
 *   Investment: INVSTMTRS → INVPOSLIST(POSSTOCK/POSMF: SECID, UNITS, UNITPRICE,
 *     MKTVAL) + SECLIST(SECINFO: SECID→CUSIP/TICKER, SECNAME) → holdings;
 *     kindHint investment.
 *
 * All money flows through the SAME `parseMoneyToMinor` string-math path as CSV
 * (Law 4: no floats). Every field is nullable; a malformed file returns an inert
 * extraction, never a throw. Input is ONLY `Uint8Array` bytes. Pure: no I/O.
 */
import {
  emptyStatementFields,
  provenance,
  STATEMENT_PARSER_VERSION,
  type StatementExtractionRecord,
  type StatementHoldingRecord,
  type StatementKindHint,
  type StatementLineRecord,
} from './types.js';
import { parseMoneyToMinor } from './money.js';

/** A parsed SGML/XML node: a tag name, optional text, and children. */
interface OfxNode {
  readonly tag: string;
  text: string;
  readonly children: OfxNode[];
  readonly parent: OfxNode | null;
}

/** Result of the entity/DTD safety scan. */
type SafetyResult = { readonly safe: true } | { readonly safe: false; readonly reason: string };

/** The five inert XML built-in entities allowed to appear as `&name;`. */
const ALLOWED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/**
 * Reject any construct that could cause entity expansion or external fetches:
 * a DOCTYPE/DTD, an `<!ENTITY ...>` declaration, or a non-builtin `&name;` /
 * `&#...;` reference. Numeric character references are also rejected (they are
 * an expansion vector and unnecessary for OFX money/date/text). Pure scan.
 */
export const scanOfxSafety = (text: string): SafetyResult => {
  if (/<!DOCTYPE/iu.test(text)) return { safe: false, reason: 'dtd_forbidden' };
  if (/<!ENTITY/iu.test(text)) return { safe: false, reason: 'entity_decl_forbidden' };
  // Any entity reference: &word; or &#123; or &#x1F;. `match[0]` (the whole
  // match, always a string for matchAll) is `&…;`; strip the delimiters to get
  // the body without an intermediate optional capture group.
  const entityRe = /&(?:#x?[0-9a-f]+|[a-z][a-z0-9]*);/giu;
  for (const match of text.matchAll(entityRe)) {
    const body = match[0].slice(1, -1);
    if (body.startsWith('#')) return { safe: false, reason: 'numeric_entity_forbidden' };
    if (!ALLOWED_ENTITIES.has(body.toLowerCase())) {
      return { safe: false, reason: 'external_entity_forbidden' };
    }
  }
  return { safe: true };
};

/** Decode the five allowed built-in entities AFTER the safety scan passes. */
const decodeAllowedEntities = (s: string): string =>
  s
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');

/** Strip the OFX 1.x SGML header block (KEY:VALUE lines before the first tag). */
const stripSgmlHeader = (text: string): string => {
  const idx = text.indexOf('<');
  return idx <= 0 ? text : text.slice(idx);
};

/**
 * Tokenize OFX body (post-safety-scan) into a tree. Written to tolerate OFX
 * 1.x SGML, where leaf elements have no closing tag and their value is the text
 * up to the next tag. Aggregate elements (that contain child tags) are treated
 * as containers. XML 2.x (with closing tags) parses through the same routine.
 * Never throws; unbalanced input yields whatever tree was built so far.
 */
export const tokenizeOfx = (body: string): OfxNode => {
  const root: OfxNode = { tag: '#root', text: '', children: [], parent: null };
  let cur = root;
  const tagRe = /<(\/?)([A-Za-z0-9._]+)(?:\s[^>]*)?>|[^<]+/gu;
  for (const m of body.matchAll(tagRe)) {
    const closing = m[1];
    const tagName = m[2];
    if (tagName !== undefined) {
      const name = tagName.toUpperCase();
      if (closing === '/') {
        // Close: walk up to the matching open tag if present.
        let node: OfxNode | null = cur;
        while (node && node.tag !== name) node = node.parent;
        if (node?.parent) cur = node.parent;
        continue;
      }
      const child: OfxNode = { tag: name, text: '', children: [], parent: cur };
      cur.children.push(child);
      cur = child; // provisionally descend (SGML leaves get re-hoisted below)
      continue;
    }
    // The text alternative matched: `m[0]` is the run of non-`<` characters.
    const trimmed = m[0].trim();
    if (trimmed.length > 0) {
      cur.text += decodeAllowedEntities(trimmed);
      // SGML leaf: a tag with only text and no child tags. When the next token
      // is another opening tag at this level, hoist back to parent so siblings
      // attach correctly. We approximate by hoisting whenever a leaf received
      // text (aggregates receive child tags, not raw text). At the root there is
      // no parent to hoist to.
      if (cur.parent) cur = cur.parent;
    }
  }
  return root;
};

/** Depth-first: first descendant with the given tag, or null. */
const findFirst = (node: OfxNode, tag: string): OfxNode | null => {
  const want = tag.toUpperCase();
  for (const c of node.children) {
    if (c.tag === want) return c;
    const deep = findFirst(c, want);
    if (deep) return deep;
  }
  return null;
};

/** Depth-first: all descendants with the given tag. */
const findAll = (node: OfxNode, tag: string): OfxNode[] => {
  const want = tag.toUpperCase();
  const out: OfxNode[] = [];
  const walk = (n: OfxNode): void => {
    for (const c of n.children) {
      if (c.tag === want) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
};

/** Direct-child text for a tag, or null. */
const childText = (node: OfxNode, tag: string): string | null => {
  const want = tag.toUpperCase();
  for (const c of node.children) {
    if (c.tag === want && c.text.length > 0) return c.text;
  }
  const deep = findFirst(node, want);
  return deep && deep.text.length > 0 ? deep.text : null;
};

/** OFX date (YYYYMMDD[HHMMSS...]) → YYYY-MM-DD, or null. */
const parseOfxDate = (raw: string | null): string | null => {
  if (raw === null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/u.exec(raw.trim());
  if (!m) return null;
  const [, y = '', mo = '', d = ''] = m;
  const mm = Number(mo);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${mo}-${d}`;
};

/** ISO-4217 3-letter code or null. */
const parseCcy = (raw: string | null): string | null =>
  raw !== null && /^[A-Za-z]{3}$/u.test(raw.trim()) ? raw.trim().toUpperCase() : null;

/** Build the bank/card lines from a STMTRS/CCSTMTRS aggregate. */
const parseBankLines = (
  stmtrs: OfxNode,
  currency: string | null,
): StatementLineRecord[] => {
  const txns = findAll(stmtrs, 'STMTTRN');
  const lines: StatementLineRecord[] = [];
  for (const [i, t] of txns.entries()) {
    const lineNo = i + 1;
    const lineDate = parseOfxDate(childText(t, 'DTPOSTED'));
    const trnamt = childText(t, 'TRNAMT');
    const parsed = trnamt !== null ? parseMoneyToMinor(trnamt) : null;
    const minor = parsed && parsed.ok ? parsed.minor : null;
    const name = childText(t, 'NAME'); // inert (Law 5)
    const memo = childText(t, 'MEMO'); // inert (Law 5)
    const descriptionRaw = name ?? memo;
    const fitid = childText(t, 'FITID');
    lines.push({
      lineNo,
      lineDate,
      amountMinor: minor,
      currency,
      descriptionRaw,
      externalId: fitid,
      provenance: {
        lineDate: provenance({
          ofx_path: 'STMTTRN.DTPOSTED',
          null_reason: lineDate === null ? (childText(t, 'DTPOSTED') ? 'unparseable' : 'absent') : null,
        }),
        amountMinor: provenance({
          ofx_path: 'STMTTRN.TRNAMT',
          null_reason: minor === null ? (trnamt ? 'unparseable' : 'absent') : null,
        }),
        descriptionRaw: provenance({
          ofx_path: name !== null ? 'STMTTRN.NAME' : 'STMTTRN.MEMO',
          null_reason: descriptionRaw === null ? 'absent' : null,
        }),
        externalId: provenance({
          ofx_path: 'STMTTRN.FITID',
          null_reason: fitid === null ? 'absent' : null,
        }),
      },
    });
  }
  return lines;
};

/** Build investment holdings from an INVSTMTRS aggregate (+ SECLIST names). */
const parseHoldings = (
  root: OfxNode,
  currency: string | null,
): StatementHoldingRecord[] => {
  // SECID (UNIQUEID + UNIQUEIDTYPE) → { cusip, ticker, name } from SECLIST.
  const secInfo = new Map<
    string,
    { cusip: string | null; ticker: string | null; name: string | null }
  >();
  for (const info of findAll(root, 'SECINFO')) {
    const uid = childText(info, 'UNIQUEID');
    const uidType = (childText(info, 'UNIQUEIDTYPE') ?? '').toUpperCase();
    const ticker = childText(info, 'TICKER');
    const name = childText(info, 'SECNAME'); // inert (Law 5)
    if (uid !== null) {
      secInfo.set(uid, {
        cusip: uidType === 'CUSIP' ? uid : null,
        ticker,
        name,
      });
    }
  }

  const positions = [
    ...findAll(root, 'POSSTOCK'),
    ...findAll(root, 'POSMF'),
    ...findAll(root, 'POSOTHER'),
    ...findAll(root, 'POSDEBT'),
  ];
  const holdings: StatementHoldingRecord[] = [];
  for (const pos of positions) {
    const uid = childText(pos, 'UNIQUEID');
    const uidType = (childText(pos, 'UNIQUEIDTYPE') ?? '').toUpperCase();
    const info = uid !== null ? secInfo.get(uid) : undefined;
    const cusip = info?.cusip ?? (uidType === 'CUSIP' ? uid : null);
    const isin = uidType === 'ISIN' ? uid : null;
    const symbol = info?.ticker ?? null;
    const nameRaw = info?.name ?? null;

    const unitsStr = childText(pos, 'UNITS');
    const priceStr = childText(pos, 'UNITPRICE');
    const mktvalStr = childText(pos, 'MKTVAL');

    const priceParsed = priceStr !== null ? parseMoneyToMinor(priceStr) : null;
    const valueParsed = mktvalStr !== null ? parseMoneyToMinor(mktvalStr) : null;
    const priceMinor = priceParsed && priceParsed.ok ? priceParsed.minor : null;
    const valueMinor = valueParsed && valueParsed.ok ? valueParsed.minor : null;
    // qty is a decimal STRING (fractional shares); NOT money, not summed.
    const qty = unitsStr !== null && /^-?\d+(\.\d+)?$/u.test(unitsStr.trim())
      ? unitsStr.trim()
      : null;

    holdings.push({
      symbol,
      cusip,
      isin,
      nameRaw,
      qty,
      priceMinor,
      valueMinor,
      costBasisMinor: null,
      currency,
      provenance: {
        symbol: provenance({
          ofx_path: 'SECLIST.SECINFO.TICKER',
          null_reason: symbol === null ? 'absent' : null,
        }),
        qty: provenance({
          ofx_path: 'INVPOS.UNITS',
          null_reason: qty === null ? (unitsStr ? 'unparseable' : 'absent') : null,
        }),
        priceMinor: provenance({
          ofx_path: 'INVPOS.UNITPRICE',
          null_reason: priceMinor === null ? (priceStr ? 'unparseable' : 'absent') : null,
        }),
        valueMinor: provenance({
          ofx_path: 'INVPOS.MKTVAL',
          null_reason: valueMinor === null ? (mktvalStr ? 'unparseable' : 'absent') : null,
        }),
      },
    });
  }
  return holdings;
};

/**
 * Parse OFX bytes into a defensive extraction record. Never throws. On a DTD /
 * entity / expansion attack, returns an inert empty record whose currency
 * provenance carries `null_reason: 'hostile'` and whose rawEvidence names the
 * rejection reason. Bank/card ⇒ lines + ending balance; investment ⇒ holdings.
 */
export const parseOfxStatement = (bytes: Uint8Array): StatementExtractionRecord => {
  const base = {
    extractor: 'ofx',
    extractorVersion: STATEMENT_PARSER_VERSION,
    model: null,
    promptVersion: null,
  };

  // TextDecoder (fatal:false) never throws on bytes and strips a leading UTF-8
  // BOM by default (ignoreBOM defaults to false).
  const text = new TextDecoder('utf-8').decode(bytes);

  const safety = scanOfxSafety(text);
  if (!safety.safe) {
    const empty = emptyStatementFields('unknown');
    return {
      ...empty,
      ...base,
      provenance: {
        ...empty.provenance,
        currency: provenance({ null_reason: 'hostile' }),
      },
      rawEvidence: { rejected: safety.reason },
    };
  }

  const body = stripSgmlHeader(text);
  const root = tokenizeOfx(body);

  // Determine kind + the response aggregate present.
  const invstmt = findFirst(root, 'INVSTMTRS');
  const ccstmt = findFirst(root, 'CCSTMTRS');
  const stmt = findFirst(root, 'STMTRS');

  let kindHint: StatementKindHint = 'unknown';
  let stmtrs: OfxNode | null = null;
  if (invstmt) {
    kindHint = 'investment';
    stmtrs = invstmt;
  } else if (ccstmt) {
    kindHint = 'card';
    stmtrs = ccstmt;
  } else if (stmt) {
    kindHint = 'bank';
    stmtrs = stmt;
  }

  if (stmtrs === null) {
    const empty = emptyStatementFields('unknown');
    return { ...empty, ...base, rawEvidence: { error: 'no_statement_aggregate' } };
  }

  const currency = parseCcy(childText(stmtrs, 'CURDEF'));
  const accountHint = childText(stmtrs, 'ACCTID'); // inert

  // Period from BANKTRANLIST DTSTART/DTEND (bank/card) or INVTRANLIST.
  const tranList = findFirst(stmtrs, 'BANKTRANLIST') ?? findFirst(stmtrs, 'INVTRANLIST');
  const periodStart = parseOfxDate(tranList ? childText(tranList, 'DTSTART') : null);
  const periodEnd = parseOfxDate(tranList ? childText(tranList, 'DTEND') : null);

  const lines = kindHint === 'investment' ? [] : parseBankLines(stmtrs, currency);
  const holdings = kindHint === 'investment' ? parseHoldings(root, currency) : [];

  // Ending balance from LEDGERBAL(BALAMT). Opening not carried by OFX.
  const ledgerBal = findFirst(stmtrs, 'LEDGERBAL');
  const balAmtStr = ledgerBal ? childText(ledgerBal, 'BALAMT') : null;
  const balParsed = balAmtStr !== null ? parseMoneyToMinor(balAmtStr) : null;
  const endingMinor = balParsed && balParsed.ok ? balParsed.minor : null;
  const dtAsOf = parseOfxDate(ledgerBal ? childText(ledgerBal, 'DTASOF') : null);
  const effectivePeriodEnd = periodEnd ?? dtAsOf;

  const empty = emptyStatementFields(kindHint);
  const populated =
    lines.length + holdings.length + (endingMinor !== null ? 1 : 0);
  const confidence = populated > 0 ? 1 : 0;

  return {
    periodStart,
    periodEnd: effectivePeriodEnd,
    openingMinor: null,
    endingMinor,
    currency,
    kindHint,
    accountHint,
    lines,
    holdings,
    confidence,
    provenance: {
      ...empty.provenance,
      periodStart: provenance({
        ofx_path: 'BANKTRANLIST.DTSTART',
        null_reason: periodStart === null ? 'absent' : null,
      }),
      periodEnd: provenance({
        ofx_path: 'BANKTRANLIST.DTEND',
        null_reason: effectivePeriodEnd === null ? 'absent' : null,
      }),
      openingMinor: provenance({ null_reason: 'absent' }),
      endingMinor: provenance({
        ofx_path: 'LEDGERBAL.BALAMT',
        null_reason: endingMinor === null ? (balAmtStr ? 'unparseable' : 'absent') : null,
      }),
      currency: provenance({
        ofx_path: 'CURDEF',
        null_reason: currency === null ? 'absent' : null,
      }),
      accountHint: provenance({
        ofx_path: 'ACCTID',
        null_reason: accountHint === null ? 'absent' : null,
      }),
    },
    ...base,
    rawEvidence: { kindHint, accountHint, lineCount: lines.length, holdingCount: holdings.length },
  };
};
