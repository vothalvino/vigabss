'use strict';
// =============================================================================
// FE2-13 — every API call in the frontend reaches a route the backend serves
// =============================================================================
// A page calling a path or method the API does not serve gets a 404 that no
// test sees, because the page tests mock fetch. This boots app.js with a stub
// database, lists every METHOD + path it serves (the SEC-22 inventory), and
// resolves each call site in frontend/src against it. Calls whose path is
// built at run time are counted per file in
// tests/fixtures/frontendDynamicApiCalls.json.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));

const inventory = require('./helpers/routeInventory');
const { collect } = require('./helpers/frontendApiCalls');
const reviewedDynamic = require('./fixtures/frontendDynamicApiCalls.json');

inventory.install();
const app = require('../src/app');

const routes = inventory.list(app).map((r) => {
  const segments = r.path.split('/');
  return {
    method: r.method,
    re: new RegExp(`^${segments.map(seg => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
    paths: (path) => {
      const parts = path.split('/');
      return parts.length === segments.length
        && parts.every((part, i) => part === ':param' || segments[i].startsWith(':') || part === segments[i]);
    },
  };
});
const { calls, dynamic } = collect();

// A frontend ':param' is any segment: `/contracts/${id}/${action}` reaches
// /contracts/:id/suspend.
const served = (method, path) => routes.some(r => r.method === method && (r.re.test(path) || r.paths(path)));

test('the collector reads the call sites', () => {
  expect(calls.length).toBeGreaterThan(900);
  expect(served('GET', '/api/v1/clients/:param')).toBe(true);
  expect(served('DELETE', '/api/v1/no-such-thing')).toBe(false);
});

test('every frontend API call resolves to a served route and method', () => {
  const missing = calls
    .filter(c => !served(c.method, c.path))
    .map(c => `${c.method} ${c.path} (${c.where})`);
  expect(missing).toEqual([]);
});

test('calls with a run-time path match the reviewed count per file', () => {
  const counts = {};
  for (const where of dynamic) {
    const file = where.replace(/:\d+$/, '');
    counts[file] = (counts[file] || 0) + 1;
  }
  expect(counts).toEqual(reviewedDynamic);
});
