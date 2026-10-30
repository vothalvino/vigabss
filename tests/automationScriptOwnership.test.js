'use strict';
// =============================================================================
// Phase 1 ASY-07 — shared automation scripts are read-only to other tenants
// =============================================================================
// updateScript() located the row with `id = ? AND (organization_id = ? OR
// is_shared = 1)` and then ran `UPDATE ... WHERE id = ?`, so any tenant admin
// could rewrite or unshare another tenant's shared script (or a NULL-org
// community script).
//
// Caller is org 1. Script 10 is org 1's, 20 is org 2's (shared), 30 is a
// community script (organization_id NULL, shared).
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, organizationId: 1, organization_id: 1, email: 'a@b.c', role: 'admin' };
    next();
  },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/ipAllowlist', () => ({
  ...jest.requireActual('../src/middleware/ipAllowlist'),
  createIpAllowlist: () => (_req, _res, next) => next(),
  parseAllowlist: () => [],
}));
jest.mock('../src/middleware/adminIpAllowlist', () => ({
  enforceAdminIpAllowlist: (_req, _res, next) => next(),
}));
const mockIsInstallOperator = jest.fn().mockResolvedValue(false);
jest.mock('../src/services/installOperator', () => ({
  ...jest.requireActual('../src/services/installOperator'),
  isInstallOperator: (...a) => mockIsInstallOperator(...a),
}));

const db = require('../src/config/database');
const app = require('../src/app');

const SCRIPTS = {
  10: { id: 10, organization_id: 1, is_shared: 0, name: 'mine' },
  20: { id: 20, organization_id: 2, is_shared: 1, name: 'theirs' },
  30: { id: 30, organization_id: null, is_shared: 1, name: 'community' },
};
// scheduled task 4 is org 1's, 8 is org 2's.
const TASKS = { 4: { id: 4, organization_id: 1 }, 8: { id: 8, organization_id: 2 } };

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM automation_scripts\s+WHERE id = \? AND \(organization_id = \? OR \(\? = 1 AND organization_id IS NULL\)\)/.test(sql)) {
      const [id, org, allowCommunity] = params;
      const s = SCRIPTS[Number(id)];
      const ok = s && (s.organization_id === org || (allowCommunity === 1 && s.organization_id === null));
      return [ok ? [s] : []];
    }
    if (/FROM automation_scripts WHERE id = \? AND \(organization_id = \? OR is_shared = 1\)/.test(sql)) {
      // pre-fix lookup shape: visible when own or shared
      const s = SCRIPTS[Number(params[0])];
      return [s && (s.organization_id === params[1] || s.is_shared) ? [s] : []];
    }
    if (/FROM scheduled_tasks WHERE id = \?/.test(sql)) {
      const t = TASKS[Number(params[0])];
      return [t && t.organization_id === params[1] ? [{ id: t.id }] : []];
    }
    if (/^\s*UPDATE automation_scripts/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM automation_scripts WHERE id = \?/.test(sql)) return [[SCRIPTS[Number(params[0])]]];
    if (/INSERT INTO automation_scripts/.test(sql)) return [{ insertId: 11 }];
    return [[]];
  });
}

const scriptUpdates = () => db.query.mock.calls.filter(([s]) => /^\s*UPDATE automation_scripts/.test(s));

beforeEach(() => { jest.clearAllMocks(); mockIsInstallOperator.mockResolvedValue(false); wire(); });

describe('PUT /automation-scripts/:id', () => {
  it('404s another tenant\'s shared script and writes nothing', async () => {
    const res = await request(app).put('/api/v1/automation-scripts/20').send({ script_body: 'rm -rf /', is_shared: false });
    expect(res.status).toBe(404);
    expect(scriptUpdates()).toHaveLength(0);
  });

  it('404s a community script for a tenant admin', async () => {
    const res = await request(app).put('/api/v1/automation-scripts/30').send({ is_shared: false });
    expect(res.status).toBe(404);
    expect(scriptUpdates()).toHaveLength(0);
  });

  it('lets the install operator edit a community script, bound to the NULL org', async () => {
    mockIsInstallOperator.mockResolvedValue(true);
    const res = await request(app).put('/api/v1/automation-scripts/30').send({ name: 'renamed' });
    expect(res.status).toBe(200);
    const [sql, params] = scriptUpdates()[0];
    expect(sql).toMatch(/WHERE id = \? AND organization_id <=> \?/);
    expect(params.slice(-2)).toEqual(['30', null]);
  });

  it('updates an own script with the write bound to the org', async () => {
    const res = await request(app).put('/api/v1/automation-scripts/10').send({ name: 'renamed' });
    expect(res.status).toBe(200);
    const [, params] = scriptUpdates()[0];
    expect(params.slice(-2)).toEqual(['10', 1]);
  });

  it('rejects binding an own script to another org\'s scheduled task', async () => {
    const res = await request(app).put('/api/v1/automation-scripts/10').send({ scheduled_task_id: 8 });
    expect(res.status).toBe(422);
    expect(scriptUpdates()).toHaveLength(0);
  });
});

describe('POST /automation-scripts', () => {
  it('rejects another org\'s scheduled_task_id', async () => {
    const res = await request(app).post('/api/v1/automation-scripts')
      .send({ name: 'x', language: 'bash', script_body: 'echo', scheduled_task_id: 8 });
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([s]) => /INSERT INTO automation_scripts/.test(s))).toBe(false);
  });

  it('accepts its own scheduled task', async () => {
    const res = await request(app).post('/api/v1/automation-scripts')
      .send({ name: 'x', language: 'bash', script_body: 'echo', scheduled_task_id: 4 });
    expect(res.status).toBe(201);
  });
});

describe('DELETE /automation-scripts/:id', () => {
  it('binds the soft-delete write to the caller org', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM automation_scripts/.test(sql)) return [[{ id: 10 }]];
      return [{ affectedRows: 1 }];
    });
    const res = await request(app).delete('/api/v1/automation-scripts/10');
    expect(res.status).toBe(204);
    const [sql, params] = scriptUpdates()[0];
    expect(sql).toMatch(/organization_id = \?/);
    expect(params).toEqual(['10', 1]);
  });
});
