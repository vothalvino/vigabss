// =============================================================================
// BIL-26 — a recorded payment carries its SAT forma de pago
// =============================================================================
// RecordPaymentModal never sends sat_forma_pago, so a cash payment stamped its
// PUE invoice (and its REP) as '03' transferencia.

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');

jest.mock('../src/services/businessEvents', () => ({ emitPaymentReceived: jest.fn() }));

const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
  mockTxConnection(db);
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id/.test(sql)) return [[{ id: 42 }]];
    if (/FROM organizations/.test(sql)) return [[{ currency: 'MXN' }]];
    if (/^\s*INSERT INTO `?payments`?/.test(sql)) return [{ insertId: 70 }];
    if (/FROM `?payments`?/.test(sql)) return [[{ id: 70, client_id: 42, amount: '100.00', currency: 'MXN' }]];
    if (/^\s*(UPDATE|INSERT)/.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
});

const inserted = () => {
  const call = db.query.mock.calls.find(([sql]) => /^\s*INSERT INTO `?payments`?/.test(sql));
  return call;
};

test.each([['cash', '01'], ['debit_card', '28'], ['spei', '03']])('a %s payment is stored with forma %s', async (method, forma) => {
  const res = await request(app).post('/api/v1/payments')
    .send({ client_id: 42, amount: 100, payment_method: method, payment_date: '2026-11-01' });
  expect(res.status).toBe(201);
  const [sql, params] = inserted();
  expect(sql).toMatch(/sat_forma_pago/);
  expect(params).toContain(forma);
});

test('an explicit sat_forma_pago wins', async () => {
  await request(app).post('/api/v1/payments')
    .send({ client_id: 42, amount: 100, payment_method: 'cash', payment_date: '2026-11-01', sat_forma_pago: '02' });
  expect(inserted()[1]).toContain('02');
});
