// =============================================================================
// FE-10 — the portal usage chart gets calendar days
// =============================================================================
// /portal/usage/current-month returned the DATE column as a UTC-midnight Date,
// serialised as '2026-11-01T00:00:00.000Z'; the chart sliced it from index 8
// and labelled bars '01T00:00:00.000Z'.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const request = require('supertest');
const db = require('../src/config/database');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

test('usage days are YYYY-MM-DD', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \?/.test(sql)) return [[{ id: 5, organization_id: 1, name: 'Ana', status: 'active', portal_token_version: 0 }]];
    if (/FROM contracts/.test(sql)) return [[{ id: 9 }]];
    if (/FROM radius_accounting_usage_daily u/.test(sql)) {
      return [[{ date: new Date('2026-11-01T00:00:00.000Z'), download_bytes: '1073741824', upload_bytes: '0', total_bytes: '1073741824', incomplete_rows: 0, unverifiable_session_rows: 0 }]];
    }
    return [[]];
  });
  const token = signPortalAccessToken({ clientId: 5, organizationId: 1, tokenVersion: 0 }, 900);
  const res = await request(app).get('/api/v1/portal/usage/current-month').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data[0].date).toBe('2026-11-01');
  expect(res.body.data[0].date.slice(8)).toBe('01');
});
