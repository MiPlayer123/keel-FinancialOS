import { describe, expect, it } from 'vitest';
import {
  merchantSimilarity,
  merchantTokens,
  normalizeMerchant,
  tokenOverlap,
  trigramSimilarity,
} from '../src/normalize.js';

describe('normalizeMerchant', () => {
  it('uppercases, strips SQ* prefix and trailing store number', () => {
    expect(normalizeMerchant('SQ *Blue Bottle 4421')).toBe('BLUE BOTTLE');
  });

  it('strips TST* and PAYPAL* prefixes', () => {
    expect(normalizeMerchant("TST* Joe's Cafe")).toBe('JOE S CAFE');
    expect(normalizeMerchant('PAYPAL *ETSY')).toBe('ETSY');
  });

  it('drops a leading www. and hash store number', () => {
    expect(normalizeMerchant('WWW.EXAMPLE.COM #0231')).toBe('EXAMPLE COM');
  });

  it('longest prefix wins when several could match', () => {
    // "PAYPAL *" and "PP*" both processor prefixes; only one is stripped.
    expect(normalizeMerchant('PAYPAL *STORE')).toBe('STORE');
  });

  it('returns empty string for all-noise input', () => {
    expect(normalizeMerchant('#0231')).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('merchantTokens', () => {
  it('splits a normalized stem into words', () => {
    expect(merchantTokens('BLUE BOTTLE')).toEqual(['BLUE', 'BOTTLE']);
  });
  it('empty stem → no tokens', () => {
    expect(merchantTokens('')).toEqual([]);
  });
});

describe('tokenOverlap', () => {
  it('is 1 for identical stems', () => {
    expect(tokenOverlap('BLUE BOTTLE', 'BLUE BOTTLE')).toBe(1);
  });
  it('is a Jaccard fraction for partial overlap', () => {
    // {BLUE,BOTTLE} vs {BLUE,BOTTLE,COFFEE} → 2/3
    expect(tokenOverlap('BLUE BOTTLE', 'BLUE BOTTLE COFFEE')).toBeCloseTo(2 / 3, 5);
  });
  it('is 0 when either side is empty', () => {
    expect(tokenOverlap('', 'BLUE')).toBe(0);
    expect(tokenOverlap('BLUE', '')).toBe(0);
  });
  it('is 0 for disjoint token sets', () => {
    expect(tokenOverlap('BLUE BOTTLE', 'RED KETTLE')).toBe(0);
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical stems', () => {
    expect(trigramSimilarity('BLUEBOTTLE', 'BLUEBOTTLE')).toBe(1);
  });
  it('is between 0 and 1 for near strings', () => {
    const sim = trigramSimilarity('BLUE BOTTLE', 'BLUE BOTTLE CO');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
  it('is 0 when a side has no trigrams', () => {
    expect(trigramSimilarity('AB', 'ABCDEF')).toBe(0);
  });
});

describe('merchantSimilarity', () => {
  it('is 1 when normalized stems are identical despite descriptor noise', () => {
    expect(merchantSimilarity('SQ *BLUE BOTTLE 4421', 'Blue Bottle')).toBe(1);
  });
  it('is high for a fuzzy but related descriptor', () => {
    expect(merchantSimilarity('Blue Bottle Coffee', 'BLUE BOTTLE')).toBeGreaterThanOrEqual(0.6);
  });
  it('is 0 when either side normalizes to empty', () => {
    expect(merchantSimilarity('#0231', 'Blue Bottle')).toBe(0);
  });
  it('is low for unrelated merchants', () => {
    expect(merchantSimilarity('Blue Bottle', 'Shell Gas')).toBeLessThan(0.6);
  });
});
