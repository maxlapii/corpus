/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { es2022: true, node: true },
  ignorePatterns: [
    'node_modules',
    'dist',
    '.next',
    '.wrangler',
    'coverage',
    'apps/web/**',
    '*.cjs',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-empty-function': 'off',
    'no-console': 'off',
    eqeqeq: ['error', 'smart'],
    'no-restricted-syntax': [
      'error',
      {
        selector: "NewExpression[callee.name='Function']",
        message: 'Dynamic code generation is not allowed.',
      },
      {
        selector: "CallExpression[callee.name='eval']",
        message: 'eval() is not allowed.',
      },
    ],
  },
}
