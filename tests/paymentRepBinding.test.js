// =============================================================================
// CFD-06 — a REP binds its payment
// =============================================================================
// Payment delete, unapply, reallocate and refund never looked at the payment's
// REP. Example: PPD invoice of 1,160; payment A of 500 gets REP-1, then A is
// deleted and payment B of 800 is allocated. REP-2 then carries ImpSaldoAnt
// 660, ImpPagado 800 and ImpSaldoInsoluto clamped to 0, which the PAC rejects.
// Had A paid in full, B would get no REP at all; reallocating A reported the
// same money twice.
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
jest.mock('../src/services/invoiceCfdiService', () => ({ nextCfdiFolio: jest.fn(async () => 7) }));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const app = require('../src/app');

const PAYMENT = { id: 70, organization_id: 5, client_id: 42, amount: '500.00', currency: 'MXN', status: 'completed' };
const REP = { id: 31, uuid: 'REP-UUID-1', sat_status: 'vigente' };

function wire({ rep = REP, allocated = '0' } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/tipo_comprobante = 'P'/.test(sql)) return [rep ? [rep] : []];
    if (/AS allocated FROM payment_allocations/.test(sql)) return [[{ allocated }]];
    if (/FROM payment_allocations WHERE payment_id = \? AND invoice_id = \?/.test(sql)) return [[{ id: 55, payment_id: 70, invoice_id: 10, amount: '500.00' }]];
    if (/FROM `?payments`?/.test(sql)) return [[PAYMENT]];
    if (/FROM invoices WHERE id IN/.test(sql)) return [[{ id: 10, client_id: 42, status: 'paid' }, { id: 11, client_id: 42, status: 'issued' }]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
}

const wrote = (re) => db.query.mock.calls.some(([sql]) => re.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  mockTxConnection(db);
});

describe('payment operations refuse while a REP reports the payment', () => {
  it('DELETE /payments/:id', async () => {
    wire();
    const res = await request(app).delete('/api/v1/payments/70');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_HAS_REP');
    expect(res.body.error.message).toMatch(/REP-UUID-1.*motivo 02/);
    expect(wrote(/^UPDATE `?payments`? SET `?deleted_at/)).toBe(false);
  });

  it('POST /payments/:id/unapply', async () => {
    wire();
    const res = await request(app).post('/api/v1/payments/70/unapply').send({ invoice_id: 10 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_HAS_REP');
    expect(wrote(/UPDATE payment_allocations SET deleted_at/)).toBe(false);
  });

  it('POST /payments/:id/reallocate', async () => {
    wire();
    const res = await request(app).post('/api/v1/payments/70/reallocate').send({ from_invoice_id: 10, to_invoice_id: 11 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_HAS_REP');
    expect(wrote(/INSERT INTO payment_allocations/)).toBe(false);
  });

  it('PATCH /payments/:id moving it out of completed', async () => {
    wire();
    const res = await request(app).patch('/api/v1/payments/70').send({ status: 'refunded' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_HAS_REP');
  });

  it('a draft REP says to discard it', async () => {
    wire({ rep: { id: 32, uuid: null, sat_status: 'draft' } });
    const res = await request(app).delete('/api/v1/payments/70');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/draft.*#32.*Discard/);
  });

  it('unapply checks the REP against that invoice\'s CFDI', async () => {
    wire();
    await request(app).post('/api/v1/payments/70/unapply').send({ invoice_id: 10 });
    const [sql, params] = db.query.mock.calls.find(([q]) => /tipo_comprobante = 'P'/.test(q));
    expect(sql).toMatch(/inv\.invoice_id = \?/);
    expect(params).toEqual([10, 70, 5]);
  });

  it('without a REP, unapply goes through', async () => {
    wire({ rep: null });
    const res = await request(app).post('/api/v1/payments/70/unapply').send({ invoice_id: 10 });
    expect(res.status).toBe(200);
  });
});

describe('the staff refund of a gateway payment', () => {
  it('refuses before calling the gateway', async () => {
    const paymentGatewayService = require('../src/services/paymentGatewayService');
    const refund = jest.spyOn(paymentGatewayService, 'refund').mockResolvedValue({ refundId: 're_1' });
    db.query.mockImplementation(async (sql) => {
      if (/^\s*UPDATE refund_requests SET status = 'processed'/.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM `?refund_requests`?/.test(sql)) return [[{ id: 4, organization_id: 5, client_id: 42, payment_id: 900, amount: '500.00', status: 'processed' }]];
      if (/SELECT payment_id FROM payment_transactions/.test(sql)) return [[{ payment_id: 70 }]];
      if (/tipo_comprobante = 'P'/.test(sql)) return [[REP]];
      if (/FROM clients/.test(sql)) return [[{ id: 42 }]];
      return [{ affectedRows: 1 }];
    });
    const refundRequestService = require('../src/services/refundRequestService');
    await expect(refundRequestService.processRequest(5, 4, { refund_method: 'original_method' }, 8))
      .rejects.toMatchObject({ code: 'PAYMENT_HAS_REP' });
    expect(refund).not.toHaveBeenCalled();
    // Nothing moved, so the claim is released and the request stays approved.
    expect(wrote(/UPDATE refund_requests SET status = 'approved'/)).toBe(true);
    refund.mockRestore();
  });
});

describe('the REP chain', () => {
  it('refuses a payment larger than the balance prior REPs leave, instead of clamping', async () => {
    const cfdiService = require('../src/services/cfdiService');
    const repService = require('../src/services/repService');
    const generate = jest.spyOn(cfdiService, 'generatePaymentComplement');
    jest.spyOn(cfdiService, 'getEmisorProfile').mockResolvedValue({ rfc: 'EKU9003173C9', codigo_postal_fiscal: '26015' });
    db.query.mockImplementation(async (sql) => {
      if (/FROM cfdi_documents\s+WHERE invoice_id/.test(sql)) return [[{ id: 2, uuid: 'INV-UUID', total: '1160.00' }]];
      if (/FROM payments/.test(sql)) return [[{ ...PAYMENT, amount: '800.00' }]];
      if (/FROM invoices/.test(sql)) return [[{ id: 10, client_id: 42, total: '1160.00', currency: 'MXN' }]];
      if (/FROM client_mx_profiles/.test(sql)) return [[{ rfc: 'XAXX010101000' }]];
      return [[]];
    });
    const conn = {
      beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
      async execute(sql) {
        if (/FOR UPDATE/.test(sql)) return [[{ id: 10 }]];
        if (/COUNT\(\*\) AS n/.test(sql)) return [[{ n: 1, pagado: '500.00' }]];
        return [[]];
      },
    };
    db.getConnection.mockResolvedValue(conn);

    const res = await repService.generateRepForAllocation(70, 10, 800, 5, 8);

    expect(res).toEqual({ generated: false, reason: 'REP_EXCEEDS_BALANCE' });
    expect(generate).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    generate.mockRestore();
  });
});
