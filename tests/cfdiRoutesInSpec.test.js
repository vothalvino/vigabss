// =============================================================================
// CFD-14 — the CFDI-area routers and the OpenAPI spec list the same operations
// =============================================================================
// docs/openapi.json omitted ten CFDI-area routes (payment complements,
// cancellation status, reconciliation, conceptos, related, cancel, CSD
// restore, PAC environment and restore) and advertised DELETE
// /facturas-publicas/{id}, which Express does not serve. This walks each
// router's stack and diffs it against the spec in both directions.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));

const spec = require('../docs/openapi.json');

const MOUNTS = {
  '/cfdi': '../src/routes/cfdi',
  '/cfdi-documents': '../src/routes/cfdiDocuments',
  '/facturas-publicas': '../src/routes/facturasPublicas',
  '/csd-certificates': '../src/routes/csdCertificates',
  '/pac-providers': '../src/routes/pacProviders',
  '/sat-catalogs': '../src/routes/satCatalogs',
};

const toSpecPath = (p) => p.replace(/:(\w+)/g, '{$1}').replace(/\/$/, '');
const normalise = (p) => p.replace(/\{[^}]+\}/g, '{}');

function expressOperations() {
  const ops = new Set();
  for (const [mount, mod] of Object.entries(MOUNTS)) {
    const router = require(mod);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        ops.add(`${method.toUpperCase()} ${normalise(toSpecPath(mount + layer.route.path))}`);
      }
    }
  }
  return ops;
}

function specOperations() {
  const ops = new Set();
  for (const [p, methods] of Object.entries(spec.paths)) {
    const full = normalise(p.replace(/^\/api\/v1/, ''));
    if (!Object.keys(MOUNTS).some((m) => full === m || full.startsWith(`${m}/`))) continue;
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) ops.add(`${method.toUpperCase()} ${full}`);
    }
  }
  return ops;
}

test('every CFDI-area Express route is in the spec', () => {
  const documented = specOperations();
  expect([...expressOperations()].filter((op) => !documented.has(op)).sort()).toEqual([]);
});

test('the spec advertises no CFDI-area operation that Express does not serve', () => {
  const served = expressOperations();
  expect([...specOperations()].filter((op) => !served.has(op)).sort()).toEqual([]);
});
