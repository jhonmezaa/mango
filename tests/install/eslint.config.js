import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // security-best-practices JS-XSS-003: no string-to-code, also inside `page.evaluate`.
      'no-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      // Everything a run prints goes through the reporter, which masks it (src/report.ts).
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'page',
          property: 'waitForTimeout',
          message: 'No fixed waits: wait for a response or a locator.',
        },
        {
          property: 'storageState',
          message: 'A session is never written to disk (it holds the session cookie).',
        },
      ],
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
