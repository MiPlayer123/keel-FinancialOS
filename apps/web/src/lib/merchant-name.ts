/**
 * Merchant display name — presentation-layer cleanup of raw bank memos.
 *
 * "SQ *BLUE BOTTLE COFF 4155551234 CA" → "Blue Bottle Coff"
 *
 * Pure, deterministic string work: no LLM, no network, no writes (Law 1/5 —
 * ingested text stays data-tier; this never interprets the memo, only
 * reshapes it for display). Law 9 explicit ownership: callers must keep the
 * raw memo visible (secondary line or title tooltip) wherever the cleaned
 * name differs from the raw string. The raw description is never modified
 * or persisted by this module.
 *
 * Philosophy: minimal edits. Human-typed descriptions (mixed upper+lower
 * case) pass through essentially unchanged; aggressive stripping only
 * applies to single-case strings, which is what bank feeds and detector
 * fingerprints look like. When cleanup would erase everything, the trimmed
 * original (or a known processor name) is returned — information is never
 * lost outright.
 */

/** Payment-processor / rail prefixes. `fallback` is shown when nothing
 *  usable remains after the prefix (e.g. "APPLE.COM/BILL 866-712-7753 CA"). */
const PROCESSOR_PREFIXES: { re: RegExp; fallback?: string }[] = [
  { re: /^SQ\s*\*\s*/i },
  { re: /^TST\s*\*\s*/i },
  { re: /^PAYPAL\s*\*\s*/i, fallback: 'PayPal' },
  { re: /^PP\s*\*\s*/i, fallback: 'PayPal' },
  { re: /^PY\s*\*\s*/i },
  { re: /^SP\s*\*\s*/i },
  { re: /^GOOGLE\s*\*\s*/i, fallback: 'Google' },
  { re: /^APPLE\.COM\/BILL[\s*]*/i, fallback: 'Apple' },
  { re: /^AMZN\s+Mktp\s*(?:US\*?)?\s*/i, fallback: 'Amazon' },
  { re: /^CKE\s*\*\s*/i },
  { re: /^IC\s*\*\s*/i, fallback: 'Instacart' },
  { re: /^DD\s*\*\s*/i, fallback: 'DoorDash' },
  { re: /^CASH\s+APP\s*\*\s*/i, fallback: 'Cash App' },
  { re: /^VENMO\s+PAYMENT[\s*]*/i, fallback: 'Venmo' },
  { re: /^ZELLE\s+PAYMENT\s+(?:FROM|TO)\s+/i, fallback: 'Zelle' },
];

/** Card/ACH boilerplate leaders (bank-added, carry no merchant signal). */
const BOILERPLATE_LEADERS: RegExp[] = [
  /^POS\s+DEBIT[\s:-]+/i,
  /^DEBIT\s+CARD\s+PURCHASE[\s:-]+/i,
  // CHECKCARD is often followed by a bare MMDD date fragment.
  /^CHECKCARD[\s:-]+(?:\d{4}\s+)?/i,
  /^ACH\s+(?:DEBIT|CREDIT)[\s:-]+/i,
  /^PURCHASE\s+AUTHORIZED\s+ON\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*)?/i,
];

/** Casing map for brands whose canonical casing isn't derivable. Keys are
 *  lowercased tokens (or lowercased `-`/`/`-separated token segments). */
const BRAND_CASING = new Map<string, string>([
  ["mcdonald's", "McDonald's"],
  ['mcdonalds', "McDonald's"],
  ['paypal', 'PayPal'],
  ['itunes', 'iTunes'],
  ['ebay', 'eBay'],
  ['ikea', 'IKEA'],
  ['at&t', 'AT&T'],
  ['h&m', 'H&M'],
  ['7-eleven', '7-Eleven'],
  ['cvs', 'CVS'],
  ['ups', 'UPS'],
  ['usps', 'USPS'],
  ['doordash', 'DoorDash'],
  ['airbnb', 'Airbnb'],
  ['openai', 'OpenAI'],
  ['youtube', 'YouTube'],
  // Vowel-bearing acronyms the short-caps rule below can't recognize.
  ['rei', 'REI'],
  ['amc', 'AMC'],
  ['ibm', 'IBM'],
  ['ihop', 'IHOP'],
  // Corporate suffixes read better title-cased than as "brand initials".
  ['inc', 'Inc'],
  ['ltd', 'Ltd'],
  ['llc', 'LLC'],
]);

