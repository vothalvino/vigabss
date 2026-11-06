// =============================================================================
// Every operation docs/openapi.json advertises is served by the app
// =============================================================================
// spec:check only proves docs/openapi.json matches its generator; nothing
// proved the generator matches Express. A walk of the live API found GET
// /reports/revenue, /reports/clients, /reports/usage and /usage documented but
// answering "Route not found". cfdiRoutesInSpec checks both directions for
// the CFDI area; this checks the spec-to-routes direction everywhere.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), queryReplica: jest.fn().mockResolvedValue([[]]),
  execute: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn(), close: jest.fn(),
}));

const inventory = require('./helpers/routeInventory');

inventory.install();
const app = require('../src/app');
const spec = require('../docs/openapi.json');

const PREFIX = spec.servers[0].url; // '/api/v1'
const shape = (p) => p.replace(/\{[^}]+\}/g, ':').replace(/:\w+/g, ':').replace(/\/$/, '');
// A path item may override the base (e.g. /metrics at the server root).
const base = (item) => (item.servers?.[0]?.url ?? PREFIX).replace(/\/$/, '');

test('the spec advertises no operation that Express does not serve', () => {
  const served = new Set(inventory.list(app).map((r) => `${r.method} ${shape(r.path)}`));
  const phantom = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const op = `${method.toUpperCase()} ${shape(base(item) + p)}`;
      if (!served.has(op)) phantom.push(`${method.toUpperCase()} ${p}`);
    }
  }
  expect(phantom.sort()).toEqual([]);
});
