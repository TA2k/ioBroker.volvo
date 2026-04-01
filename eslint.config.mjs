import js from '@eslint/js';
import globals from 'globals';

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
    ignores: ['admin/words.js'],
  },
];