/** Short common words that must not be kept ALL-CAPS by the ≤3-letter
 *  brand-initials rule ("BED BATH AND BEYOND" → "Bed Bath And Beyond"). */
const SHORT_COMMON_WORDS = new Set([
  'and', 'the', 'of', 'for', 'to', 'on', 'in', 'at', 'by', 'a', 'an',
]);

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC', 'PR',
]);

/**
 * Cities stripped when (and only when) they immediately precede a stripped
 * trailing state code. List-based on purpose: a greedy "strip trailing
 * words" heuristic would eat merchant words ("BLUE BOTTLE COFFEE CA" must
 * not become "Blue Bottle"). Unknown city names simply remain visible —
 * a harmless, non-lossy outcome. Longest names first so "EAST PALO ALTO"
 * wins over "PALO ALTO".
 */
const US_CITIES: string[] = [
  'SALT LAKE CITY', 'EAST PALO ALTO', 'SAN FRANCISCO', 'NEW ORLEANS',
  'PHILADELPHIA', 'MOUNTAIN VIEW', 'INDIANAPOLIS', 'REDWOOD CITY',
  'OKLAHOMA CITY', 'LOS ANGELES', 'SANTA MONICA', 'ALBUQUERQUE',
  'JACKSONVILLE', 'KANSAS CITY', 'SPRINGFIELD', 'SACRAMENTO', 'MINNEAPOLIS',
  'PITTSBURGH', 'CINCINNATI', 'FORT WORTH', 'LONG BEACH', 'MENLO PARK',
  'SAN ANTONIO', 'WASHINGTON', 'CHARLOTTE', 'LAS VEGAS', 'MILWAUKEE',
  'BALTIMORE', 'CLEVELAND', 'SAN DIEGO', 'CUPERTINO', 'SUNNYVALE',
  'ANCHORAGE', 'PALO ALTO', 'SAN MATEO', 'NASHVILLE', 'SAN JOSE',
  'NEW YORK', 'BROOKLYN', 'COLUMBUS', 'HONOLULU', 'PORTLAND', 'ARLINGTON',
  'BERKELEY', 'SEATTLE', 'ATLANTA', 'CHICAGO', 'DETROIT', 'HOUSTON',
  'MEMPHIS', 'OAKLAND', 'ORLANDO', 'PHOENIX', 'RALEIGH', 'ST LOUIS',
  'ST PAUL', 'AUSTIN', 'BOSTON', 'DALLAS', 'DENVER', 'EL PASO', 'FRESNO',
  'TUCSON', 'BOISE', 'MIAMI', 'OMAHA', 'QUEENS', 'TAMPA', 'TULSA',
];

/** YYYY-MM-DD, then MM/DD[/YY[YY]]. */
const DATE_RES: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
];

/** US phone shapes: 866-712-7753, (415) 555-1234, +1 415.555.1234, 4155551234. */
const PHONE_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

/** Card last-4 fragments: XXXX1234, ****1234, XXXXXXXXXXXX1234. */
const CARD_LAST4_RE = /(?:[Xx]{2,}|\*{2,})\d{4}\b/g;

/** STORE #123 / STORE 123 → the number goes, the word "Store" stays
 *  (minimal edits: "THE UPS STORE #1701" must not become "The UPS").
 *  Bare #123 is dropped entirely. */
const STORE_NUMBER_RE = /\b(STORE)\s*#?\s*\d+\b/gi;
const HASH_NUMBER_RE = /#\d+\b/g;

function titleCaseSegment(seg: string): string {
  if (seg.length === 0) return seg;
  return seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase();
}

/** Title-case one whitespace token, honoring brand casing, short brand
 *  initials (CVS, UPS, H&M), and `-`/`/` compounds (7-Eleven, CVS/Pharmacy). */
