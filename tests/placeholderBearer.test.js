// =============================================================================
// FE-03 — a placeholder Bearer header falls back to the session cookie
// =============================================================================
// After a reload the SPA holds no in-memory access token and authenticates
// with the fireisp_access cookie, but several pages sent
// `Authorization: Bearer ${token}` anyway. "Bearer null" / "Bearer " took
// precedence over the cookie and every request failed with 401. Such a header
// is no credential: authentication uses the cookie, and a write still needs
// the CSRF token.
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
const { bearerToken } = require('../src/utils/bearerToken');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test.each([
  ['Bearer null', null], ['Bearer undefined', null], ['Bearer ', null], ['Bearer  ', null],
  ['Bearer abc.def', 'abc.def'], ['Basic abc', null], [undefined, null],
])('bearerToken(%j) is %j', (header, expected) => {
  expect(bearerToken({ headers: header === undefined ? {} : { authorization: header } })).toBe(expected);
});

test.each(['Bearer null', 'Bearer '])('a read with %j and the session cookie is authenticated by the cookie', async (header) => {
  const res = await request(app).get('/api/v1/onu-management/profiles')
    .set('Authorization', header).set('Cookie', `fireisp_access=${token}`);
  expect(res.status).toBe(200);
});

test('a real but invalid Bearer token is still refused, cookie or not', async () => {
  const res = await request(app).get('/api/v1/onu-management/profiles')
    .set('Authorization', 'Bearer not-a-jwt').set('Cookie', `fireisp_access=${token}`);
  expect(res.status).toBe(401);
});

test('a cookie-authenticated write with a placeholder Bearer header still needs the CSRF token', async () => {
  const res = await request(app).post('/api/v1/onu-management/profiles')
    .set('Authorization', 'Bearer null').set('Cookie', `fireisp_access=${token}`)
    .send({ name: 'P' });
  expect(res.status).toBe(403);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO onu_profiles/.test(sql))).toBe(false);
});
