'use strict';
// Test fixtures must not be shaped like real credentials. A literal such as a
// Stripe webhook signing secret, even an invented one, is reported by GitHub
// secret scanning as a leaked secret on a public repository. Build such a
// value from parts instead: ['whsec', 'anything'].join('_').

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'playwright-report', 'test-results']);
const PATTERNS = {
  'Stripe webhook signing secret': /whsec_[A-Za-z0-9]{24,}/,
  'Stripe live secret key': /sk_live_[A-Za-z0-9]{16,}/,
  'Stripe live restricted key': /rk_live_[A-Za-z0-9]{16,}/,
  'Stripe test secret key': /sk_test_[A-Za-z0-9]{16,}/,
};

function files(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (/\.(js|cjs|mjs|ts|tsx|json|md|yml|yaml|sh|example)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no file contains a literal shaped like a Stripe secret', () => {
  const found = [];
  for (const file of [...files(path.join(root, 'src')), ...files(path.join(root, 'tests')), ...files(path.join(root, 'frontend', 'src')), ...files(path.join(root, 'docs'))]) {
    if (file === __filename) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      if (pattern.test(text)) found.push(`${path.relative(root, file)}: ${name}`);
    }
  }
  expect(found).toEqual([]);
});
