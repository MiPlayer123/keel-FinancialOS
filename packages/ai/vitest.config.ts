import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ai',
    include: ['test/**/*.test.ts'],
  },
});
