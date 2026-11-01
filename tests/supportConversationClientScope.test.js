// =============================================================================
// ASY-27 — a support conversation cannot be opened for another tenant's
// client, and diagnostics read only this organization's client
// =============================================================================
// POST /support/conversations stored the body's clientId with no org check,
// and the slow-fiber / no-internet diagnostics queried `WHERE cl.id = ?`, so
// they reported a foreign client's active or suspended status.
// =============================================================================

const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: (...a) => mockQuery(...a), execute: (...a) => mockQuery(...a), getConnection: jest.fn(), close: jest.fn(), withPrimaryContext: (fn) => fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 9, role: 'support', organizationId: 1 }; next(); },
  optionalAuth: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true, enforceTokenScopes: () => {},
  requirePermission: () => (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next(),
}));
const mockStart = jest.fn(async () => ({ id: 1 }));
jest.mock('../src/services/supportConversationService', () => ({
  ...jest.requireActual('../src/services/supportConversationService'),
  startConversation: (...a) => mockStart(...a),
}));

const app = require('../src/app');

beforeEach(() => {
  mockQuery.mockReset();
  mockStart.mockClear();
  mockQuery.mockImplementation(async (sql, params) => {
    if (/SELECT id FROM clients WHERE id = \? AND organization_id = \?/.test(sql)) return [params[0] === 5 ? [{ id: 5 }] : []];
    return [[]];
  });
});

test('a conversation for another organization\'s client is a 404 and starts nothing', async () => {
  const res = await request(app).post('/api/v1/support/conversations').send({ clientId: 777, message: 'no internet' });
  expect(res.status).toBe(404);
  expect(mockStart).not.toHaveBeenCalled();
});

test('a conversation for this organization\'s client starts', async () => {
  const res = await request(app).post('/api/v1/support/conversations').send({ clientId: 5, message: 'no internet' });
  expect(res.status).toBe(201);
  expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ orgId: 1, clientId: 5 }));
});

test('the diagnostic account-status queries are bound to the organization', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'diagnosticEngineService.js'), 'utf8');
  expect(src).not.toMatch(/WHERE cl\.id = \? (AND c\.status|ORDER BY)/);
  expect(src).not.toMatch(/'SELECT status FROM clients WHERE id = \?'/);
  expect(src.match(/cl\.organization_id <=> \?/g).length).toBeGreaterThanOrEqual(2);
  expect(src).toMatch(/SELECT status FROM clients WHERE id = \? AND organization_id <=> \?/);
});
