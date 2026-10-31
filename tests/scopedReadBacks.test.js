// =============================================================================
// TNA-19 / TNB-22 / RTE-02 — read-backs after a write stay in the tenant
// =============================================================================
// These handlers ran an organization-scoped UPDATE, then re-read the row by id
// alone. For another tenant's id the UPDATE matched nothing and the read-back
// returned that tenant's row anyway: its alert chains, maintenance windows,
// suppression rules, data-pack purchases, traffic-engineering policies and
// router driver configs.
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

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

const FOREIGN = { id: 900, organization_id: 2, name: 'tenant-2 row', status: 'active' };

// Row 900 belongs to organization 2: scoped writes match nothing, and only a
// read that leaves out the caller's organization finds it.
beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) return [{ affectedRows: 0, insertId: 0 }];
    if (/^\s*SELECT/.test(sql) && params.map(String).includes('900') && !params.map(String).includes('1')) {
      return [[FOREIGN]];
    }
    return [[]];
  });
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test.each([
  ['put', '/alerts/escalation-chains/900', { name: 'x' }],
  ['put', '/alerts/maintenance-windows/900', { name: 'x' }],
  ['put', '/alerts/notification-channels/900', { name: 'x' }],
  ['put', '/alerts/suppression-rules/900', { name: 'x' }],
  ['put', '/data-pack-purchases/900/cancel', {}],
  ['post', '/interface-qos-policies/900/restore', {}],
  ['post', '/dscp-marking-policies/900/restore', {}],
  ['put', '/router-drivers/900', { host: 'r1.example' }],
])('%s %s on another tenant\'s id returns 404, not its row', async (method, path, body) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(404);
  expect(JSON.stringify(res.body)).not.toContain('tenant-2 row');
});

test('a router driver config cannot be bound to another tenant\'s device', async () => {
  const res = await call('post', '/router-drivers', { vendor: 'mikrotik', host: 'r1.example', device_id: 900 });
  expect(res.status).toBe(422);
  expect(db.query.mock.calls.some(([sql]) => /^\s*INSERT INTO router_driver_configs/.test(sql))).toBe(false);
});

test('secret-named extra_params keys are redacted in driver config responses', () => {
  const { sanitizeConfig } = require('../src/services/routerDriverService');
  const out = sanitizeConfig({ id: 1, encrypted_password: 'enc', api_token: null, extra_params: JSON.stringify({ enable_password: 'p@ss', vrf: 'mgmt' }) });
  expect(out.encrypted_password).toBeUndefined();
  expect(out.extra_params).not.toContain('p@ss');
  expect(out.extra_params).toContain('mgmt');
});

// TNA-20: parents named in the path are checked before the write or read.
test.each([
  ['post', '/alerts/escalation-chains/900/steps', { step_number: 1, notification_channel: 'email', recipient_email: 'a@x.test' }, /INSERT INTO alert_escalation_steps/],
  ['post', '/contracts/900/data-packs/1/purchase', {}, /INSERT INTO data_pack_purchases/],
  ['get', '/contracts/900/data-packs', undefined, /FROM data_pack_purchases/],
  ['get', '/contracts/900/rollover', undefined, /FROM data_rollover_balances/],
])('%s %s under another tenant\'s parent is 404 and touches nothing', async (method, path, body, touched) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(404);
  expect(db.query.mock.calls.some(([sql]) => touched.test(sql))).toBe(false);
});

test('a data pack cannot be purchased onto another tenant\'s contract', async () => {
  const { purchasePack } = require('../src/services/dataPackService');
  // The pack is live and visible; only the contract is foreign.
  db.query.mockImplementation(async (sql) => {
    if (/FROM data_packs/.test(sql)) return [[{ id: 1, data_gb: '10.000', validity_days: 30 }]];
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 5 }];
    return [[]];
  });
  await expect(purchasePack(1, 900, 1, {})).rejects.toMatchObject({ status: 404 });
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO data_pack_purchases/.test(sql))).toBe(false);
});
