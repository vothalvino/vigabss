// =============================================================================
// CFD-07 — a credit note stays with the client and currency its egreso names
// =============================================================================
// FROZEN_FIELDS left out client_id and currency, which invoices do freeze, so a
// note with a live CFDI de Egreso could be moved to another client: its credit
// left the client SAT still holds it for. A note against an invoice could also
// be created for a different client than the invoice's.
// =============================================================================

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
const app = require('../src/app');

const NOTE = { id: 40, organization_id: 5, client_id: 42, invoice_id: 60, total: '232.00', subtotal: '200.00', tax_amount: '32.00', currency: 'MXN', status: 'issued' };

function wire({ liveCfdi, invoiceClient = 42 }) {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM cfdi_documents/.test(sql)) return [liveCfdi ? [{ id: 9, sat_status: 'vigente' }] : []];
    if (/SELECT id FROM clients/.test(sql)) return [[{ id: Number(params[0]) }]];
    if (/SELECT client_id FROM invoices/.test(sql)) return [[{ client_id: invoiceClient }]];
    if (/SELECT id FROM invoices/.test(sql)) return [[{ id: Number(params[0]) }]];
    if (/FROM `?credit_notes`?/.test(sql)) return [[NOTE]];
    if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 41 }];
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTxConnection(db);
});

const noteUpdate = () => db.query.mock.calls.find(([sql]) => /^UPDATE `?credit_notes`?/.test(sql));

describe('PUT /api/v1/credit-notes/:id with a live egreso', () => {
  it.each([
    ['client_id', 43],
    ['currency', 'USD'],
  ])('refuses changing %s', async (field, value) => {
    // Even when the new client matches the invoice: the egreso already names
    // client 42 as its receptor.
    wire({ liveCfdi: true, invoiceClient: 43 });
    const res = await request(app).put('/api/v1/credit-notes/40').send({ [field]: value });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_STAMPED');
    expect(noteUpdate()).toBeUndefined();
  });

  it('allows a notes edit', async () => {
    wire({ liveCfdi: true });
    const res = await request(app).put('/api/v1/credit-notes/40').send({ notes: 'x' });
    expect(res.status).toBe(200);
  });
});

describe('a note against an invoice is for that invoice\'s client', () => {
  it('POST refuses another client', async () => {
    wire({ liveCfdi: false });
    const res = await request(app).post('/api/v1/credit-notes')
      .send({ client_id: 43, invoice_id: 60, reason: 'billing_error', total: 116, currency: 'MXN' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CREDIT_NOTE_CLIENT_MISMATCH');
    expect(db.query.mock.calls.some(([sql]) => /^INSERT INTO `?credit_notes`?/.test(sql))).toBe(false);
  });

  it('PUT refuses re-pointing an unstamped note at another client\'s invoice', async () => {
    wire({ liveCfdi: false });
    const res = await request(app).put('/api/v1/credit-notes/40').send({ client_id: 43 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CREDIT_NOTE_CLIENT_MISMATCH');
  });

  it('POST accepts the invoice\'s own client', async () => {
    wire({ liveCfdi: false });
    const res = await request(app).post('/api/v1/credit-notes')
      .send({ client_id: 42, invoice_id: 60, reason: 'billing_error', total: 116, currency: 'MXN' });
    expect(res.status).toBe(201);
  });
});
