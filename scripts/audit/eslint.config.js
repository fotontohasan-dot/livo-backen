// scripts/audit/eslint.config.js — শুধু অডিটের জন্য; প্রজেক্টের নিজস্ব lint কনফিগ নয়।
const globals = require('../../.audit-tools/node_modules/globals');
const common = {
  'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error', 'no-redeclare': 'error', 'no-self-assign': 'error', 'no-unsafe-finally': 'error',
  'no-async-promise-executor': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['warn', { allowEmptyCatch: true }], 'no-useless-catch': 'warn'
};
module.exports = [
  { files: ['**/*.js'], ignores: ['public/**', 'assets/**', 'node_modules/**', '.audit-tools/**', 'tests/**', 'sports-api/**', 'verify_all.spec.js', 'src/**', 'reports/**'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } }, rules: common },
  { files: ['public/**/*.js', 'assets/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, io: 'readonly', Chart: 'readonly', Swal: 'readonly', confetti: 'readonly', THREE: 'readonly' } }, rules: common }
];
