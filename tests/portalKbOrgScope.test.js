'use strict';
// =============================================================================
// Phase 1 TNB-07 — staff portal-KB /:id routes are tenant-scoped
// =============================================================================
// The router mounted only `authenticate`, and GET/PUT/DELETE /:id ran
// `WHERE id = ?`, so a tenant-A technician could read and rewrite tenant B's
// articles and the installation-shared (NULL-org) ones every portal serves,
// and a tenant-A admin could delete them.
//
// Caller is org 1. Article 10 is org 1's, 20 is org 2's, 30 is shared (NULL).
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 7, organizationId: 1, organization_id: 1, email: 't@b.c', role: 'technician' };
    next();
  },
}));
const mockOrgScope = jest.fn((req, _res, next) => { req.orgId = req.user.organizationId; next(); });
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (...a) => mockOrgScope(...a) }));
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

const ARTICLES = {
  10: { id: 10, organization_id: 1, title: 'Mine', deleted_at: null },
  20: { id: 20, organization_id: 2, title: 'Theirs', deleted_at: null },
  30: { id: 30, organization_id: null, title: 'Shared', deleted_at: null },
};

// A tiny evaluator for the predicates these routes use, so the test proves
// the SQL actually excludes the foreign row rather than matching a string.
function visible(row, sql, orgParam) {
  if (/\(organization_id = \? OR organization_id IS NULL\)/.test(sql)) {
    return row.organization_id === orgParam || row.organization_id === null;
  }
  if (/organization_id <=> \?/.test(sql)) return row.organization_id === orgParam;
  if (/organization_id = \?/.test(sql)) return row.organization_id === orgParam;
  return true; // unscoped
}

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM portal_kb_articles WHERE id = \?/.test(sql)) {
      const row = ARTICLES[Number(params[0])];
      return [row && visible(row, sql, params[1]) ? [row] : []];
    }
    if (/^UPDATE portal_kb_articles/.test(sql)) {
      const id = Number(params[params.length - 2]);
      const row = ARTICLES[id];
      const ok = row && (/organization_id <=> \?/.test(sql) ? row.organization_id === params[params.length - 1] : true);
      return [{ affectedRows: ok ? 1 : 0 }];
    }
    return [[]];
  });
}

const updates = () => db.query.mock.calls.filter(([s]) => /^UPDATE portal_kb_articles/.test(s));

beforeEach(() => { jest.clearAllMocks(); mockIsInstallOperator.mockResolvedValue(false); wire(); });

it('mounts orgScope', async () => {
  await request(app).get('/api/v1/portal-kb/10');
  expect(mockOrgScope).toHaveBeenCalled();
});

describe('GET /portal-kb/:id', () => {
  it('reads own and shared articles', async () => {
    expect((await request(app).get('/api/v1/portal-kb/10')).status).toBe(200);
    expect((await request(app).get('/api/v1/portal-kb/30')).status).toBe(200);
  });

  it('404s another tenant\'s article', async () => {
    const res = await request(app).get('/api/v1/portal-kb/20');
    expect(res.status).toBe(404);
  });
});

describe('PUT /portal-kb/:id', () => {
  it('updates an own article with the write bound to the org', async () => {
    const res = await request(app).put('/api/v1/portal-kb/10').send({ title: 'New' });
    expect(res.status).toBe(200);
    const [sql, params] = updates()[0];
    expect(sql).toMatch(/WHERE id = \? AND organization_id <=> \?/);
    expect(params.slice(-2)).toEqual(['10', 1]);
  });

  it('404s another tenant\'s article and writes nothing', async () => {
    const res = await request(app).put('/api/v1/portal-kb/20').send({ title: 'pwned' });
    expect(res.status).toBe(404);
    expect(updates()).toHaveLength(0);
  });

  it('refuses a tenant edit of a shared article (403) and writes nothing', async () => {
    const res = await request(app).put('/api/v1/portal-kb/30').send({ body: 'pwned' });
    expect(res.status).toBe(403);
    expect(updates()).toHaveLength(0);
  });

  it('lets the install operator edit a shared article, bound to the NULL org', async () => {
    mockIsInstallOperator.mockResolvedValue(true);
    const res = await request(app).put('/api/v1/portal-kb/30').send({ body: 'ok' });
    expect(res.status).toBe(200);
    const [, params] = updates()[0];
    expect(params.slice(-2)).toEqual(['30', null]);
  });
});

describe('DELETE /portal-kb/:id', () => {
  it('404s another tenant\'s article and deletes nothing', async () => {
    const res = await request(app).delete('/api/v1/portal-kb/20');
    expect(res.status).toBe(404);
    expect(updates()).toHaveLength(0);
  });

  it('refuses a tenant delete of a shared article', async () => {
    const res = await request(app).delete('/api/v1/portal-kb/30');
    expect(res.status).toBe(403);
    expect(updates()).toHaveLength(0);
  });

  it('deletes an own article', async () => {
    const res = await request(app).delete('/api/v1/portal-kb/10');
    expect(res.status).toBe(200);
    expect(updates()[0][0]).toMatch(/organization_id <=> \?/);
  });
});
