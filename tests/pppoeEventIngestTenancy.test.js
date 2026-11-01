// =============================================================================
// WHK-09 — PPPoE event ingest picks the tenant from a credential, not a guess
// =============================================================================
// POST /pppoe/events took an install-wide secret (or, failing that, the RADIUS
// accounting secret) and stamped whatever organization owned the caller's
// nas_id. The pppoe.events_ingest permission was seeded but never checked,
// and the path shared the general API budget.

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

let mockCurrentUser;
const mockPermissionSlugs = [];

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = req.user.organizationId; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: (slug) => {
    mockPermissionSlugs.push(slug);
    return (_req, _res, next) => next();
  },
}));
jest.mock('../src/services/pppoeDiagnosticsService', () => ({
  parseRouterOsLogLine: jest.fn(() => null),
}));
jest.mock('../src/services/pppoeReadinessService', () => ({ getReadiness: jest.fn() }));
jest.mock('../src/services/pppoeEventCollector', () => ({ deriveEventIdentity: jest.fn(() => ({})) }));
jest.mock('../src/models/PppoeEventLog', () => ({ create: jest.fn() }));

const db = require('../src/config/database');
const PppoeEventLog = require('../src/models/PppoeEventLog');
const pppoeRouter = require('../src/routes/pppoe');
const { isCollectorPath } = require('../src/middleware/rateLimit');
const { scopeAllowsPermission, isValidScope } = require('../src/utils/scopes');

const app = express();
app.use(express.json());
app.use('/pppoe', pppoeRouter);
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
});

const collectorToken = { id: 9, role: 'technician', organizationId: 2, apiTokenId: 41, scopes: ['pppoe_events:ingest'] };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PPPOE_EVENTS_SECRET;
  delete process.env.RADIUS_ACCOUNTING_SECRET;
  mockCurrentUser = { ...collectorToken };
  PppoeEventLog.create.mockImplementation(async data => ({ id: 1, ...data }));
});

afterAll(() => {
  delete process.env.PPPOE_EVENTS_SECRET;
  delete process.env.RADIUS_ACCOUNTING_SECRET;
});

describe('shared-secret ingest', () => {
  test('the RADIUS accounting secret no longer opens POST /pppoe/events', async () => {
    process.env.RADIUS_ACCOUNTING_SECRET = 'radius-acct-secret';
    const res = await request(app)
      .post('/pppoe/events')
      .set('X-Pppoe-Secret', 'radius-acct-secret')
      .send({ nas_id: 5, message: 'forged' });

    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(PppoeEventLog.create).not.toHaveBeenCalled();
  });

  test('a timestamp weeks in the past is rejected', async () => {
    process.env.PPPOE_EVENTS_SECRET = 'pppoe-secret';
    const res = await request(app)
      .post('/pppoe/events')
      .set('X-Pppoe-Secret', 'pppoe-secret')
      .send({ nas_id: 5, message: 'backdated', logged_at: new Date(Date.now() - 30 * 86400000).toISOString() });

    expect(res.status).toBe(422);
    expect(PppoeEventLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /pppoe/events/tenant', () => {
  test('checks the pppoe_events.ingest permission', () => {
    expect(mockPermissionSlugs).toContain('pppoe_events.ingest');
  });

  test('a NAS of another organization is not found inside the token organization', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app)
      .post('/pppoe/events/tenant')
      .send({ nas_id: 5, message: 'cross-tenant' });

    expect(res.status).toBe(422);
    expect(db.query.mock.calls[0][0]).toMatch(/organization_id = \?/);
    expect(db.query.mock.calls[0][1]).toEqual([5, 2]);
    expect(PppoeEventLog.create).not.toHaveBeenCalled();
  });

  test('stores the event for a NAS of the token organization', async () => {
    db.query.mockResolvedValueOnce([[{ id: 5, organization_id: 2 }]]);
    const res = await request(app)
      .post('/pppoe/events/tenant')
      .send({ nas_id: 5, message: 'peer timeout' });

    expect(res.status).toBe(201);
    expect(PppoeEventLog.create).toHaveBeenCalledWith(expect.objectContaining({ organization_id: 2, nas_id: 5 }));
  });

  test.each([
    ['a staff session (no API token)', { id: 9, role: 'admin', organizationId: 2 }],
    ['a token with broader scopes', { ...collectorToken, scopes: ['pppoe_events:ingest', '*:write'] }],
    ['a full-access token', { ...collectorToken, scopes: ['*:write'] }],
  ])('refuses %s with 403', async (_label, user) => {
    mockCurrentUser = user;
    const res = await request(app)
      .post('/pppoe/events/tenant')
      .send({ nas_id: 5, message: 'event' });

    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('scope and limiter wiring', () => {
  test('pppoe_events:ingest is a valid collector scope and the only one that grants the slug', () => {
    expect(isValidScope('pppoe_events:ingest')).toBe(true);
    expect(scopeAllowsPermission(['pppoe_events:ingest'], 'pppoe_events.ingest')).toBe(true);
    expect(scopeAllowsPermission(['*:write'], 'pppoe_events.ingest')).toBe(false);
  });

  test('both ingest paths use the collector limiter; the staff event list does not', () => {
    for (const url of ['/api/v1/pppoe/events', '/api/v1/pppoe/events/tenant', '/api/pppoe/events']) {
      expect(isCollectorPath({ method: 'POST', originalUrl: url })).toBe(true);
    }
    expect(isCollectorPath({ method: 'GET', originalUrl: '/api/v1/pppoe/events?page=2' })).toBe(false);
  });

  test('migration 493 moves every grant of the old slug to the new one', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/493_rename_pppoe_events_ingest_permission.sql'), 'utf8');
    expect(sql).toMatch(/INTO permissions[\s\S]*'pppoe_events\.ingest'/);
    expect(sql).toMatch(/INSERT IGNORE INTO role_permissions[\s\S]*op.name = 'pppoe\.events_ingest'/);
    expect(sql).toMatch(/DELETE FROM permissions WHERE name = 'pppoe\.events_ingest'/);
  });
});
