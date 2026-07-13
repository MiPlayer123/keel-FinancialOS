import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// Pure-logic lib tests only (parsers, money helpers) — components are covered
// by the build + integration layers, not jsdom unit tests.
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/lib/**/*.test.ts'],
  },
});
