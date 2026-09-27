// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/src/generated/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Node code: API, shared package, worker, e2e tests and root/tool config files.
  {
    files: [
      'apps/api/**/*.{js,mjs,cjs,ts}',
      'apps/worker/**/*.{js,mjs,cjs,ts}',
      'packages/**/*.{js,mjs,cjs,ts}',
      'e2e/**/*.ts',
      '*.{js,mjs,cjs,ts}',
      'apps/*/*.config.{js,mjs,cjs,ts}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser code: web app.
  {
    files: ['apps/web/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
  },

  // Must stay last: turns off rules that conflict with Prettier.
  prettier,
);
