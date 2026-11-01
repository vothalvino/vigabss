// =============================================================================
// TNB-21 — wireless client-session ingest is a guarded, validated write
// =============================================================================
// POST /wireless/clients/batch inserted rows under the read slug
// wireless_clients.view, for any device_id, with unchecked values and no size
// cap.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const token = jwt.sign({ sub: 2, email: 't@test.com', role: 'technician', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const post = (sessions) => request(app).post('/api/v1/wireless/clients/batch')
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send({ sessions });
const session = (extra = {}) => ({ device_id: 5, mac_address: 'AA:BB:CC:DD:EE:01', signal_dbm: -61, ...extra });
const inserted = () => db.query.mock.calls.some(([sql]) => /INSERT INTO wireless_client_sessions/.test(sql));

beforeEach(() => {
  db.query.mockReset();
  // Device 5 is this organization's; 900 is not.
  db.query.mockImplementation(async (sql, params = []) => {
    if (/^\s*INSERT/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM devices WHERE id IN/.test(sql)) return [params.slice(0, -1).filter(id => Number(id) === 5).map(id => ({ id }))];
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 2, email: 't@test.com', status: 'active', role: 'technician', organization_id: 1 });
  User.getPermissions.mockResolvedValue(['wireless_clients.view', 'wireless_clients.ingest']);
});

test('the read slug alone cannot ingest', async () => {
  User.getPermissions.mockResolvedValue(['wireless_clients.view']);
  const res = await post([session()]);
  expect(res.status).toBe(403);
  expect(inserted()).toBe(false);
});

test('another tenant\'s device is refused', async () => {
  const res = await post([session(), session({ device_id: 900 })]);
  expect(res.status).toBe(422);
  expect(inserted()).toBe(false);
});

test.each([
  [{ mac_address: 'not-a-mac' }],
  [{ signal_dbm: 40 }],
  [{ ccq_pct: 140 }],
  [{ device_id: 'abc' }],
])('an invalid session %j is refused', async (extra) => {
  const res = await post([session(extra)]);
  expect(res.status).toBe(422);
  expect(inserted()).toBe(false);
});

test('a batch over 1000 sessions is refused', async () => {
  const res = await post(Array.from({ length: 1001 }, () => session()));
  expect(res.status).toBe(422);
  expect(inserted()).toBe(false);
});

test('a valid batch for an owned device is recorded', async () => {
  const res = await post([session(), session({ mac_address: 'aa-bb-cc-dd-ee-02' })]);
  expect(res.status).toBe(201);
  expect(inserted()).toBe(true);
});