function recaseToken(token: string): string {
  const whole = BRAND_CASING.get(token.toLowerCase());
  if (whole !== undefined) return whole;
  return token
    .split(/([/-])/)
    .map((seg) => {
      if (seg === '/' || seg === '-') return seg;
      const mapped = BRAND_CASING.get(seg.toLowerCase());
      if (mapped !== undefined) return mapped;
      if (SHORT_COMMON_WORDS.has(seg.toLowerCase())) return titleCaseSegment(seg);
      // Short vowel-less all-caps tokens read as brand initials (CVS, KFC,
      // BMW, TV) — keep them. Vowel-bearing short words (OIL, DOE, GAS)
      // title-case like everything else; acronym exceptions live in the map.
      if (/^[A-Z0-9&.']{1,3}$/.test(seg) && /[A-Z]/.test(seg) && !/[AEIOU]/.test(seg)) {
        return seg;
      }
      return titleCaseSegment(seg);
    })
    .join('');
}

/** Strip a trailing "CITY ST [US]" / ", CA" / "CA US" location suffix. */
function stripTrailingLocation(input: string): string {
  let s = input.replace(/[\s,]+$/, '');
  s = s.replace(/[\s,]+(?:USA?)$/i, '');
  const stateMatch = /[\s,]+([A-Za-z]{2})$/.exec(s);
  if (!stateMatch || !US_STATES.has((stateMatch[1] ?? '').toUpperCase())) return s;
  s = s.slice(0, stateMatch.index).replace(/[\s,]+$/, '');
  const upper = s.toUpperCase();
  for (const city of US_CITIES) {
    if (upper.endsWith(` ${city}`)) {
      s = s.slice(0, s.length - city.length - 1).replace(/[\s,]+$/, '');
      break;
    }
  }
  return s;
}

/**
 * Clean a raw transaction description into a display-friendly merchant name.
 *
 * Never returns an empty string for non-empty input: if cleanup strips
 * everything, the known processor name (if one was recognized) or the
 * trimmed original is returned instead.
 */
export function merchantDisplayName(description: string): string {
  const original = description.trim();
  if (original.length === 0) return original;

  let s = original;
  let processorFallback: string | undefined;

  // 1. Peel boilerplate leaders and processor prefixes off the front, in
  //    any order, until none match ("POS DEBIT SQ *FOO" needs both).
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const leader of BOILERPLATE_LEADERS) {
      const next = s.replace(leader, '');
      if (next !== s) {
        s = next;
        peeled = true;
      }
    }
    for (const { re, fallback } of PROCESSOR_PREFIXES) {
      const next = s.replace(re, '');
      if (next !== s) {
        s = next;
        processorFallback ??= fallback;
        peeled = true;
      }
    }
  }

  // Mixed upper+lower case reads as human-typed: keep edits minimal there.
  // Bank memos and detector fingerprints are single-case (ALL CAPS or all
  // lower), which is where the aggressive stripping is safe.
  const humanCased = /[a-z]/.test(s) && /[A-Z]/.test(s);

  // 2. Distinctive noise, safe to remove anywhere.
  for (const re of DATE_RES) s = s.replace(re, ' ');
  s = s.replace(PHONE_RE, ' ');
  s = s.replace(CARD_LAST4_RE, ' ');
  s = s.replace(STORE_NUMBER_RE, '$1');
  s = s.replace(HASH_NUMBER_RE, ' ');

  // 3. Reference-code tokens: 4+ pure digits always; 6+ alphanumeric
  //    (letters+digits, no lowercase unless the whole string is
  //    single-case) — "Z12AB34CD", "F32544", "00012345".
  s = s
    .split(/\s+/)
    .filter((token) => {
      const core = token.replace(/^[*#.,-]+|[*#.,-]+$/g, '');
      if (/^\d{4,}$/.test(core)) return false;
      const refShaped =
        core.length >= 6 &&
        // No '-' in the charset: hyphenated names ("7-ELEVEN") are names.
        /^[A-Za-z0-9*]+$/.test(core) &&
        /\d/.test(core) &&
        /[A-Za-z]/.test(core);
      if (refShaped && (!humanCased || !/[a-z]/.test(core))) return false;
      return true;
    })
    .join(' ');

  // 4. Trailing "CITY ST [US]" — single-case strings only ("Dinner in
  //    Savannah GA" typed by a human is left alone).
  if (!humanCased) s = stripTrailingLocation(s);

  // 5. Tidy separators and whitespace.
  s = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s*,./-]+/, '')
    .replace(/[\s*,-]+$/, '')
    .trim();

  // 6. Never lose information: empty/1-char results fall back.
  if (s.length <= 1) return processorFallback ?? original;

  // 7. Casing: human-cased strings pass through; single-case strings get
  //    title-cased with brand-aware exceptions.
  if (humanCased) return s;
  return s.split(' ').map(recaseToken).join(' ');
}
