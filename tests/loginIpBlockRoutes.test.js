// =============================================================================
// Blocked-IP admin routes and the audit action list (migration 013)
// =============================================================================
// /security-admin/login-ip-blocks: a block covers the whole install, so the
// routes need the permission AND the install operator. A private address or
// the caller's own IP cannot be blocked by hand. /audit-logs/actions lists the
// actions of the scope with their category; ?category= filters by all of them.
// =============================================================================
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withPrimaryContext: (fn) => fn(),
}));
jest.mock('../src/utils/primaryContext', () => ({ runInPrimaryContext: (fn) => fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 4, email: 'op@example.com' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 12; next(); } }));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));
const mockOperator = { value: true };
jest.mock('../src/services/installOperator', () => ({
  isInstallOperator: async () => mockOperator.value,
  OPERATOR_ONLY_MESSAGE: 'Install operator only',
}));
jest.mock('../src/services/loginSecurityService', () => {
  const actual = jest.requireActual('../src/services/loginSecurityService');
  return {
    ...actual,
    record: jest.fn(async () => {}),
    listBlocks: jest.fn(async () => ({ rows: [], total: 0 })),
    activeBlock: jest.fn(async () => null),
    blockIp: jest.fn(async (args) => ({ id: 5, ip_address: args.ip, source: 'manual', failures: 0, refused_count: 0, blocked_until: null, note: args.note, created_by: 4, lifted_at: null, lifted_by: null, created_at: '2026-11-08T10:00:00Z' })),
    liftBlock: jest.fn(),
  };
});

const db = require('../src/config/database');
const ls = require('../src/services/loginSecurityService');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/security-admin', require('../src/routes/securityAdmin'));
app.use('/audit-logs', require('../src/routes/auditLogs'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }));

beforeEach(() => {
  jest.clearAllMocks();
  mockOperator.value = true;
  db.query.mockResolvedValue([[]]);
});

describe('/security-admin/login-ip-blocks', () => {
  test('only the install operator may list, block or lift', async () => {
    mockOperator.value = false;
    expect((await request(app).get('/security-admin/login-ip-blocks')).status).toBe(403);
    expect((await request(app).post('/security-admin/login-ip-blocks').send({ ip: '198.51.100.4' })).status).toBe(403);
    expect((await request(app).post('/security-admin/login-ip-blocks/5/lift')).status).toBe(403);
    expect(ls.listBlocks).not.toHaveBeenCalled();
    expect(ls.blockIp).not.toHaveBeenCalled();
    expect(ls.liftBlock).not.toHaveBeenCalled();
  });

  test('the list shows the settings and the caller\'s IP', async () => {
    const res = await request(app).get('/security-admin/login-ip-blocks?active=true').set('X-Forwarded-For', '198.51.100.9');
    expect(res.status).toBe(200);
    expect(ls.listBlocks).toHaveBeenCalledWith({ limit: 50, offset: 0, activeOnly: true });
    expect(res.body).toMatchObject({ data: [], pagination: { total: 0 }, your_ip: '198.51.100.9' });
    expect(res.body.settings).toEqual(expect.objectContaining({ enabled: expect.any(Boolean) }));
  });

  test('a manual block is stored and audited under the organization', async () => {
    const res = await request(app).post('/security-admin/login-ip-blocks')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ ip: '203.0.113.50', hours: 24, note: 'scanner' });
    expect(res.status).toBe(201);
    expect(ls.blockIp).toHaveBeenCalledWith({ ip: '203.0.113.50', source: 'manual', hours: 24, note: 'scanner', createdBy: 4 });
    expect(ls.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'login_ip_blocked', organizationId: 12, userId: 4, entityId: 5 }));
    expect(res.body.data).toMatchObject({ ip_address: '203.0.113.50', active: true });
  });

  test.each([
    ['not an IP', 'nope'],
    ['a private address', '10.0.0.8'],
    ['the server behind the proxy', '172.19.0.1'],
    ['the caller\'s own IP', '198.51.100.9'],
  ])('refuses %s', async (_label, ip) => {
    const res = await request(app).post('/security-admin/login-ip-blocks').set('X-Forwarded-For', '198.51.100.9').send({ ip });
    expect(res.status).toBe(422);
    expect(ls.blockIp).not.toHaveBeenCalled();
  });

  test('an IP already blocked is 409', async () => {
    ls.activeBlock.mockResolvedValueOnce({ id: 2 });
    const res = await request(app).post('/security-admin/login-ip-blocks').send({ ip: '203.0.113.50' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_BLOCKED');
  });

  test('lifting is audited once; an unknown block is 404', async () => {
    ls.liftBlock.mockResolvedValueOnce({ lifted: true, row: { id: 5, ip_address: '203.0.113.50', source: 'auto', lifted_at: '2026-11-08T11:00:00Z' } });
    const res = await request(app).post('/security-admin/login-ip-blocks/5/lift');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lifted: true, data: { id: 5, active: false } });
    expect(ls.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'login_ip_unblocked', entityId: 5 }));

    ls.record.mockClear();
    ls.liftBlock.mockResolvedValueOnce({ lifted: false, row: null });
    expect((await request(app).post('/security-admin/login-ip-blocks/77/lift')).status).toBe(404);
    expect(ls.record).not.toHaveBeenCalled();
  });
});

describe('/audit-logs/actions and the category filter', () => {
  test('lists the scope\'s actions with their category', async () => {
    db.query.mockResolvedValueOnce([[{ action: 'cash_bag_seal', n: 3, last_at: null }, { action: 'login_failed', n: 9, last_at: null }, { action: 'brand_new', n: 1, last_at: null }]]);
    const res = await request(app).get('/audit-logs/actions');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { action: 'cash_bag_seal', category: 'cash_bags', count: 3, last_at: null },
      { action: 'login_failed', category: 'sign_in', count: 9, last_at: null },
      { action: 'brand_new', category: 'other', count: 1, last_at: null },
    ]);
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE organization_id = \?\s+GROUP BY action/);
    expect(db.query.mock.calls[0][1]).toEqual([12]);
  });

  test('install scope is for the install operator only', async () => {
    mockOperator.value = false;
    expect((await request(app).get('/audit-logs/actions?scope=install')).status).toBe(403);
  });

  test('?category= filters by every action of that category in the scope', async () => {
    db.query
      .mockResolvedValueOnce([[{ action: 'login_failed', n: 9 }, { action: 'portal_login_success', n: 2 }, { action: 'create', n: 50 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]]);
    const res = await request(app).get('/audit-logs?category=sign_in');
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/action IN \(\?, \?\)/);
    expect(params).toEqual([12, 'login_failed', 'portal_login_success']);
  });

  test('a category with no actions matches nothing; an unknown one is 422', async () => {
    db.query.mockResolvedValueOnce([[{ action: 'create', n: 1 }]]).mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]]);
    await request(app).get('/audit-logs?category=cash_bags');
    expect(db.query.mock.calls[1][0]).toMatch(/1 = 0/);
    expect((await request(app).get('/audit-logs?category=bogus')).status).toBe(422);
  });
});
