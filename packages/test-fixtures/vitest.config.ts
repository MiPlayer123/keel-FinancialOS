import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'test-fixtures',
    include: ['test/**/*.test.ts'],
  },
});
