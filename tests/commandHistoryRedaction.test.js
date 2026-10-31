// =============================================================================
// NET-10 (rest) — no credentials in the router command history
// =============================================================================
// dispatchCommand stored its params verbatim in device_command_executions,
// and the history is listed to every device_command_executions.view holder,
// so pppoe_create's secretPassword stayed readable there.
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
const routerDriverService = require('../src/services/routerDriverService');
const { redactSecretParams } = require('../src/utils/secretRedaction');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

describe('redactSecretParams', () => {
  test('replaces credential-named keys at any depth and keeps the rest', () => {
    expect(redactSecretParams({
      name: 'sub1', secretPassword: 'pppoe-pass', profile: 'default',
      auth: { api_key: 'k', user: 'admin' }, peers: [{ preshared_key: 'psk', host: 'h' }],
    })).toEqual({
      name: 'sub1', secretPassword: '[REDACTED]', profile: 'default',
      auth: { api_key: '[REDACTED]', user: 'admin' }, peers: [{ preshared_key: '[REDACTED]', host: 'h' }],
    });
  });

  test('a JSON string (MariaDB JSON column) stays a JSON string', () => {
    expect(redactSecretParams('{"name":"a","password":"p"}')).toBe('{"name":"a","password":"[REDACTED]"}');
  });

  test('empty values and non-JSON text are left as they are', () => {
    expect(redactSecretParams({ password: '' })).toEqual({ password: '' });
    expect(redactSecretParams('not json')).toBe('not json');
    expect(redactSecretParams(null)).toBeNull();
  });
});

test('dispatchCommand stores pppoe_create without the PPPoE password', async () => {
  db.query
    .mockResolvedValueOnce([[{ id: 1, vendor: 'zte', device_id: 4, protocol: 'ssh', encrypted_password: null }]])
    .mockResolvedValueOnce([{ insertId: 7 }]);

  await routerDriverService.dispatchCommand(1, 1, 'pppoe_create', { name: 'sub1', secretPassword: 'pppoe-pass' }, 3);

  const [sql, values] = db.query.mock.calls[1];
  expect(sql).toMatch(/INSERT INTO device_command_executions/);
  expect(JSON.stringify(values)).not.toContain('pppoe-pass');
  expect(JSON.parse(values[5])).toEqual({ name: 'sub1', secretPassword: '[REDACTED]' });
});

test('the command history list redacts rows stored before this release', async () => {
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql)
    ? [[{ total: 1 }]]
    : [[{ id: 1, command: 'pppoe_create', params: '{"name":"sub1","secretPassword":"old-pass"}' }]]));
  const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

  const res = await request(app).get('/api/v1/router-drivers/command-executions/list')
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');

  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain('old-pass');
  expect(JSON.parse(res.body.data[0].params).name).toBe('sub1');
});
