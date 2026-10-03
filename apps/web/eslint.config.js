import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'test-results', 'playwright-report'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Security guardrails (security-best-practices: REACT-XSS-001/002, REACT-AUTH-001, JS-XSS-003).
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is forbidden (TM-012). Render through React.',
        },
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Raw DOM HTML sinks are forbidden (TM-012).',
        },
        {
          selector: "CallExpression > MemberExpression.callee[property.name='insertAdjacentHTML']",
          message: 'Raw DOM HTML sinks are forbidden (TM-012).',
        },
        {
          selector: "MemberExpression[object.name='document'][property.name=/^(write|writeln)$/]",
          message: 'document.write is forbidden (TM-012).',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Tokens and session data must stay in memory.' },
        { name: 'sessionStorage', message: 'Tokens and session data must stay in memory.' },
      ],
      // Property-only entries match any object and computed access (window, globalThis, self,
      // document.defaultView, x['localStorage'], destructuring). Only src/preferences/storage.ts
      // (UI preferences) and src/auth/oidc.ts (transient PKCE state) disable it, with a reason.
      'no-restricted-properties': [
        'error',
        { property: 'localStorage', message: 'Use src/preferences/storage.ts (UI prefs only).' },
        { property: 'sessionStorage', message: 'Keep auth state in memory.' },
      ],
    },
  },
  {
    // Tests seed and inspect Web Storage to prove the app does not trust it.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['vite.config.ts', 'mock/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
