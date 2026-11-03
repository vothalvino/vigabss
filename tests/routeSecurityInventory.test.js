'use strict';
// =============================================================================
// SEC-22 — every v1 route authenticates by default, and every route's guards
// are accounted for
// =============================================================================
// Each route file added authenticate itself, so a route in a file that forgot
// it was public, and nothing listed which routes lacked an organization scope
// or a permission check. applyDefaultDeny now puts authenticate in front of
// every v1 route except the reviewed public ones, and this inventory fails
// when a new route has neither the standard guards nor a reviewed reason.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));

const express = require('express');
const request = require('supertest');
const inventory = require('./helpers/routeInventory');

inventory.install();
const app = require('../src/app');
const { authenticate } = require('../src/middleware/auth');
const { orgScope } = require('../src/middleware/orgScope');
const { GUARD } = require('../src/middleware/routeGuard');
const { applyDefaultDeny, defaultDenyGuard, isPublicV1Route, PUBLIC_V1_ROUTES } = require('../src/middleware/v1DefaultDeny');

// Signed-in routes without the organization scope or a permission guard, and
// why that is right. A new entry needs the same review.
const REVIEWED = {
  'GET /auth/me': 'the caller\'s own session',
  'POST /auth/change-password': 'the caller\'s own account',
  'PUT /regulatory-compliance/preservation-holds/:id/release': 'the handler requires the manage permission of the hold\'s own case (gov_data_requests.manage or dsar_requests.manage)',
  'POST /auth/verify-email/resend': 'the caller\'s own account',
  'POST /auth/switch-organization': 'membership is checked by the handler',
  'GET /auth/sessions': 'the caller\'s own sessions',
  'DELETE /auth/sessions/:id': 'the caller\'s own sessions; the query is keyed by user_id',
  'GET /2fa/status': 'the caller\'s own account',
  'POST /2fa/setup': 'the caller\'s own account',
  'POST /2fa/verify': 'the caller\'s own account',
  'POST /2fa/validate': 'the caller\'s own account',
  'POST /2fa/disable': 'the caller\'s own account',
  'POST /2fa/backup-codes': 'the caller\'s own account',
  'GET /notifications': 'rows filtered to user_id = the caller',
  'GET /notifications/unread-count': 'rows filtered to user_id = the caller',
  'POST /notifications/read-all': 'rows filtered to user_id = the caller',
  'POST /notifications/:id/read': 'rows filtered to user_id = the caller',
  'GET /system/version': 'installOperatorOnly',
  'POST /system/version/check': 'installOperatorOnly',
  'GET /system/deploy': 'installOperatorOnly',
  'POST /system/deploy': 'installOperatorOnly',
  'GET /events/stream': 'channel grants are resolved per user by realtimeAccess in the handler',
  'GET /events/stats': 'counts for the caller\'s own organization channels only',
  'GET /map-config': 'map tile configuration, no tenant data',
  'GET /data-security/tls-config': 'static documentation',
  'GET /webhook-security/verify-signing': 'static documentation',
  'POST /webhook-security/verify-signature': 'computes an HMAC over caller-supplied input; reads nothing',
  'GET /backup-settings': 'install-wide; requirePermission needs an organization context',
  'PUT /backup-settings': 'install-wide; requirePermission needs an organization context',
  'POST /backup-settings/test': 'install-wide; requirePermission needs an organization context',
  'POST /backup-settings/run-now': 'install-wide; requirePermission needs an organization context',
  'GET /backup-settings/runs': 'install-wide; requirePermission needs an organization context',
  'GET /backup-settings/download/:filename': 'install-wide; requirePermission needs an organization context',
  'GET /dr-drill/status': 'install-wide; requirePermission needs an organization context',
  'GET /dr-drill/runbook': 'install-wide; requirePermission needs an organization context',
  'GET /queue-stats': 'install-wide; requirePermission needs an organization context',
  'GET /organizations': 'lists organizations the caller may access',
  'POST /organizations': 'install-wide; requirePermission needs an organization context',
};

