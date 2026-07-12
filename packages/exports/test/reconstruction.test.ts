import { describe, expect, it } from 'vitest';
import { fromJson, reconstructTrialBalance, toJson } from '../src/index.js';
import { ledgerSnapshot } from './ledger-fixture.js';

describe('isolated in-memory reconstruction', () => {
  it('rebuilds the exported trial balance using only JSON journal postings', () => {
    const restored = fromJson(toJson(ledgerSnapshot()));
    expect(reconstructTrialBalance(restored)).toEqual(restored.trialBalance);
  });
});
