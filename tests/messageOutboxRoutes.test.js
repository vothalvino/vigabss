'use strict';
// =============================================================================
// ASY-33 — /message-outbox: staff see and act on their own organization's
// outgoing messages only
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: (...slugs) => (req, _res, next) => { req.checkedPermissions = slugs; next(); },
  requireRole: () => (_req, _res, next) => next(),
  userHasPermission: async () => true,
  enforceTokenScopes: (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/messageOutbox', () => ({
  CHANNELS: ['email', 'sms', 'whatsapp', 'push'],
  list: jest.fn(async () => ({ data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 1 } })),
  summary: jest.fn(async () => []),
  get: jest.fn(async id => ({ id })),
  retry: jest.fn(async id => ({ id, status: 'queued' })),
  cancel: jest.fn(async id => ({ id, status: 'cancelled' })),
}));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const outbox = require('../src/services/messageOutbox');
const app = require('../src/app');

const AUTH = 'Bearer ' + jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 5 }, config.jwt.secret, { expiresIn: '1h' });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (String(sql).includes('`users`')) return [[{ id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 5 }]];
    return [[]];
  });
});

test('the list is the caller\'s organization, with validated filters', async () => {
  const res = await request(app).get('/api/v1/message-outbox?status=failed&channel=sms').set('Authorization', AUTH);

  expect(res.status).toBe(200);
  expect(outbox.list).toHaveBeenCalledWith(5, expect.objectContaining({ status: 'failed', channel: 'sms' }));

  const bad = await request(app).get('/api/v1/message-outbox?status=lost').set('Authorization', AUTH);
  expect(bad.status).toBe(422);
});

test('retry passes the duplicate confirmation through, scoped to the caller\'s organization', async () => {
  const res = await request(app)
    .post('/api/v1/message-outbox/12/retry')
    .set('Authorization', AUTH)
    .send({ confirm_possible_duplicate: true });

  expect(res.status).toBe(200);
  expect(outbox.retry).toHaveBeenCalledWith(12, 5, { confirmPossibleDuplicate: true });
});

test('cancel is scoped to the caller\'s organization', async () => {
  const res = await request(app).post('/api/v1/message-outbox/12/cancel').set('Authorization', AUTH);

  expect(res.status).toBe(200);
  expect(outbox.cancel).toHaveBeenCalledWith(12, 5);
});
