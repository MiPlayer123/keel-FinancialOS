import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      'npm:@supabase/server@1.3.0': fileURLToPath(
        new URL('./test/supabase-server.stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
