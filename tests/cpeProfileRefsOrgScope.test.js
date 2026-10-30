'use strict';
// =============================================================================
// VigaBSS 5.0 — CPE profile references are org-verified (NET-02)
// =============================================================================
// GET /cpe-profiles/:id and POST /:id/resolve were scoped in Phase 0 (own or
// global profile, inheritance walk and mappings scoped). The remaining half of
// NET-02: create/update stored parent_profile_id and plan_id verbatim, so a
// tenant could chain its profile onto another tenant's profile or bind it to
// another tenant's plan. Both are now checked against req.orgId (422).
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

// id -> organization_id
const PROFILES = { 1: 1, 2: null, 9: 2 };
const PLANS = { 10: 1, 20: 2 };

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (typeof sql === 'string' && sql.includes('`users`')) return [[ADMIN]];
    if (/FROM cpe_profiles\s+WHERE id = \? AND \(organization_id <=> \? OR organization_id IS NULL\)/.test(sql)) {
      const org = PROFILES[params[0]];
      const visible = org !== undefined && (org === null || org === params[1]);
      return [visible ? [{ id: Number(params[0]), organization_id: org }] : []];
    }
    if (/FROM plans/.test(sql)) {
      const org = PLANS[params[0]];
      return [org !== undefined && org === params[1] ? [{ id: Number(params[0]) }] : []];
    }
    if (/^INSERT INTO `?cpe_profiles`?/i.test(sql)) return [{ insertId: 50, affectedRows: 1 }];
    if (/^UPDATE `?cpe_profiles`?/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM `?cpe_profiles`?/i.test(sql)) return [[{ id: 1, organization_id: 1, name: 'p' }]];
    return [[]];
  });
  db.execute.mockImplementation(db.query.getMockImplementation());
}

const writes = () => db.query.mock.calls.filter(([s]) => /^(INSERT INTO|UPDATE) `?cpe_profiles`?/i.test(s));

beforeEach(() => { jest.clearAllMocks(); wire(); });

describe('POST /cpe-profiles verifies its references', () => {
  it('refuses another tenant\'s parent profile with 422 and writes nothing', async () => {
    const res = await auth(request(app).post('/api/v1/cpe-profiles')).send({ name: 'x', parent_profile_id: 9 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('refuses another tenant\'s plan with 422 and writes nothing', async () => {
    const res = await auth(request(app).post('/api/v1/cpe-profiles')).send({ name: 'x', plan_id: 20 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('accepts an own parent, a global parent, and an own plan', async () => {
    for (const body of [{ parent_profile_id: 1 }, { parent_profile_id: 2 }, { plan_id: 10 }]) {
      const res = await auth(request(app).post('/api/v1/cpe-profiles')).send({ name: 'x', ...body });
      expect(res.status).toBe(201);
    }
  });
});

describe('PUT /cpe-profiles/:id verifies its references', () => {
  it('refuses re-parenting onto another tenant\'s profile', async () => {
    const res = await auth(request(app).put('/api/v1/cpe-profiles/1')).send({ parent_profile_id: 9 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('refuses binding to another tenant\'s plan', async () => {
    const res = await auth(request(app).put('/api/v1/cpe-profiles/1')).send({ plan_id: 20 });
    expect(res.status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it('refuses a profile as its own parent', async () => {
    const res = await auth(request(app).put('/api/v1/cpe-profiles/1')).send({ parent_profile_id: 1 });
    expect(res.status).toBe(422);
  });
});
