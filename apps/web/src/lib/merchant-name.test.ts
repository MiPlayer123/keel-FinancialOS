import { describe, expect, it } from 'vitest';

import { merchantDisplayName } from './merchant-name';

/**
 * Fixture table of real-shaped bank memos → expected display names.
 * All display-only: the raw memo is data-tier (Law 5) — these assertions
 * only ever compare output STRINGS; nothing here is executed, fetched,
 * or interpreted, no matter how adversarial the memo looks.
 */
const FIXTURES: [memo: string, expected: string][] = [
  // Payment-processor prefixes (counterparty kept).
  ['SQ *BLUE BOTTLE COFF 4155551234 CA', 'Blue Bottle Coff'],
  ['TST* PHILZ COFFEE OAKLAND CA', 'Philz Coffee'],
  ['TST *JOES PIZZA NEW YORK NY', 'Joes Pizza'],
  ['PAYPAL *NETFLIX', 'Netflix'],
  ['PP*DOORDASH BURRITO', 'DoorDash Burrito'],
  ['PY *SUSHI HANA', 'Sushi Hana'],
  ['SP * ALLBIRDS', 'Allbirds'],
  ['GOOGLE *YOUTUBE TV', 'YouTube TV'],
  ['DD *DOORDASH STARBUCKS', 'DoorDash Starbucks'],
  ['IC* INSTACART SAN FRANCISCO CA', 'Instacart'],
  ['CKE*TICKETS 800-555-1212', 'Tickets'],
  ['CASH APP*JANE SMITH', 'Jane Smith'],
  ['ZELLE PAYMENT FROM JOHN DOE', 'John Doe'],
  ['ZELLE PAYMENT TO ACME PLUMBING', 'Acme Plumbing'],

  // Prefix-only memos fall back to the processor name, not the raw junk.
  ['APPLE.COM/BILL 866-712-7753 CA', 'Apple'],
  ['AMZN Mktp US*Z12AB34CD', 'Amazon'],
  ['VENMO PAYMENT 1234567890', 'Venmo'],

  // Card/ACH boilerplate leaders, dates, store numbers, ref codes.
  ["POS DEBIT 07/12 TRADER JOE'S #553 SEATTLE WA", "Trader Joe's"],
  ["DEBIT CARD PURCHASE MCDONALD'S F32544 DENVER CO", "McDonald's"],
  // The word "Store" survives — only the number is noise ("The UPS Store"
  // below shows why stripping the word would mangle real names.)
  ['CHECKCARD 0712 STARBUCKS STORE #08765 PORTLAND OR', 'Starbucks Store'],
  ['PURCHASE AUTHORIZED ON 07/10 UBER EATS SAN FRANCISCO CA', 'Uber Eats'],
  ['ACH DEBIT COMCAST XFINITY 2026-07-01', 'Comcast Xfinity'],
  ['ACH CREDIT ACME CORP PAYROLL 00012345', 'Acme Corp Payroll'],

  // Phone numbers, card last-4 fragments, trailing city/state/country.
  ['UBER EATS XXXX1234', 'Uber Eats'],
  ['NETFLIX.COM ****4321', 'Netflix.com'],
  ['SHELL OIL 57444 CA US', 'Shell Oil'],
  ['AT&T PAYMENT 800-288-2020', 'AT&T Payment'],
  ['IKEA EAST PALO ALTO CA', 'IKEA'],
  ['7-ELEVEN 32458 AUSTIN TX', '7-Eleven'],
  ['CVS/PHARMACY #04358 SUNNYVALE CA', 'CVS/Pharmacy'],
  ['H&M HENNES & MAURITZ NEW YORK NY', 'H&M Hennes & Mauritz'],
  ['EBAY INC SAN JOSE CA', 'eBay Inc'],
  ['AIRBNB HMXYZ123 PAYMENTS', 'Airbnb Payments'],
  ['THE UPS STORE #1701 BOSTON MA', 'The UPS Store'],
  ['BED BATH AND BEYOND 5734 TAMPA FL', 'Bed Bath And Beyond'],

  // Detector fingerprints are lowercased and must be uppercased by the
  // caller to opt into aggressive cleanup (lowercase = human-typed here).
  ['sq *blue bottle coff 4155551234 ca'.toUpperCase(), 'Blue Bottle Coff'],
  ['openai chatgpt', 'OpenAI Chatgpt'],

  // Human-typed descriptions pass through essentially unchanged.
  ['Rent to landlord', 'Rent to landlord'],
  ['Coffee with Sam', 'Coffee with Sam'],
  ['PAYMENT - AMAZON GIFT CARD', 'Payment - Amazon Gift Card'],
  ['Dinner in Savannah GA', 'Dinner in Savannah GA'],

  // Unicode survives (case-mapping included).
  ['CAFÉ MÜNCHEN 89 4155551234', 'Café München 89'],

  // Never lose information: cleanup-to-nothing returns the trimmed original.
  ['#12345678', '#12345678'],
  ['STORE #123', 'Store'],
  ['  Rent  ', 'Rent'],
];

