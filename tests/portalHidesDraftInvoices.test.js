// =============================================================================
// TNB-30 — the subscriber portal never lists or serves draft invoices
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const request = require('supertest');
const db = require('../src/config/database');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const token = signPortalAccessToken({ clientId: 10 }, 900);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \? AND deleted_at IS NULL LIMIT 1/.test(sql)) {
      return [[{ id: 10, organization_id: 1, name: 'Ana', email: 'ana@x.mx', status: 'active', portal_token_version: 0 }]];
    }
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 0 }]];
    return [[]];
  });
});

const invoiceQueries = () => db.query.mock.calls.map(([sql]) => sql).filter(sql => /FROM invoices/.test(sql));

test.each([
  ['the list', '/api/v1/portal/invoices'],
  ['the detail', '/api/v1/portal/invoices/5'],
  ['the PDF', '/api/v1/portal/invoices/5/pdf'],
  ['the CFDI', '/api/v1/portal/invoices/5/cfdi'],
])('%s excludes drafts', async (_label, path) => {
  await request(app).get(path).set('Authorization', `Bearer ${token}`);
  const queries = invoiceQueries();
  expect(queries.length).toBeGreaterThan(0);
  for (const sql of queries) expect(sql).toMatch(/status <> 'draft'/);
});
