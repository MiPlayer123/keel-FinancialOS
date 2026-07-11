import { describe, expect, it } from 'vitest';
import {
  extractAmountLexemes,
  parsePlaidJsonPreservingAmountLexemes,
} from '../src/lossless.js';

describe('Plaid amount lexeme preservation', () => {
  it('extracts an amount beyond float-safe integer range verbatim', () => {
    const raw = '{"transaction_id":"huge","amount":9007199254740993.99,"has_more":false}';

    expect(extractAmountLexemes(raw)).toEqual(['9007199254740993.99']);
  });

  it('parses amount numbers as source strings without passing them through Number', () => {
    const raw =
      '{"added":[{"amount":9007199254740993.99},{"amount":-500.00}],"has_more":false}';

    expect(parsePlaidJsonPreservingAmountLexemes(raw)).toEqual({
      added: [{ amount: '9007199254740993.99' }, { amount: '-500.00' }],
      has_more: false,
    });
  });

  it('accepts authored fixtures whose amount is already a decimal string', () => {
    const raw = '{"amount":"12.30","description":"the word \\"amount\\": 99.99 is data"}';

    expect(extractAmountLexemes(raw)).toEqual(['12.30']);
    expect(parsePlaidJsonPreservingAmountLexemes(raw)).toEqual({
      amount: '12.30',
      description: 'the word "amount": 99.99 is data',
    });
  });
});
