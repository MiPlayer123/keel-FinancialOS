import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts'],
    // One shared database: suites run strictly sequentially.
    fileParallelism: false,
    maxConcurrency: 1,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    root: '../..',
  },
});
