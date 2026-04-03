import js from '@eslint/js';
import globals from 'globals';
// @iobroker/eslint-config is installed but not used directly here since this is a plain JS adapter.
// TypeScript-heavy peer deps would be needed to use it directly.

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.mocha,
      },
    },
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      'no-console': 'off',
      'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-var': 'error',
      'no-trailing-spaces': 'error',
      'prefer-const': 'error',
      'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'semi': ['error', 'always'],
    },
  },
  {
    files: ['admin/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.jquery,
        systemDictionary: 'readonly',
        systemLang: 'readonly',
        sendTo: 'readonly',
        M: 'readonly',
        socket: 'readonly',
      },
    },
    rules: {
      'no-var': 'off',
    },
  },
  {
    ignores: ['admin/words.js', 'eslint.config.mjs'],
  },
];
