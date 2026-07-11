import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'plaid',
    include: ['test/**/*.test.ts'],
  },
});
