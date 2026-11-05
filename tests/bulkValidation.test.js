// =============================================================================
// VigaBSS 5.0 — Bulk Validation Tests
// =============================================================================

// Producers queue through the outbox (ASY-33); hand each message to the mocked transports.
jest.mock('../src/services/messageOutbox', () => require('./helpers/outboxPassThrough'));
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/models/User');
jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn(),
}));
jest.mock('../src/services/suspensionService');
// checkBulkEmailDailyBudget reads/writes cacheService directly (not
// express-rate-limit) — mock it so the daily-recipient-budget tests are
// deterministic instead of depending on the real in-memory LRU cache's state.
jest.mock('../src/services/cacheService', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incrementFixedWindow: jest.fn(),
  decrementFixedWindow: jest.fn(),
  flush: jest.fn(),
}));
// POST /bulk/email now sends real emails (detached, after the response) via
// emailTransport.sendEmail instead of the old eventBus.emit no-op — mock it
// so these tests never attempt a real SMTP round-trip.
jest.mock('../src/services/emailTransport', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: '<test>' }),
}));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const suspensionService = require('../src/services/suspensionService');
const cacheService = require('../src/services/cacheService');
const emailTransport = require('../src/services/emailTransport');
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 1, email: 'test@example.com', role: 'admin', orgId: 1, ...payload },
    config.jwt.secret,
    { expiresIn: '1h' },
  );
}

const authToken = makeToken();

