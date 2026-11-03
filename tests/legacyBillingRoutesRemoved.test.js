'use strict';
// =============================================================================
// BIL-28 — the legacy bulk invoice-generation routes are gone
// =============================================================================
// POST /billing/bulk-generate and POST /bulk/invoices/generate duplicated the
// billing_cycle task, each with its own copy of the contract and period rules
// (and /bulk/invoices/generate once invoiced other tenants' contracts,
// TNA-12). Nothing in the frontend called them. Invoicing due contracts is the
// billing_cycle task's job; one invoice is POST /billing/generate-invoice or
// POST /invoices/generate.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const app = require('../src/app');
const spec = require('../docs/openapi.json');

const AUTH = 'Bearer ' + jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

beforeEach(() => {
  db.query.mockImplementation(async (sql) => {
    if (String(sql).includes('`users`')) return [[{ id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 1 }]];
    return [[]];
  });
});

test.each([
  '/api/v1/billing/bulk-generate',
  '/api/v1/bulk/invoices/generate',
])('POST %s is not served and writes nothing', async (path) => {
  const res = await request(app).post(path).set('Authorization', AUTH).send({ contract_ids: [1] });

  expect(res.status).toBe(404);
  expect(db.query.mock.calls.some(([sql]) => /billing_periods|INSERT INTO invoices/.test(String(sql)))).toBe(false);
});

test('the OpenAPI contract no longer advertises them', () => {
  expect(spec.paths['/billing/bulk-generate']).toBeUndefined();
  expect(spec.paths['/bulk/invoices/generate']).toBeUndefined();
  expect(spec.paths['/billing/generate-invoice']).toBeDefined();
});
