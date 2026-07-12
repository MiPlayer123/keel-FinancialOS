import { describe, expect, it } from 'vitest';
import { bigintSummary, compareBigints, lowerMedian, squaredResidualSum } from '../src/index.js';

describe('exact bigint statistics', () => {
  it('uses stable bigint ordering and the lower median for even multisets', () => {
    const unsafe = 9_007_199_254_740_993n;
    expect(lowerMedian([unsafe + 10n, unsafe, unsafe + 2n, unsafe + 1n])).toBe(unsafe + 1n);
    expect(lowerMedian([7n, 1n, 5n])).toBe(5n);
  });

  it('rejects an empty median rather than inventing a value', () => {
    expect(() => lowerMedian([])).toThrow(RangeError);
  });

  it('compares bigint order without numeric coercion', () => {
    expect(compareBigints(1n, 1n)).toBe(0);
    expect(compareBigints(-2n, 1n)).toBe(-1);
    expect(compareBigints(2n, 1n)).toBe(1);
  });

  it('computes integer squared residuals exactly beyond Number.MAX_SAFE_INTEGER', () => {
    const center = 9_007_199_254_740_993n;
    expect(squaredResidualSum([center - 3n, center, center + 4n], center)).toBe(25n);
  });

  it('summarizes min/max/lower-median and integer variance numerator', () => {
    expect(bigintSummary([110n, 90n, 100n, 130n])).toEqual({
      min: 90n,
      max: 130n,
      median: 100n,
      squaredResidualSum: 1_100n,
      count: 4,
    });
  });
});
