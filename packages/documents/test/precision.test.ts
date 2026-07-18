/**
 * The ≥90% precision gate (CLAUDE.md; RECEIPTS-2026-07-16 §2).
 *
 * Precision = correct single-suggestions / all single-suggestions. The matcher
 * biases toward "no suggestion" over "wrong suggestion" because a rubber-stamped
 * wrong match corrupts the ledger's evidence layer. This suite FAILS if the
 * matcher ever single-suggests the wrong transaction or single-suggests on a
 * case that should have been multi/none.
 *
 * NOTE (human ⚑): this proves the DETERMINISTIC matcher's precision on recorded
 * extractions. The end-to-end ≥90% bar (including the vision model's extraction
 * accuracy on real receipt photos) still requires a labeled real-image set and
 * the live model wired in — flagged in NOTES.md as a follow-up checkpoint.
 */
import { describe, expect, it } from 'vitest';
import { decideMatch } from '../src/index.js';
import { RECEIPT_CASES } from './fixtures/receipt-cases.js';

describe('receipt-match precision harness', () => {
  it('every fixture resolves to its expected outcome (no wrong single-suggestions)', () => {
    let singleSuggestions = 0;
    let correctSuggestions = 0;
    const failures: string[] = [];

    for (const testCase of RECEIPT_CASES) {
      const outcome = decideMatch(testCase.extraction, testCase.candidates);

      if (outcome.kind === 'suggest') {
        singleSuggestions += 1;
        const wanted =
          testCase.expected.expect === 'suggest' ? testCase.expected.txnId : null;
        if (wanted !== null && outcome.candidate.transactionId === wanted) {
          correctSuggestions += 1;
        } else {
          failures.push(
            `${testCase.id}: single-suggested ${outcome.candidate.transactionId} but expected ${JSON.stringify(testCase.expected)}`,
          );
        }
      } else if (testCase.expected.expect === 'suggest') {
        failures.push(`${testCase.id}: expected a single suggestion but got ${outcome.kind}`);
      } else if (outcome.kind !== testCase.expected.expect) {
        failures.push(
          `${testCase.id}: expected ${testCase.expected.expect} but got ${outcome.kind}`,
        );
      }
    }

    const precision = singleSuggestions === 0 ? 1 : correctSuggestions / singleSuggestions;
    // The harness is authored so a green matcher has 100% precision AND no
    // outcome-class mismatches; both are asserted so a regression that (e.g.)
    // collapses multi→suggest is caught.
    expect(failures, failures.join('\n')).toHaveLength(0);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(singleSuggestions).toBeGreaterThan(0); // guard against a vacuous pass
  });

  it('has a fixture in every research-defined class', () => {
    const classes = new Set(RECEIPT_CASES.map((c) => c.klass));
    for (const klass of ['clean', 'tip', 'lag', 'descriptor', 'distractor', 'nomatch', 'hostile']) {
      expect(classes.has(klass as never)).toBe(true);
    }
  });
});
