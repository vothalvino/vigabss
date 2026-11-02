// =============================================================================
// SUP-13 — requested Wi-Fi / PPPoE passwords are not kept in plaintext
// =============================================================================
// portal_service_requests.payload held new_password in plaintext from request
// to forever, and GET /cpe-management/devices/:id/tasks returned the PSK queued
// for the ACS.

process.env.ENCRYPTION_KEY = 'd'.repeat(64);

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const { decrypt } = require('../src/utils/encryption');
const service = require('../src/services/portalServiceRequestService');

beforeEach(() => jest.clearAllMocks());

test('a requested password is stored only sealed', () => {
  const stored = service.sealRequestedPassword({ new_password: 'Wifi-Pass-2026', source: 'portal' });
  expect(stored).not.toHaveProperty('new_password');
  expect(stored.new_password_sealed).not.toContain('Wifi-Pass-2026');
  expect(decrypt(stored.new_password_sealed)).toBe('Wifi-Pass-2026');
  expect(stored.source).toBe('portal');
});

test('createRequest writes the sealed payload', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM contracts c/.test(sql)) return [[{ id: 9, plan_id: 2, status: 'active' }]];
    if (/FROM radius WHERE contract_id/.test(sql)) return [[{ id: 1 }]];
    if (/^\s*INSERT INTO portal_service_requests/.test(sql)) return [{ insertId: 30 }];
    return [[{ id: 30, payload: '{}' }]];
  });
  await service.createRequest({ clientId: 5, organizationId: 1, requestType: 'pppoe_password_change', payload: { new_password: 'Pppoe-Pass-2026' } });
  const [, params] = db.query.mock.calls.find(([sql]) => /INSERT INTO portal_service_requests/.test(sql));
  const payload = params.find(p => typeof p === 'string' && p.startsWith('{'));
  expect(payload).not.toContain('Pppoe-Pass-2026');
  expect(JSON.parse(payload)).toHaveProperty('new_password_sealed');
});

test('CPE task responses never carry the queued passphrase', async () => {
  const express = require('express');
  const request = require('supertest');
  jest.doMock('../src/middleware/auth', () => ({ authenticate: (req, _res, next) => { req.user = { id: 1 }; next(); } }));
  jest.doMock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
  jest.doMock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));
  jest.doMock('../src/models/CpeDevice', () => ({ findByIdOrFail: jest.fn(async () => ({ id: 4 })) }));
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql)
    ? [[{ total: 1 }]]
    : [[{ id: 1, parameters: JSON.stringify([
      { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey', value: 'Wifi-Pass-2026' },
      { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: 'Casa' },
    ]) }]]));
  const app = express();
  app.use('/cpe-management', require('../src/routes/cpeManagement'));
  const res = await request(app).get('/cpe-management/devices/4/tasks');

  expect(res.status).toBe(200);
  expect(JSON.stringify(res.body)).not.toContain('Wifi-Pass-2026');
  expect(res.body.data[0].parameters[1].value).toBe('Casa');
});
