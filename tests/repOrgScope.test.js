// =============================================================================
// CFD-08 — REP chain and the live-REP cancel guard are scoped by organization
// =============================================================================
// Both queries matched cfdi_payment_complement_items on related_cfdi_uuid
// alone. In a shared database, a REP that org 6 filed citing org 5's UUID with
// imp_pagado equal to the total made org 5's later payments end in
// CFDI_FULLY_REPORTED (no REP, only a log line), and, once stamped, made org
// 5's own cancel() answer 422 CFDI_HAS_LIVE_REP.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/invoiceCfdiService', () => ({ nextCfdiFolio: jest.fn(async () => 7) }));

const db = require('../src/config/database');
const cfdiService = require('../src/services/cfdiService');

const UUID = 'SIMULADO-aaaa-4bbb-8ccc-ddddeeeeffff';
// Org 6's REP item citing org 5's CFDI: matched only when the query leaves the
// organization out.
const foreignOnly = (params) => !params.includes(5);

afterEach(() => jest.restoreAllMocks());

describe('generateRepForAllocation', () => {
  const repService = require('../src/services/repService');

  test('another tenant\'s REP items do not use up this invoice\'s balance', async () => {
    jest.spyOn(cfdiService, 'getEmisorProfile').mockResolvedValue({ rfc: 'EKU9003173C9', razon_social: 'E', regimen_fiscal: '601', codigo_postal_fiscal: '26015', cfdi_serie_pago: 'P' });
    const generate = jest.spyOn(cfdiService, 'generatePaymentComplement').mockResolvedValue({ cfdi_document_id: 900, complement_id: 50, xml: '<x/>' });
    jest.spyOn(cfdiService, 'stamp').mockResolvedValue({ uuid: 'REP-UUID', status: 'vigente' });

    db.query.mockImplementation(async (sql) => {
      if (/FROM cfdi_documents\s+WHERE invoice_id/.test(sql)) return [[{ id: 2, uuid: UUID, serie: 'A', folio: 3, total: '580.00' }]];
      if (/FROM payments/.test(sql)) return [[{ id: 38, organization_id: 5, currency: 'MXN', payment_method: 'transfer', payment_date: new Date('2026-07-20T00:00:00Z'), status: 'completed' }]];
      if (/FROM invoices/.test(sql)) return [[{ id: 605, client_id: 42, total: '580.00', currency: 'MXN' }]];
      if (/FROM client_mx_profiles/.test(sql)) return [[{ rfc: 'XAXX010101000', razon_social: 'M', regimen_fiscal: '616', codigo_postal_fiscal: '01000' }]];
      return [[]];
    });
    const chain = [];
    db.getConnection.mockResolvedValue({
      beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
      async execute(sql, params = []) {
        if (/FOR UPDATE/.test(sql)) return [[{ id: 605 }]];
        if (/JOIN cfdi_payment_complements pc ON pc.cfdi_document_id = d.id/.test(sql)) return [[]];
        if (/FROM cfdi_payment_complement_items/.test(sql)) {
          chain.push(params);
          return [[foreignOnly(params) ? { n: 1, pagado: '580.00' } : { n: 0, pagado: 0 }]];
        }
        return [{ affectedRows: 1, insertId: 1 }];
      },
    });

    const res = await repService.generateRepForAllocation(38, 605, 580, 5, 8);

    expect(chain[0]).toEqual([UUID, 5]);
    expect(res).toMatchObject({ generated: true, num_parcialidad: 1 });
    expect(generate.mock.calls[0][0].related_documents[0]).toMatchObject({ imp_saldo_ant: 580, imp_pagado: 580 });
  });
});

describe('cancel()', () => {
  test('another tenant\'s live REP citing this UUID does not block the cancellation', async () => {
    const doc = { id: 1, organization_id: 5, uuid: UUID, sat_status: 'vigente', tipo_comprobante: 'I', total: '580.00' };
    const guard = [];
    db.query.mockImplementation(async (sql, params = []) => {
      if (/FROM cfdi_documents WHERE id/.test(sql)) return [[doc]];
      if (/FROM cfdi_payment_complement_items/.test(sql)) {
        guard.push(params);
        return [foreignOnly(params) ? [{ id: 55, uuid: 'FOREIGN-REP' }] : []];
      }
      return [[]];
    });

    // No PAC is configured, so the cancel stops there: what matters is that the
    // REP guard let it through.
    await expect(cfdiService.cancel(1, '02')).rejects.not.toMatchObject({ code: 'CFDI_HAS_LIVE_REP' });
    expect(guard[0]).toEqual([UUID, 5]);
  });

  test('this org\'s own live REP still blocks it', async () => {
    const doc = { id: 1, organization_id: 5, uuid: UUID, sat_status: 'vigente', tipo_comprobante: 'I' };
    db.query.mockImplementation(async (sql) => {
      if (/FROM cfdi_documents WHERE id/.test(sql)) return [[doc]];
      if (/FROM cfdi_payment_complement_items/.test(sql)) return [[{ id: 56, uuid: 'OWN-REP' }]];
      return [[]];
    });
    await expect(cfdiService.cancel(1, '02')).rejects.toMatchObject({ code: 'CFDI_HAS_LIVE_REP' });
  });
});