describe('merchantDisplayName', () => {
  it.each(FIXTURES)('%s → %s', (memo, expected) => {
    expect(merchantDisplayName(memo)).toBe(expected);
  });

  it('returns the empty string for empty/whitespace input', () => {
    expect(merchantDisplayName('')).toBe('');
    expect(merchantDisplayName('   ')).toBe('');
  });

  it('is deterministic (same input, same output)', () => {
    for (const [memo] of FIXTURES) {
      expect(merchantDisplayName(memo)).toBe(merchantDisplayName(memo));
    }
  });

  it('treats adversarial memo text as inert data — output is just a string', () => {
    // Template-injection-looking text: single-case lowercase, so it gets the
    // title-case pass, but the characters are never interpreted.
    const braces = "{{constructor.constructor('alert(1)')()}}";
    expect(merchantDisplayName(braces)).toBe(braces);

    // Markup-looking ALL-CAPS memo: only its casing changes.
    const markup = merchantDisplayName('SQ *<SCRIPT>ALERT(1)</SCRIPT> CAFE');
    expect(typeof markup).toBe('string');
    expect(markup.endsWith('Cafe')).toBe(true);

    // Shell-looking text passes through as data.
    const shell = merchantDisplayName('Refund $(rm -rf /) from vendor');
    expect(shell).toBe('Refund $(rm -rf /) from vendor');
  });

  it('never returns an empty string for non-empty input', () => {
    const nasty = ['#999999', 'XXXX1234', '07/12', '866-712-7753', 'CA US', '****0000'];
    for (const memo of nasty) {
      expect(merchantDisplayName(memo).length).toBeGreaterThan(0);
    }
  });

  it('preserves identifying numbers in human-typed memos (review finding)', () => {
    // Mixed-case: full pass-through, digits and all.
    expect(merchantDisplayName('Check #1042')).toBe('Check #1042');
    expect(merchantDisplayName('Transfer to Chase 05/12')).toBe('Transfer to Chase 05/12');
    expect(merchantDisplayName('Invoice #38 for deck repair')).toBe('Invoice #38 for deck repair');
    // ALL-CAPS bank memo where the number IS the identity: recased, kept.
    expect(merchantDisplayName('CHECK 1042')).toBe('Check 1042');
  });

  it('recases but never strips all-lowercase memos (review finding)', () => {
    // Lowercase human typing (mobile) — location words are part of the memo.
    expect(merchantDisplayName('trip to boston ma')).toBe('Trip To Boston Ma');
    // Detector fingerprints still read cleanly.
    expect(merchantDisplayName('netflix')).toBe('Netflix');
    expect(merchantDisplayName('blue bottle coffee')).toBe('Blue Bottle Coffee');
  });

  it('extracts company · purpose from NACHA/ACH key:value memos (live-UI finding)', () => {
    expect(
      merchantDisplayName(
        'ORIG CO NAME:DEEPTUNE CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:1234567890',
      ),
    ).toBe('Deeptune · Payroll');
    // Generic purposes add nothing next to the company.
    expect(
      merchantDisplayName('ORIG CO NAME:COMCAST CO ENTRY DESCR:PAYMENT SEC:WEB'),
    ).toBe('Comcast');
    // Company only, no descr key.
    expect(merchantDisplayName('ORIG CO NAME:VANGUARD SEC:PPD')).toBe('Vanguard');
    // No ORIG CO NAME → normal pipeline, not the ACH path.
    expect(merchantDisplayName('ENTRY DESCR:PAYROLL')).not.toContain('·');
    // Deterministic under the cache: same input, same output, twice.
    const memo = 'ORIG CO NAME:DEEPTUNE CO ENTRY DESCR:PAYROLL SEC:PPD';
    expect(merchantDisplayName(memo)).toBe(merchantDisplayName(memo));
  });
});
