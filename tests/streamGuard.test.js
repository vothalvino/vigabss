// =============================================================================
// GQL-06 — bounded long-lived streams
// =============================================================================
// GraphQL subscriptions over text/event-stream skipped the SSE limiter, had no
// concurrency cap and never ended (yoga's pings kept nginx from timing them
// out); token expiry and deactivation were never re-checked.
// =============================================================================

const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery, execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, email: 'admin@test.com', role: 'admin', organizationId: 1 };
    req.authSession = { expiresAt: Date.now() + 3600000, tokenVersion: 0 };
    next();
  },
  optionalAuth: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  enforceTokenScopes: () => {},
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const app = require('../src/app');
const { streamGuard, _open } = require('../src/middleware/streamGuard');

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue([[]]); });

describe('subscription streams (GQL-06)', () => {
  afterEach(() => _open.clear());

  test('a principal over its concurrent-stream cap gets 429 on a GraphQL event stream', async () => {
    _open.set('user:1', 10);
    const res = await request(app)
      .get('/api/v1/graphql?query=' + encodeURIComponent('subscription { deviceStatusChanged(orgId: 1) { id } }'))
      .set('Accept', 'text/event-stream');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_STREAMS');
  });

  function fakeStream(user = { id: 5 }, session = {}) {
    const listeners = {};
    const res = {
      ended: false,
      end() { this.ended = true; (listeners.close || []).forEach(f => f()); },
      on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); },
      status() { return this; },
      json() { return this; },
    };
    const req = { user, orgId: 1, headers: { accept: 'text/event-stream' }, authSession: session };
    return { req, res };
  }

  test('a stream ends when its access token expires and releases its slot', async () => {
    jest.useFakeTimers();
    try {
      const { req, res } = fakeStream({ id: 5 }, { expiresAt: Date.now() + 1000, tokenVersion: 0 });
      const next = jest.fn();
      streamGuard()(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(_open.get('user:5')).toBe(1);
      jest.advanceTimersByTime(1001);
      expect(res.ended).toBe(true);
      expect(_open.get('user:5')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stream ends when the account is no longer authorized', async () => {
    jest.useFakeTimers();
    try {
      mockQuery.mockResolvedValue([[{ status: 'inactive', token_version: 0 }]]);
      const { req, res } = fakeStream({ id: 6 }, { expiresAt: Date.now() + 3600000, tokenVersion: 0 });
      streamGuard()(req, res, () => {});
      jest.advanceTimersByTime(60 * 1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(res.ended).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