function mockAuthUser() {
  User.findById.mockResolvedValue({
    id: 1,
    email: 'test@example.com',
    status: 'active',
    role: 'admin',
    organization_id: 1,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  cacheService.incrementFixedWindow.mockImplementation(async (_key, windowMs) => ({
    count: 1,
    resetAt: Date.now() + windowMs,
  }));
  cacheService.decrementFixedWindow.mockResolvedValue(undefined);
});

// =============================================================================
// POST /api/v1/bulk/suspend
// =============================================================================
describe('POST /api/v1/bulk/suspend', () => {
  test('rejects empty body → 400', async () => {
    mockAuthUser();
    const res = await request(app)
      .post('/api/v1/bulk/suspend')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // The per-contract semantics (active only, exempt clients failed, not-found
  // ids reported, suspensionService for every contract) moved with the work
  // into the batch job: tests/batchJobsBackground.test.js (TNA-41).
  test('valid body → 202 with the queued suspend job; nothing runs in the request', async () => {
    mockAuthUser();
    db.query.mockResolvedValue([[{ id: 10, status: 'pending', operation: 'suspend', organization_id: 1 }]]);

    const res = await request(app)
      .post('/api/v1/bulk/suspend')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ contract_ids: [10, 20], reason: 'Non-payment' });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ operation: 'suspend' });
    expect(suspensionService.suspendContract).not.toHaveBeenCalled();
    const jobInsert = db.query.mock.calls.find(([sql]) => /INSERT INTO batch_jobs/.test(sql));
    expect(jobInsert[1]).toEqual(expect.arrayContaining(['suspend', JSON.stringify({ contract_ids: [10, 20] })]));
  });

  test('rejects more than 500 contracts → 400', async () => {
    mockAuthUser();
    const res = await request(app)
      .post('/api/v1/bulk/suspend')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ contract_ids: Array.from({ length: 501 }, (_, i) => i + 1) });
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// POST /api/v1/bulk/email
// =============================================================================
describe('POST /api/v1/bulk/email', () => {
  test('missing subject → 422', async () => {
    mockAuthUser();
    const res = await request(app)
      .post('/api/v1/bulk/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ client_ids: [1], body: 'Hello' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('missing body → 422', async () => {
    mockAuthUser();
    const res = await request(app)
      .post('/api/v1/bulk/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ client_ids: [1], subject: 'Hi' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('valid data → 200', async () => {
    mockAuthUser();
    db.query.mockResolvedValue([[
      { id: 1, email: 'client@example.com', name: 'John Doe' },
    ]]);

    const res = await request(app)
      .post('/api/v1/bulk/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ client_ids: [1], subject: 'Notice', body: 'Service update' });

    expect(res.status).toBe(200);
    expect(res.body.data.queued).toBe(1);
  });

  test('subject too long (>500 chars) → 422', async () => {
    mockAuthUser();
    const longSubject = 'x'.repeat(501);
    const res = await request(app)
      .post('/api/v1/bulk/email')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ client_ids: [1], subject: longSubject, body: 'Hello' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  // Per-organization rolling-24h recipient budget (checkBulkEmailDailyBudget)
  // — a second, independent rate-limit layer on top of bulkEmailLimiter's
  // per-IP request-count budget, since one request can already fan out to up
  // to 1000 recipients.
  describe('daily recipient budget', () => {
    test('returns 429 when the daily recipient budget is exceeded, and sends zero emails', async () => {
      mockAuthUser();
      db.query.mockResolvedValue([[
        { id: 1, email: 'client@example.com', name: 'John Doe' },
      ]]);
      // Already at the default 5000/day cap — tenantApiLimiter's own
      // cacheService.get calls (for its unrelated 'rl_tenant:*' key) return
      // this same mocked shape too, but its comparison logic tolerates the
      // mismatched fields without blocking the request itself.
      cacheService.get.mockResolvedValue({ count: 5000, resetAt: Date.now() + 60 * 60 * 1000 });

      const res = await request(app)
        .post('/api/v1/bulk/email')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ client_ids: [1], subject: 'Notice', body: 'Service update' });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(emailTransport.sendEmail).not.toHaveBeenCalled();
    });

    test('succeeds and sends one email per resolved client when under both budgets', async () => {
      mockAuthUser();
      db.query.mockResolvedValue([[
        { id: 1, email: 'a@example.com', name: 'A' },
        { id: 2, email: 'b@example.com', name: 'B' },
      ]]);
      cacheService.get.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/bulk/email')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ client_ids: [1, 2], subject: 'Notice', body: 'Service update' });

      expect(res.status).toBe(200);
      expect(res.body.data.queued).toBe(2);
      // The send loop is detached (fires after res.json()) but is kicked off
      // synchronously within the same tick, so the mock's call count is
      // already observable by the time the supertest response resolves.
      expect(emailTransport.sendEmail).toHaveBeenCalledTimes(2);
      expect(emailTransport.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 1, clientId: 1, to: 'a@example.com', subject: 'Notice', text: 'Service update',
      }));
      expect(emailTransport.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 1, clientId: 2, to: 'b@example.com', subject: 'Notice', text: 'Service update',
      }));
      // The budget check is keyed by org, and its increment must be persisted.
      expect(cacheService.set).toHaveBeenCalledWith(
        'bulk_email_daily:1',
        expect.objectContaining({ count: 2 }),
        expect.any(Number),
      );
    });

    test('one recipient failing to send does not stop the others', async () => {
      mockAuthUser();
      db.query.mockResolvedValue([[
        { id: 1, email: 'bad@example.com', name: 'Bad' },
        { id: 2, email: 'good@example.com', name: 'Good' },
      ]]);
      cacheService.get.mockResolvedValue(null);
      emailTransport.sendEmail
        .mockRejectedValueOnce(new Error('SMTP refused'))
        .mockResolvedValueOnce({ success: true, messageId: '<ok>' });

      const res = await request(app)
        .post('/api/v1/bulk/email')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ client_ids: [1, 2], subject: 'Notice', body: 'Service update' });

      expect(res.status).toBe(200);
      // Both sends were attempted despite the first one rejecting.
      await Promise.resolve().then().then();
      expect(emailTransport.sendEmail).toHaveBeenCalledTimes(2);
    });

    test('does not consult the daily budget when zero clients resolve (all not_found)', async () => {
      mockAuthUser();
      db.query.mockResolvedValue([[]]); // no matching clients in this org

      const res = await request(app)
        .post('/api/v1/bulk/email')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ client_ids: [999], subject: 'Notice', body: 'Service update' });

      expect(res.status).toBe(200);
      expect(res.body.data.queued).toBe(0);
      // tenantApiLimiter's own CacheStore also calls cacheService.get (for
      // its unrelated 'rl_tenant:*' key) — assert the daily-budget-specific
      // key was never consulted, rather than "cacheService.get was never
      // called at all".
      expect(cacheService.get).not.toHaveBeenCalledWith('bulk_email_daily:1');
      expect(emailTransport.sendEmail).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Regression smoke: other /bulk/* routes are unaffected by bulkEmailLimiter
// =============================================================================
describe('bulkEmailLimiter does not leak onto other /bulk routes', () => {
  test('POST /bulk/suspend still works (not gated by bulkEmailLimiter)', async () => {
    mockAuthUser();

    db.query.mockResolvedValue([[{ id: 10, status: 'active', organization_id: 1 }]]);
    suspensionService.suspendContract.mockResolvedValue(undefined);
    const suspendRes = await request(app)
      .post('/api/v1/bulk/suspend')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ contract_ids: [10] });
    // 202: queued as a batch job (TNA-41).
    expect(suspendRes.status).toBe(202);
  });
});
