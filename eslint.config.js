import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'supabase/functions/**', // Deno runtime; linted separately
      'coverage/**',
    ],
  },
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money safety: floats never carry financial values (CLAUDE.md Law 4).
      // Bans loss-prone Number<->bigint coercion patterns at lint time.
      'no-loss-of-precision': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'parseFloat is banned in financial code. Use minor-unit bigint parsing from @keel/ledger.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='round']",
          message: 'Math.round on money is banned. Use largest-remainder allocation in @keel/ledger.',
        },
      ],
    },
  },
  {
    files: ['**/*.config.js', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
