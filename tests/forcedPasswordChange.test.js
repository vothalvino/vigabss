// =============================================================================
// Forced password change at first login (migration 479)
// =============================================================================
// The installer prints the first administrator's generated password on the
// console; nothing made the operator replace it. That account is now created
// with must_change_password = 1 and can only read its profile, change the
// password, or log out until it does.
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
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const authService = require('../src/services/authService');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'ops@isp.example', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const as = (method, path, body) => request(app)[method](path)
  .set('Authorization', `Bearer ${token}`).send(body);
const flagged = { id: 1, email: 'ops@isp.example', status: 'active', role: 'admin', organization_id: 1, must_change_password: 1 };

beforeEach(() => {
  jest.restoreAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue([[]]);
  User.findById.mockResolvedValue({ ...flagged });
  User.getOrganizations.mockResolvedValue([]);
});

test.each([
  ['get', '/api/v1/clients'],
  ['get', '/api/v1/invoices'],
  ['post', '/api/v1/users'],
])('%s %s is refused until the password is changed', async (method, path) => {
  const res = await as(method, path, {});
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
});

test('the profile stays readable and says a change is required', async () => {
  const res = await as('get', '/api/v1/auth/me');
  expect(res.status).toBe(200);
  expect(res.body.data.must_change_password).toBe(1);
});

test('changing the password is allowed and clears the flag', async () => {
  const change = jest.spyOn(authService, 'changePassword').mockResolvedValue({ message: 'Password changed successfully' });
  const res = await as('post', '/api/v1/auth/change-password', { currentPassword: 'printed-once', newPassword: 'a-brand-new-one' });
  expect(res.status).toBe(200);
  expect(change).toHaveBeenCalledWith(1, 'printed-once', 'a-brand-new-one');
});

test('an account without the flag is unaffected', async () => {
  User.findById.mockResolvedValue({ ...flagged, must_change_password: 0 });
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  const res = await as('get', '/api/v1/clients');
  expect(res.status).not.toBe(403);
});

describe('authService.changePassword', () => {
  beforeEach(() => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('new-hash');
    User.findById.mockResolvedValue({ id: 1, password_hash: 'old-hash' });
  });

  test('clears must_change_password with the new hash', async () => {
    await authService.changePassword(1, 'printed-once', 'a-brand-new-one');
    const [sql, params] = db.query.mock.calls.find(([s]) => /UPDATE users SET password_hash/.test(s));
    expect(sql).toMatch(/must_change_password = 0/);
    expect(params).toEqual(['new-hash', 1]);
  });

  test('refuses keeping the same password', async () => {
    await expect(authService.changePassword(1, 'printed-once', 'printed-once')).rejects.toMatchObject({ statusCode: 422 });
  });
});

test('the installer-created administrator must change the password', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../src/scripts/bootstrap.js'), 'utf8');
  expect(source).toMatch(/is_install_operator, must_change_password\)[\s\S]{0,200}'active', 1, 1\)/);
});
