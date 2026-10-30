'use strict';
// =============================================================================
// VigaBSS 5.0 — Subscriber certificate references are org-verified (TNB-08)
// =============================================================================
// The list-by-client/account and revoke paths were scoped in Phase 0. The
// remaining half: POST/PUT stored client_id and radius_account_id verbatim, so
// a tenant could register (or move) a certificate onto another tenant's RADIUS
// account, changing that subscriber's TLS-Cert-Serial pin at the next sync.
// =============================================================================

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(), off: jest.fn(), once: jest.fn(), removeListener: jest.fn(),
}));

const config = require('../src/config');
const db = require('../src/config/database');
const app = require('../src/app');

const ADMIN = { id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 1 };
const token = () => jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const auth = (r) => r.set('Authorization', `Bearer ${token()}`);

const CLIENTS = { 3: 1, 4: 1, 9: 2 };                 // id -> org
const RADIUS = { 5: { client_id: 3 }, 6: { client_id: 4 }, 50: { client_id: 9 } };
const CERT = { id: 70, organization_id: 1, client_id: 3, radius_account_id: 5, status: 'active' };

function handle(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (s.includes('`users`')) return [[ADMIN]];
  if (/FROM `radius` r JOIN clients cl/.test(s)) {
    const r = RADIUS[params[0]];
    if (!r) return [[]];
    if (/cl\.organization_id = \?/.test(s) && CLIENTS[r.client_id] !== params[1]) return [[]];
    return [[{ id: Number(params[0]), client_id: r.client_id }]];
  }
  if (/FROM `?clients`?/.test(s)) {
    const org = CLIENTS[params[0]];
    if (org === undefined) return [[]];
    if (/organization_id = \?/.test(s) && org !== params[1]) return [[]];
    return [[{ id: Number(params[0]), organization_id: org }]];
  }
  if (/^INSERT INTO `?subscriber_certificates`?/i.test(s)) return [{ insertId: 71, affectedRows: 1 }];
  if (/^UPDATE `?subscriber_certificates`?/i.test(s)) return [{ affectedRows: 1 }];
  if (/FROM `?subscriber_certificates`?/i.test(s)) return [[CERT]];
  return [[]];
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params) => handle(sql, params));
  db.execute.mockImplementation(async (sql, params) => handle(sql, params));
});

const writes = () => db.query.mock.calls.filter(([s]) => /^(INSERT INTO|UPDATE) `?subscriber_certificates`?/i.test(String(s).trim()));

const BASE_CERT = {
  common_name: 'sub@isp.test',
  serial_number: '0ABC',
  fingerprint_sha256: 'a'.repeat(64),
  valid_from: '2026-01-01',
  valid_until: '2027-01-01',
};

describe('POST /subscriber-certificates verifies references', () => {
  it.each([
    ['a foreign client_id', { client_id: 9 }],
    ['a foreign radius_account_id', { radius_account_id: 50 }],
    ['an own account belonging to a different own client', { client_id: 3, radius_account_id: 6 }],
  ])('422s for %s and writes nothing', async (_label, refs) => {
    const res = await auth(request(app).post('/api/v1/subscriber-certificates')).send({ ...BASE_CERT, ...refs });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('accepts a matching own client and account', async () => {
    const res = await auth(request(app).post('/api/v1/subscriber-certificates'))
      .send({ ...BASE_CERT, client_id: 3, radius_account_id: 5 });
    expect(res.status).toBe(201);
  });
});

describe('PUT /subscriber-certificates/:id verifies references', () => {
  it('refuses moving a certificate onto another tenant\'s RADIUS account', async () => {
    const res = await auth(request(app).put('/api/v1/subscriber-certificates/70')).send({ radius_account_id: 50 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('refuses moving a certificate onto another tenant\'s client', async () => {
    const res = await auth(request(app).put('/api/v1/subscriber-certificates/70')).send({ client_id: 9 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });
});
