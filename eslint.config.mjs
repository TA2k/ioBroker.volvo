import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        // Project is plain JS, no tsconfig — disable type-checked TS rules
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: null,
            },
        },
    },
    {
        // Adapter-specific relaxations to avoid mass-rewriting legacy code
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns': 'off',
            'jsdoc/require-returns-description': 'off',
            'jsdoc/require-returns-type': 'off',
            'jsdoc/no-undefined-types': 'off',
            'jsdoc/no-defaults': 'off',
            'jsdoc/tag-lines': 'off',
            'prefer-template': 'off',
            'no-else-return': 'off',
            'quote-props': 'off',
            curly: 'off',
            'prettier/prettier': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    ignoreRestSiblings: true,
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    },
    {
        files: ['admin/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
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
        files: ['**/*.test.js', 'test/**/*.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                it: 'readonly',
                before: 'readonly',
                after: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
            },
        },
    },
    {
        ignores: [
            '**/*.d.ts',
            'admin/words.js',
            'eslint.config.mjs',
            'prettier.config.mjs',
            'node_modules/**',
            '.dev-server/**',
            'test/**',
        ],
    },
];
