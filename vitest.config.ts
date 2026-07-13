import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'supabase/functions/worker', 'apps/web'],
  },
});
