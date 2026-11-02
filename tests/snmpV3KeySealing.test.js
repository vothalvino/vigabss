// =============================================================================
// NET-31 — SNMPv3 device keys are always stored encrypted
// =============================================================================
// Device POST/PUT/PATCH declared no v3 fields, validate() kept undeclared keys
// and Device.fillable has the *_encrypted columns, so a client-sent value was
// stored verbatim (and decrypt() passes non-ciphertext through). Discovery
// onboarding created v3 devices without the scan's credentials.

// A real key, so "sealed" means ciphertext rather than the dev passthrough.
process.env.ENCRYPTION_KEY = 'c'.repeat(64);

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, organizationId: 4 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 4; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));
jest.mock('../src/services/deviceAuthz', () => ({ assertDeviceClientFk: jest.fn(async () => {}) }));
jest.mock('../src/models/Device', () => ({ create: jest.fn(async d => ({ id: 70, ...d })), tableName: 'devices' }));

const db = require('../src/config/database');
const Device = require('../src/models/Device');
const { decrypt } = require('../src/utils/encryption');
const { sealSnmpV3Keys } = require('../src/utils/deviceSanitize');

function run(body, method = 'POST') {
  const req = { method, body: { ...body } };
  let err;
  sealSnmpV3Keys(req, {}, (e) => { err = e; });
  return { req, err };
}

test('plaintext v3 keys are sealed and the plaintext fields dropped', () => {
  const { req, err } = run({ snmp_v3_auth_key: 'auth-pass-123', snmp_v3_priv_key: 'priv-pass-456' });
  expect(err).toBeUndefined();
  expect(req.body).not.toHaveProperty('snmp_v3_auth_key');
  expect(req.body.snmp_v3_auth_key_encrypted).not.toBe('auth-pass-123');
  expect(decrypt(req.body.snmp_v3_auth_key_encrypted)).toBe('auth-pass-123');
  expect(decrypt(req.body.snmp_v3_priv_key_encrypted)).toBe('priv-pass-456');
});

test('a client-sent *_encrypted value is refused, not stored verbatim', () => {
  const { err } = run({ snmp_v3_auth_key_encrypted: 'not-really-ciphertext' });
  expect(err).toMatchObject({ statusCode: 422 });
});

test('a blank key on an edit keeps the stored one', () => {
  const { req } = run({ snmp_v3_auth_key: '' }, 'PUT');
  expect(req.body).not.toHaveProperty('snmp_v3_auth_key_encrypted');
});

test('the device schemas declare the v3 fields', () => {
  const { createDevice, updateDevice } = require('../src/middleware/schemas/devices');
  for (const schema of [createDevice, updateDevice]) {
    expect(schema).toHaveProperty('snmp_v3_auth_key');
    expect(schema).toHaveProperty('snmp_v3_priv_key');
    expect(schema.snmp_v3_auth_protocol.enum).toContain('sha256');
  }
});

test('onboarding a v3 discovery result copies the scan credentials, still encrypted', async () => {
  const router = require('../src/routes/discoveryScans');
  const app = express();
  app.use(express.json());
  app.use('/discovery-scans', router);
  db.query.mockImplementation(async (sql) => {
    if (/FROM discovery_results WHERE id = \? AND scan_id = \?/.test(sql)) {
      return [[{ id: 8, scan_id: 2, organization_id: 4, status: 'new', ip_address: '10.0.0.9', snmp_version: 3 }]];
    }
    if (/FROM discovery_scans WHERE id = \? AND organization_id = \?/.test(sql)) {
      return [[{ snmp_v3_security_name: 'noc', snmp_v3_auth_protocol: 'sha256', snmp_v3_auth_key_encrypted: 'enc:auth', snmp_v3_priv_protocol: 'aes128', snmp_v3_priv_key_encrypted: 'enc:priv' }]];
    }
    return [{ affectedRows: 1 }];
  });

  const res = await request(app).post('/discovery-scans/2/results/8/onboard').send({});

  expect(res.status).toBeLessThan(300);
  expect(Device.create).toHaveBeenCalledWith(expect.objectContaining({
    snmp_version: 'v3', snmp_v3_security_name: 'noc',
    snmp_v3_auth_key_encrypted: 'enc:auth', snmp_v3_priv_key_encrypted: 'enc:priv',
  }));
});
