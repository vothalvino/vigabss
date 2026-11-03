'use strict';
// =============================================================================
// TNA-37 — raw SQL cannot quietly add a by-id statement on a tenant table
// without an organization predicate
// =============================================================================
// `SELECT * FROM invoices WHERE client_id = ?` is another tenant's data
// when the id came from the request and nothing checked its owner. About 580
// statements in routes and services filter a table that has organization_id
// by an id and never name organization_id; many are safe because the handler
// checked the owning parent first, so this is a ratchet: no file may gain one.
// A new statement must filter organization_id, or say how it is scoped:
//   /* org-scoped by: <reason> */
// When a file's count drops, lower its baseline in
// tests/fixtures/orgPredicateBaseline.json in the same change. The real-DB
// sweep (tests/integration/db) checks the routes' behaviour.
// =============================================================================

const { scan, unscopedStatement } = require('./helpers/orgPredicateScan');
const baseline = require('./fixtures/orgPredicateBaseline.json');

const counts = scan();

test('the scanner flags a by-id read of a tenant table and accepts a scoped one', () => {
  const tables = new Set(['invoices', 'clients']);
  expect(unscopedStatement('SELECT * FROM invoices WHERE client_id = ?', tables)).toBe('invoices');
  expect(unscopedStatement('UPDATE clients SET name = ? WHERE id = ?', tables)).toBe('clients');
  expect(unscopedStatement('DELETE FROM clients WHERE id IN (?, ?)', tables)).toBe('clients');
  expect(unscopedStatement('SELECT * FROM invoices WHERE client_id = ? AND organization_id = ?', tables)).toBeNull();
  expect(unscopedStatement('SELECT * FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ? AND c.organization_id = ?', tables)).toBeNull();
  expect(unscopedStatement('/* org-scoped by: the client was checked above */ SELECT * FROM invoices WHERE client_id = ?', tables)).toBeNull();
  expect(unscopedStatement('SELECT * FROM plans WHERE id = ?', tables)).toBeNull();
  expect(unscopedStatement('SELECT * FROM clients WHERE email = ?', tables)).toBeNull();
});

test('no file has more unscoped by-id statements than its baseline', () => {
  const over = Object.entries(counts)
    .filter(([file, n]) => n > (baseline[file] || 0))
    .map(([file, n]) => `${file}: ${n} (baseline ${baseline[file] || 0})`);
  expect(over).toEqual([]);
});

test('the baseline is tightened when statements are scoped', () => {
  const stale = Object.entries(baseline)
    .filter(([file, n]) => (counts[file] || 0) < n)
    .map(([file, n]) => `${file}: baseline ${n}, now ${counts[file] || 0}`);
  expect(stale).toEqual([]);
});
