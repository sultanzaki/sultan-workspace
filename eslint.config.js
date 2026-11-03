import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['vite.config.js', 'eslint.config.js', 'playwright.config.js', 'server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
