// =============================================================================
// SEC-20 — non-string emails are rejected, and body-parser errors are 4xx
// =============================================================================
// validate() checked the email pattern only when the value was a string, so an
// object or number reached email.toLowerCase() on the unauthenticated portal
// login and reset routes (500). Malformed JSON and oversized bodies came back
// as INTERNAL_ERROR, logged as unhandled and sent to Sentry.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() } }));


const request = require('supertest');
const errorTracking = require('../src/utils/errorTracking');
const { validate } = require('../src/middleware/validate');
const app = require('../src/app');

beforeEach(() => { jest.spyOn(errorTracking, 'captureException').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test.each([[{ $gt: '' }], [42], [['a@b.co']]])('an email field rejects %j', (value) => {
  const req = { body: { email: value } };
  const next = jest.fn();
  validate({ email: { type: 'email', required: true } })(req, {}, next);
  expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 422 });
});

test('the portal login answers 422, not 500, for a non-string email', async () => {
  const res = await request(app).post('/api/v1/portal/auth/login').send({ email: { a: 1 }, password: 'x' });
  expect(res.status).toBe(422);
});

test('malformed JSON is a 400 VALIDATION_ERROR and is not sent to error tracking', async () => {
  const res = await request(app).post('/api/v1/portal/auth/login').set('Content-Type', 'application/json').send('{"email":');
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(errorTracking.captureException).not.toHaveBeenCalled();
});
