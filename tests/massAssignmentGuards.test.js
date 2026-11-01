// =============================================================================
// TNA-29 + RTE-10 — generic updates cannot write workflow or attribution fields
// =============================================================================
// The billing-dispute PUT wrote status / resolved_by / client_id from the body;
// the CPE PUT wrote lifecycle_state, inventory_item_id, ownership and
// subscriber_id past their guards; adjustments took approved_by from the
// body; and a lead PUT could set converted_client_id, redirecting /start's
// install to another client.
// =============================================================================

const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query: (...a) => mockQuery(...a), execute: (...a) => mockQuery(...a), getConnection: jest.fn(), close: jest.fn(), withPrimaryContext: (fn) => fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 9, role: 'admin', organizationId: 1 }; next(); },
  optionalAuth: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true, enforceTokenScopes: () => {},
  requirePermission: () => (_req, _res, next) => next(), requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
const mockRecord = jest.fn(async (args) => ({ id: 1, ...args }));
jest.mock('../src/services/billingAdjustmentService', () => ({ record: (...a) => mockRecord(...a) }));

const app = require('../src/app');
const Lead = require('../src/models/Lead');

let foreignIds;
beforeEach(() => {
  foreignIds = new Set();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql, params = []) => {
    if (/^\s*SELECT id FROM \w+ WHERE id = \? AND organization_id <=> \?/.test(sql)) return [foreignIds.has(params[0]) ? [] : [{ id: params[0] }]];
    if (/^\s*(UPDATE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 1 }]];
    return [[{ id: 1, organization_id: 1, status: 'open' }]];
  });
});

const updates = () => mockQuery.mock.calls.filter(([sql]) => /^\s*UPDATE/i.test(sql)).map(([sql]) => sql);

test('a dispute PUT cannot set its status, resolver or client', async () => {
  const res = await request(app).put('/api/v1/billing-disputes/1')
    .send({ description: 'more detail', status: 'resolved_favor_client', resolved_by: 1, client_id: 77, opened_by: 1 });
  expect(res.status).toBe(200);
  const sql = updates().join('\n');
  expect(sql).toMatch(/description/);
  expect(sql).not.toMatch(/status|resolved_by|client_id|opened_by/);
});

test('a dispute cannot be opened against another organization\'s client or invoice', async () => {
  foreignIds.add(77);
  const res = await request(app).post('/api/v1/billing-disputes').send({ client_id: 77, type: 'other', description: 'x' });
  expect(res.status).toBe(422);
  expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO/i.test(sql))).toBe(false);
});

test('a CPE PUT cannot move lifecycle or inventory fields', async () => {
  const res = await request(app).put('/api/v1/cpe-management/devices/1')
    .send({ notes: 'rack 3', lifecycle_state: 'installed', inventory_item_id: 4, ownership: 'sold', subscriber_id: 5 });
  expect(res.status).toBeLessThan(500);
  const sql = updates().join('\n');
  expect(sql).not.toMatch(/lifecycle_state|inventory_item_id|ownership|subscriber_id/);
});

test('a billing adjustment is approved by whoever records it', async () => {
  const res = await request(app).post('/api/v1/billing-adjustments')
    .send({ client_id: 1, entity_type: 'invoice', entity_id: 1, adjustment_type: 'discount', amount_delta: -10, reason: 'goodwill', approved_by: 1 });
  expect(res.status).toBe(201);
  expect(mockRecord.mock.calls[0][0].approvedBy).toBe(9);
});

test('a lead update cannot set its conversion columns', async () => {
  expect(Lead.fillable).not.toEqual(expect.arrayContaining(['converted_client_id']));
  expect(Lead.fillable).not.toEqual(expect.arrayContaining(['converted_at']));
  await request(app).put('/api/v1/leads/1').send({ notes: 'call back', converted_client_id: 5, converted_at: '2026-01-01' });
  expect(updates().join('\n')).not.toMatch(/converted_client_id|converted_at/);
});

// Strip mode must not turn an attempted re-home into a silent success.
test.each([
  ['put', '/api/v1/billing-disputes/1', { description: 'x' }],
  ['put', '/api/v1/cpe-management/devices/1', { notes: 'x' }],
  ['put', '/api/v1/leads/1', { notes: 'x' }],
  ['patch', '/api/v1/leads/1', { notes: 'x' }],
])('%s %s refuses organization_id with ORG_IMMUTABLE', async (method, path, body) => {
  const res = await request(app)[method](path).send({ ...body, organization_id: 4 });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('ORG_IMMUTABLE');
  expect(updates()).toEqual([]);
});
