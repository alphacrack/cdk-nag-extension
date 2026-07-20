// Flat config (ESLint 9+). Replaces .eslintrc.js — same effective rule set:
// typescript-eslint recommended + prettier-as-a-rule, scoped to src/**/*.ts
// like the old `eslint src --ext ts` invocation.
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const prettierRecommended = require('eslint-plugin-prettier/recommended');

module.exports = [
  {
    // Only TypeScript sources are linted; test harness .mjs files and JS
    // configs are formatted by prettier via lint-staged instead.
    ignores: ['**/*.js', '**/*.mjs', 'out/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: 'tsconfig.json',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // The runner loads cdk-nag / aws-cdk-lib from the *user's workspace* at
      // runtime via require.resolve — those require() calls are intentional.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettierRecommended,
  {
    rules: {
      'prettier/prettier': ['error', {}, { usePrettierrc: true }],
    },
  },
];
