// =============================================================================
// BIL-20 — POST /cfdi/payment-complement no longer trusts the caller
// =============================================================================
// The endpoint passed the body straight to generatePaymentComplement: the
// emisor RFC, name and régimen, LugarExpedicion, serie, folio, client_id,
// payment_id, the related UUIDs and every amount came from the caller, and the
// four inserts ran outside a transaction. It now takes { payment_id,
// invoice_id } and runs the same generator as POST /payments/:id/rep: the
// amount is the live allocation, the issuer the org's profile, the folio the
// org's sequence, and the chain the org's own REPs, under the invoice lock.
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
jest.mock('../src/middleware/orgLocale', () => ({
  requireMxLocale: (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/invoiceCfdiService', () => ({ nextCfdiFolio: jest.fn(async () => 7) }));

const db = require('../src/config/database');
const cfdiService = require('../src/services/cfdiService');
const app = require('../src/app');

const UUID = 'SIMULADO-aaaa-4bbb-8ccc-ddddeeeeffff';
const EMISOR = { rfc: 'EKU9003173C9', razon_social: 'Escuela Kemper', regimen_fiscal: '601', codigo_postal_fiscal: '26015', cfdi_serie_pago: 'P' };

let generate;
beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.spyOn(cfdiService, 'getEmisorProfile').mockResolvedValue({ ...EMISOR });
  generate = jest.spyOn(cfdiService, 'generatePaymentComplement').mockResolvedValue({ cfdi_document_id: 900, complement_id: 50, xml: '<x/>' });
  jest.spyOn(cfdiService, 'stamp').mockResolvedValue({ uuid: 'REP-UUID', status: 'vigente' });

  db.query.mockImplementation(async (sql, params = []) => {
    // Payment 38 is applied to invoice 605 for 300.00; nothing else exists.
    if (/FROM payment_allocations pa/.test(sql)) {
      return [Number(params[1]) === 38 && Number(params[2]) === 605 ? [{ amount: '300.00' }] : []];
    }
    if (/FROM cfdi_documents\s+WHERE invoice_id/.test(sql)) return [[{ id: 2, uuid: UUID, serie: 'A', folio: 3, total: '580.00' }]];
    if (/FROM payments/.test(sql)) return [[{ id: 38, organization_id: 5, currency: 'MXN', payment_method: 'transfer', payment_date: new Date('2026-07-20T00:00:00Z'), status: 'completed' }]];
    if (/FROM invoices/.test(sql)) return [[{ id: 605, client_id: 42, total: '580.00', currency: 'MXN' }]];
    if (/FROM client_mx_profiles/.test(sql)) return [[{ rfc: 'XAXX010101000', razon_social: 'M', regimen_fiscal: '616', codigo_postal_fiscal: '01000' }]];
    return [[]];
  });
  db.getConnection.mockResolvedValue({
    beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
    async execute(sql) {
      if (/FOR UPDATE/.test(sql)) return [[{ id: 605 }]];
      if (/FROM cfdi_payment_complement_items/.test(sql) && /COUNT/.test(sql)) return [[{ n: 0, pagado: 0 }]];
      return [[]];
    },
  });
});

const forged = {
  client_id: 9999, payment_id: 38, invoice_id: 605,
  serie: 'X', folio: '1', fecha_emision: '2026-07-20T12:00:00', lugar_expedicion: '99999',
  emisor_rfc: 'AAA010101AAA', emisor_nombre: 'Someone Else', emisor_regimen_fiscal: '612',
  amount: 580,
  related_documents: [{ related_cfdi_uuid: 'OTHER-TENANT-UUID', imp_saldo_ant: 580, imp_pagado: 580, imp_saldo_insoluto: 0 }],
};

describe('POST /api/v1/cfdi/payment-complement', () => {
  it('builds the REP from the allocation and the org profile, ignoring the body', async () => {
    const res = await request(app).post('/api/v1/cfdi/payment-complement').send(forged);
    expect(res.status).toBe(201);
    const params = generate.mock.calls[0][0];
    expect(params).toMatchObject({
      organization_id: 5, client_id: 42, payment_id: 38,
      serie: 'P', folio: 7,
      emisor_rfc: EMISOR.rfc, lugar_expedicion: EMISOR.codigo_postal_fiscal, amount: 300,
    });
    expect(params.related_documents).toHaveLength(1);
    expect(params.related_documents[0]).toMatchObject({ related_cfdi_uuid: UUID, imp_saldo_ant: 580, imp_pagado: 300, imp_saldo_insoluto: 280 });
  });

  it('refuses a payment that is not applied to the invoice', async () => {
    const res = await request(app).post('/api/v1/cfdi/payment-complement').send({ payment_id: 38, invoice_id: 606 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ALLOCATION_NOT_FOUND');
    expect(generate).not.toHaveBeenCalled();
  });

  it('requires payment_id and invoice_id', async () => {
    const { payment_id: _p, invoice_id: _i, ...legacy } = forged;
    const res = await request(app).post('/api/v1/cfdi/payment-complement').send(legacy);
    expect(res.status).toBe(422);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/payments/:id/rep keeps its contract', () => {
  it('generates from the allocation', async () => {
    const res = await request(app).post('/api/v1/payments/38/rep').send({ invoice_id: 605 });
    expect(res.status).toBe(201);
    expect(generate.mock.calls[0][0]).toMatchObject({ amount: 300, folio: 7 });
  });

  it('answers ALLOCATION_NOT_FOUND for an unapplied invoice', async () => {
    const res = await request(app).post('/api/v1/payments/38/rep').send({ invoice_id: 606 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ALLOCATION_NOT_FOUND');
  });
});
