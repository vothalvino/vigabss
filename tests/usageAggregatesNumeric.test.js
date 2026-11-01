// =============================================================================
// FE-09 — usage totals are numbers, not concatenated strings
// =============================================================================
// SUM() over BIGINT is DECIMAL, which mysql2 returns as a string. The portal
// dashboard computed bytes_in + bytes_out, so '5000000000' + '1000000000'
// became 50000000001000000000 and total_gb read about 4.66e10; Session
// Accounting added the /top-consumers strings the same way.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

// What mysql2 returns for SUM() over BIGINT columns.
const SUMS = { bytes_in: '5000000000', bytes_out: '1000000000', bytes_total: '6000000000', duration_seconds: '7200', session_count: 3, active_days: 2 };

beforeEach(() => jest.clearAllMocks());

test('the portal dashboard adds download and upload as numbers', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \?/.test(sql)) return [[{ id: 5, organization_id: 1, name: 'Ana', status: 'active', portal_token_version: 0 }]];
    if (/FROM contracts c/.test(sql)) return [[{ contract_id: 9, contract_status: 'active' }]];
    if (/FROM radius_accounting_usage_daily/.test(sql)) {
      return [[{ bytes_in: SUMS.bytes_in, bytes_out: SUMS.bytes_out, incomplete_rows: '0', observed_rows: 4, unverifiable_session_rows: 0 }]];
    }
    if (/next_due/.test(sql)) return [[{ next_due: null }]];
    return [[]];
  });
  const token = signPortalAccessToken({ clientId: 5, organizationId: 1, tokenVersion: 0 }, 900);
  const res = await request(app).get('/api/v1/portal/dashboard').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.usage_this_month).toMatchObject({ download_bytes: 5e9, upload_bytes: 1e9, total_bytes: 6e9, total_gb: 5.588 });
});

test.each(['/api/v1/connection-logs/daily-usage', '/api/v1/connection-logs/top-consumers'])('%s returns numeric aggregates', async (path) => {
  db.query.mockImplementation(async (sql) => {
    if (/COUNT\(\*\) AS total FROM \(SELECT 1/.test(sql)) return [[{ total: 1 }]];
    if (/FROM radius_accounting_usage_daily u/.test(sql)) {
      return [[{ usage_date: '2026-10-01', client_id: 1, contract_id: 9, username: 'u', ...SUMS, incomplete_rows: 0, unverifiable_session_rows: 0 }]];
    }
    return [[]];
  });
  const res = await request(app).get(path);
  expect(res.status).toBe(200);
  const [row] = res.body.data;
  for (const key of ['bytes_in', 'bytes_out', 'bytes_total', 'duration_seconds']) expect(typeof row[key]).toBe('number');
  expect(row.bytes_in + row.bytes_out).toBe(6e9);
});
