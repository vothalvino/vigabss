// =============================================================================
// SEC-25 — GraphQL query limits, no GraphiQL, no production introspection
// =============================================================================
// There were no depth, size or alias limits (each nested resolver runs SQL per
// parent row), GraphiQL was served, yoga applied its own permissive CORS, and
// introspection was open in production.
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

const fs = require('fs');
const { parse, validate, specifiedRules, buildSchema } = require('graphql');
const app = require('../src/app');
const { queryLimitsRule, MAX_DEPTH } = require('../src/graphql/limits');

const gql = (query) => request(app).post('/api/v1/graphql').set('Content-Type', 'application/json').send({ query });

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue([[]]); });

describe('query limits (SEC-25)', () => {
  const nested = (levels) => {
    let q = 'id';
    for (let i = 0; i < levels; i++) q = `contracts { client { ${q} } }`;
    return `query { client(id: 1) { ${q} } }`;
  };

  test(`a query nested deeper than ${MAX_DEPTH} levels is refused before any SQL runs`, async () => {
    const res = await gql(nested(4));
    expect(res.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('fragments cannot hide depth', async () => {
    const res = await gql(`
      query { client(id: 1) { ...A } }
      fragment A on Client { contracts { client { ...B } } }
      fragment B on Client { contracts { client { contracts { client { id } } } } }`);
    expect(res.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('more than 15 aliases is refused', async () => {
    const fields = Array.from({ length: 16 }, (_, i) => `c${i}: client(id: ${i + 1}) { id }`).join(' ');
    const res = await gql(`query { ${fields} }`);
    expect(res.body.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the SPA\'s own detail queries are within the limits', () => {
    const typeDefs = require('../src/graphql/typeDefs');
    const schema = buildSchema(typeof typeDefs === 'string' ? typeDefs : typeDefs.loc?.source?.body ?? String(typeDefs));
    for (const page of ['ClientDetail', 'PaymentDetail', 'ContractDetail']) {
      const src = fs.readFileSync(`frontend/src/pages/${page}.tsx`, 'utf8');
      const text = /_QUERY\s*=\s*(?:\/\*\s*GraphQL\s*\*\/\s*)?`([\s\S]*?)`/.exec(src)[1];
      const errors = validate(schema, parse(text), [...specifiedRules, queryLimitsRule]);
      expect(errors.map(e => e.message)).toEqual([]);
    }
  });

  test('GraphiQL is not served', async () => {
    const res = await request(app).get('/api/v1/graphql').set('Accept', 'text/html');
    expect(String(res.text || '')).not.toMatch(/graphiql/i);
  });

  test('introspection is refused in production', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await gql('query { __schema { types { name } } }');
      expect(res.body.errors?.length).toBeGreaterThan(0);
      expect(res.body.data?.__schema).toBeUndefined();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

// OPS-06: yoga parsed multipart bodies with busboy for any token holder by
// default, although the schema has no Upload scalar.
describe('multipart requests (OPS-06)', () => {
  test('a multipart/form-data body is not parsed as a GraphQL request', async () => {
    const res = await request(app).post('/api/v1/graphql')
      .field('operations', JSON.stringify({ query: '{ __typename }' }))
      .field('map', '{}');
    expect(res.status).not.toBe(200);
    expect(res.body?.data?.__typename).toBeUndefined();
  });

  test('a JSON request still works', async () => {
    const res = await gql('{ __typename }');
    expect(res.body.data).toEqual({ __typename: 'Query' });
  });
});