// POSTs that only compute or read, so a view permission is the right gate.
const VIEW_ONLY_POSTS = {
  'POST /tickets/:id/ai-summary': 'generates a summary of a ticket the caller can view (AI spend: ASY-34)',
  'POST /technician-tracking/route-optimize': 'computes a route from existing work orders',
  'POST /connection-logs/ip-attribution/lookup': 'a lookup with a body; the handler audits it',
  'POST /suspension/evaluate': 'lists contracts the rules would act on; suspends nothing',
  'POST /cpe-profiles/:id/resolve': 'merges profile parameters for display',
  'POST /wireless/link-planning/calculate': 'computes a link budget',
  'POST /rate-limit-templates/preview': 'renders a rate string',
};

const routes = inventory.list(app)
  .filter(r => r.path.startsWith('/api/v1/'))
  .map(r => ({ ...r, v1: r.path.slice('/api/v1'.length), key: `${r.method} ${r.path.slice('/api/v1'.length)}` }));

const guards = r => r.chain.filter(fn => fn && fn[GUARD]).map(fn => fn[GUARD]);
const signedIn = r => r.chain.includes(authenticate) || r.chain.includes(defaultDenyGuard);

test('the app serves a full route tree', () => {
  expect(routes.length).toBeGreaterThan(1000);
});

test('every route that is not a reviewed public route requires a staff sign-in first', () => {
  const missing = routes
    .filter(r => !isPublicV1Route(r.method, r.v1))
    .filter(r => r.chain.findIndex(fn => fn === defaultDenyGuard) === -1)
    .map(r => r.key);
  expect(missing).toEqual([]);
});

test('every signed-in route has the organization scope and a permission guard, or a reviewed reason', () => {
  const unreviewed = routes
    .filter(r => !isPublicV1Route(r.method, r.v1) && signedIn(r))
    .filter(r => !(r.chain.includes(orgScope) && guards(r).length > 0))
    .map(r => r.key)
    .filter(key => !REVIEWED[key]);
  expect(unreviewed).toEqual([]);
});

test('a write is never guarded only by a view permission', () => {
  const viewOnly = routes
    .filter(r => r.method !== 'GET' && guards(r).length > 0)
    .filter(r => guards(r).every(g => g.permissions && g.permissions.every(p => /\.view$/.test(p))))
    .filter(r => !VIEW_ONLY_POSTS[r.key])
    .map(r => `${r.key} ${JSON.stringify(guards(r))}`);
  expect(viewOnly).toEqual([]);
});

test('every reviewed entry and public pattern still matches a route', () => {
  const keys = new Set(routes.map(r => r.key));
  expect(Object.keys({ ...REVIEWED, ...VIEW_ONLY_POSTS }).filter(key => !keys.has(key))).toEqual([]);
  const unused = PUBLIC_V1_ROUTES
    .filter(([method, pattern]) => !routes.some(r => (method === '*' || method === r.method) && pattern.test(r.v1)))
    .map(([, pattern]) => String(pattern));
  expect(unused).toEqual([]);
});

describe('applyDefaultDeny', () => {
  function build(define) {
    const v1 = express.Router();
    const sub = express.Router();
    define(sub);
    v1.use('/things', sub);
    applyDefaultDeny(v1);
    const testApp = express();
    testApp.use('/api/v1', v1);
    testApp.use('/api', v1);
    testApp.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND' } }));
    return testApp;
  }

  test('a route whose file forgot authenticate still requires a sign-in', async () => {
    const handler = jest.fn((_req, res) => res.json({ ok: true }));
    const testApp = build(sub => sub.get('/', handler).post('/:id', handler));

    expect((await request(testApp).get('/api/v1/things')).status).toBe(401);
    expect((await request(testApp).post('/api/things/7')).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  test('unknown paths and other methods still fall through', async () => {
    const testApp = build(sub => sub.get('/', (_req, res) => res.json({ ok: true })));

    expect((await request(testApp).get('/api/v1/nothing-here')).status).toBe(404);
    expect((await request(testApp).delete('/api/v1/things')).status).toBe(404);
  });

  test('the real public routes are reachable without a session', async () => {
    const res = await request(app).get('/api/v1/changelog');
    expect(res.status).not.toBe(401);
  });
});
