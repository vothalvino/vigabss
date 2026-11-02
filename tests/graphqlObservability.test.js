// =============================================================================
// GQL-08 — GraphQL failures reach the log, Sentry and metrics
// =============================================================================
// yoga ran with `logging: false`, so a SQL error inside a resolver answered
// HTTP 200 'Unexpected error.' and left no log line, metric or Sentry event.
// =============================================================================

const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: mockQuery, execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
const mockRole = { value: 'admin' };
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 7, email: 'admin@test.com', role: mockRole.value, organizationId: 3 };
    req.authSession = { expiresAt: Date.now() + 3600000, tokenVersion: 0 };
    next();
  },
  optionalAuth: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 3; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  enforceTokenScopes: () => {},
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/utils/errorTracking', () => ({
  init: jest.fn(), isEnabled: () => true, captureException: jest.fn(),
  setupExpressErrorHandler: jest.fn(),
}));
jest.mock('../src/utils/logger', () => {
  const mock = {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

const app = require('../src/app');
const logger = require('../src/utils/logger');
const errorTracking = require('../src/utils/errorTracking');
const { graphqlErrors, classify } = require('../src/graphql/observability');

const gql = (query, operationName) => request(app).post('/api/v1/graphql')
  .set('Content-Type', 'application/json').set('X-Request-Id', 'req-gql-08')
  .send({ query, operationName });

beforeEach(() => {
  jest.clearAllMocks();
  mockRole.value = 'admin';
  mockQuery.mockReset();
});

test('a resolver failure is masked for the client but logged, captured and counted', async () => {
  mockQuery.mockRejectedValue(Object.assign(new Error("Unknown column 'x' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' }));
  const before = graphqlErrors.get({ operation: 'ClientDetail', code: 'INTERNAL_SERVER_ERROR' });

  const res = await gql('query ClientDetail { client(id: 1) { id } }', 'ClientDetail');

  expect(res.status).toBe(200);
  expect(res.body.errors[0].message).toBe('Unexpected error.');
  expect(JSON.stringify(res.body)).not.toMatch(/Unknown column/);

  const failure = logger.error.mock.calls.find(([, msg]) => msg === 'GraphQL resolver failed');
  expect(failure).toBeDefined();
  expect(failure[0]).toMatchObject({
    requestId: expect.any(String), userId: 7, orgId: 3, operationName: 'ClientDetail', path: 'client',
  });
  expect(failure[0].err.message).toMatch(/Unknown column/);
  // Logged once: yoga's own log of the masked error is skipped.
  expect(logger.error.mock.calls.filter(([, msg]) => /GraphQL/.test(msg))).toHaveLength(1);

  expect(errorTracking.captureException).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringMatching(/Unknown column/) }),
    expect.objectContaining({ operationName: 'ClientDetail', orgId: 3, source: 'graphql' }),
  );
  expect(graphqlErrors.get({ operation: 'ClientDetail', code: 'INTERNAL_SERVER_ERROR' })).toBe(before + 1);
});

test('a permission denial is warn-logged and counted, not sent to Sentry', async () => {
  // A support user with no granted permissions: the lookup returns nothing.
  mockRole.value = 'support';
  mockQuery.mockResolvedValue([[]]);
  const before = graphqlErrors.get({ operation: 'anonymous', code: 'FORBIDDEN' });

  const res = await gql('{ client(id: 1) { id } }');

  expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  expect(logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'FORBIDDEN', userId: 7, orgId: 3, operationName: 'anonymous' }),
    'GraphQL permission denied',
  );
  expect(errorTracking.captureException).not.toHaveBeenCalled();
  expect(graphqlErrors.get({ operation: 'anonymous', code: 'FORBIDDEN' })).toBe(before + 1);
});

test('classify separates deliberate GraphQL errors from unexpected failures', () => {
  const { GraphQLError } = require('graphql');
  expect(classify(new GraphQLError('x', { originalError: new Error('db') }))).toEqual({
    code: 'INTERNAL_SERVER_ERROR', unexpected: true,
  });
  expect(classify(new GraphQLError('x', { extensions: { code: 'NOT_FOUND' } }))).toEqual({
    code: 'NOT_FOUND', unexpected: false,
  });
  const deliberate = new GraphQLError('bad');
  expect(classify(new GraphQLError('bad', { originalError: deliberate }))).toEqual({
    code: 'GRAPHQL_ERROR', unexpected: false,
  });
});
