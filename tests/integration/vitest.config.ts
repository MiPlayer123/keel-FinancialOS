import { defineConfig } from 'vitest/config';
import { NumericSequencer } from './numeric-sequencer.js';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts'],
    // One shared database: suites run strictly sequentially.
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false, sequencer: NumericSequencer },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
