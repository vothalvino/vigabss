// =============================================================================
// DB-03 — the portal dashboard works for a subscriber with an active contract
// =============================================================================
// The session block joined `radacct`, a FreeRADIUS SQL table no install has
// (VigaBSS never creates it), with non-stock column names, so GET
// /portal/dashboard 500ed for every subscriber with an active contract. The
// live session now comes from VigaBSS's own connection_logs projection.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.access.token'),
  verify: jest.fn(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

function fixture({ live }) {
  db.query.mockImplementation(async (sql) => {
    // The real server has no radacct table: any query against it fails.
    if (/\bradacct\b/.test(sql)) throw Object.assign(new Error("Table 'vigabss.radacct' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    if (/FROM clients WHERE id = \?/.test(sql)) {
      return [[{ id: 1, organization_id: 5, name: 'Alice', email: 'alice@example.com', status: 'active' }]];
    }
    if (/FROM contracts c/.test(sql) && /JOIN plans/.test(sql)) {
      return [[{ contract_id: 40, contract_status: 'active', plan_id: 3, plan_name: '100M', price: '499.00' }]];
    }
    if (/FROM radius r/.test(sql)) return [[{ username: 'alice-pppoe', radius_status: 'active' }]];
    if (/FROM connection_logs cl/.test(sql)) {
      return [live ? [{ id: 9, contract_id: 40, framed_ip: '100.64.0.9', calling_station_id: 'AA:BB:CC:00:11:22', session_duration: 3600, bytes_in: 1000, bytes_out: 200 }] : []];
    }
    if (/FROM radius_accounting_usage_daily/.test(sql)) return [[{ bytes_in: 0, bytes_out: 0, incomplete_rows: 0, observed_rows: 0, unverifiable_session_rows: 0 }]];
    if (/MIN\(due_date\)/.test(sql)) return [[{ next_due: null }]];
    return [[]];
  });
}

const dashboard = () => request(app).get('/api/v1/portal/dashboard').set('Authorization', 'Bearer portal.valid');

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ sub: 1, orgId: 5, type: 'portal' });
});

test('a connected subscriber sees the live session from connection_logs', async () => {
  fixture({ live: true });
  const res = await dashboard();
  expect(res.status).toBe(200);
  expect(res.body.data.session).toEqual({
    status: 'connected', username: 'alice-pppoe', ip: '100.64.0.9', mac: 'AA:BB:CC:00:11:22',
    session_seconds: 3600, bytes_in: 1000, bytes_out: 200,
  });
  const [, params] = db.query.mock.calls.find(([sql]) => /FROM connection_logs cl/.test(sql));
  expect(params).toEqual([40, 5]); // this contract, this organization
});

test('an offline subscriber is shown as disconnected, not as an error', async () => {
  fixture({ live: false });
  const res = await dashboard();
  expect(res.status).toBe(200);
  expect(res.body.data.session.status).toBe('disconnected');
});

test('the RADIUS account lookup is scoped to the organization and ignores deleted rows', async () => {
  fixture({ live: false });
  await dashboard();
  const [sql, params] = db.query.mock.calls.find(([s]) => /FROM radius r/.test(s));
  expect(sql).toMatch(/r\.organization_id <=> \?/);
  expect(sql).toMatch(/r\.deleted_at IS NULL/);
  expect(params).toEqual([40, 5]);
});
