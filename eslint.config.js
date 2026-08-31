import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Scratch/debug artifacts (tmp-session-*.cjs etc.) are not shipped and are
    // not part of the lint-gated publish surface.
    ignores: ['dist/**', 'node_modules/**', 'scripts/tmp-*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // CommonJS helper scripts (e.g. scripts/copy-web-static.cjs) run under Node.
    files: ['**/*.cjs'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
