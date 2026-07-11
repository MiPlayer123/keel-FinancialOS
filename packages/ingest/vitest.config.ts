import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ingest',
    include: ['test/**/*.test.ts'],
  },
});
