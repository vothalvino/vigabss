'use strict';

// =============================================================================
// BIL-33 — CFDI automation: opt-in stamping of generated invoices, and
// same-invoice substitution
// =============================================================================
// The only stamping path was POST /invoices/:id/stamp, one invoice at a time.
// A CFDI with errors could not be substituted: a second CFDI for the invoice
// was refused while the first was vigente, and cancelling the first (motivo
// 01) settled the invoice itself to cancelled. The cancel_pending poller
// already exists (poll_cfdi_cancellations, CFD-01).
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
}));
jest.mock('../src/models/Invoice', () => ({ findByIdOrFail: jest.fn() }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/cfdiService', () => ({
  getEmisorProfile: jest.fn(),
  generateXml: jest.fn().mockResolvedValue({ xml: '<xml/>' }),
  stamp: jest.fn(),
  cancel: jest.fn(),
}));

const db = require('../src/config/database');
const Invoice = require('../src/models/Invoice');
const cfdiService = require('../src/services/cfdiService');
const invoiceCfdiService = require('../src/services/invoiceCfdiService');

const INVOICE = {
  id: 60, organization_id: 1, client_id: 7, invoice_number: 'INV-000060',
  status: 'issued', currency: 'MXN', subtotal: '800.00', tax_amount: '128.00',
  total: '928.00', tax_rate: '0.1600',
};
const EMISOR = { rfc: 'EKU9003173C9', razon_social: 'Escuela Kemper', regimen_fiscal: '601', codigo_postal_fiscal: '26015', cfdi_serie_ingreso: 'A' };
const RECEPTOR = { rfc: 'MISC491214B86', razon_social: 'CECILIA MIRANDA SANCHEZ', regimen_fiscal: '612', codigo_postal_fiscal: '01010', uso_cfdi_default: null };
const ITEMS = [{ id: 1, description: 'Internet', quantity: '1.00', unit_price: '800.00', amount: '800.00' }];
const ORIGINAL = { id: 5, invoice_id: 60, tipo_comprobante: 'I', sat_status: 'vigente', uuid: 'AAAA-ORIGINAL' };

let conn;
function makeConn() {
  const c = {
    executed: [],
    async beginTransaction() {},
    async execute(sql, params) {
      c.executed.push([sql, params]);
      if (sql.includes('INSERT INTO cfdi_documents')) return [{ insertId: 900 }];
      if (sql.includes('INSERT INTO cfdi_conceptos')) return [{ insertId: 1000 + c.executed.length }];
      if (/^\s*SELECT/i.test(sql)) return db.query(sql, params);
      return [{ affectedRows: 1 }];
    },
    async query() { return [[{ folio: 42 }]]; },
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  };
  return c;
}

// The invoice already has ORIGINAL (vigente); the fixtures answer like the DB.
function routeDb({ autoStamp = 0, liveRep = false } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    if (/SELECT cfdi_auto_stamp FROM organization_mx_profiles/.test(sql)) return [[{ cfdi_auto_stamp: autoStamp }]];
    if (/SELECT id, invoice_id, tipo_comprobante, sat_status, uuid FROM cfdi_documents WHERE id = \?/.test(sql)) return [[{ ...ORIGINAL }]];
    if (/FROM cfdi_payment_complement_items/.test(sql)) return [liveRep ? [{ uuid: 'REP-1' }] : []];
    if (/SELECT id FROM cfdi_documents WHERE id = \? AND invoice_id = \? AND organization_id = \? AND sat_status = 'vigente'/.test(sql)) {
      return [params[0] === ORIGINAL.id ? [{ id: ORIGINAL.id }] : []];
    }
    if (/FROM cfdi_documents\s+WHERE invoice_id = \?/.test(sql)) {
      // Live CFDIs of the invoice, minus the excluded one.
      const live = [{ id: ORIGINAL.id, sat_status: 'vigente' }];
      return [/AND id <> \?/.test(sql) ? live.filter(r => r.id !== params[2]) : live];
    }
    if (/FROM client_mx_profiles/.test(sql)) return [[{ ...RECEPTOR }]];
    if (/FROM invoice_items/.test(sql)) return [ITEMS.map(i => ({ ...i }))];
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  Invoice.findByIdOrFail.mockResolvedValue({ ...INVOICE });
  cfdiService.getEmisorProfile.mockResolvedValue({ ...EMISOR });
  cfdiService.generateXml.mockResolvedValue({ xml: '<xml/>' });
  cfdiService.stamp.mockResolvedValue({ uuid: 'BBBB-REPLACEMENT', status: 'vigente' });
  cfdiService.cancel.mockResolvedValue({ status: 'accepted' });
  conn = makeConn();
  db.getConnection.mockResolvedValue(conn);
});

describe('substitution', () => {
  test('a plain second stamp is still refused while the first CFDI is vigente', async () => {
    routeDb();
    await expect(invoiceCfdiService.stampInvoice(60, 1)).rejects.toMatchObject({ code: 'CFDI_EXISTS' });
  });

  test('stamps a replacement related with TipoRelacion 04, then cancels the original with motivo 01', async () => {
    routeDb();
    const result = await invoiceCfdiService.substituteInvoiceCfdi(5, 1, { userId: 3 });

    expect(result).toMatchObject({ stamped: true, uuid: 'BBBB-REPLACEMENT', substituted_cfdi_document_id: 5 });
    const relation = conn.executed.find(([sql]) => /INSERT INTO cfdi_related_documents/.test(sql));
    expect(relation[0]).toMatch(/VALUES \(\?, \?, '04'\)/);
    expect(relation[1]).toEqual([900, 'AAAA-ORIGINAL']);
    expect(cfdiService.cancel).toHaveBeenCalledWith(5, '01', 'BBBB-REPLACEMENT', { userId: 3 });
  });

  test('a replacement that does not stamp leaves the original vigente', async () => {
    routeDb();
    cfdiService.stamp.mockRejectedValue(new Error('PAC down'));
    const result = await invoiceCfdiService.substituteInvoiceCfdi(5, 1);
    expect(result).toMatchObject({ stamped: false, original_cancellation: null });
    expect(cfdiService.cancel).not.toHaveBeenCalled();
  });

  test('refused before anything is filed while a live REP cites the original', async () => {
    routeDb({ liveRep: true });
    await expect(invoiceCfdiService.substituteInvoiceCfdi(5, 1)).rejects.toMatchObject({ code: 'CFDI_HAS_LIVE_REP' });
    expect(db.getConnection).not.toHaveBeenCalled();
  });
});

describe('automatic stamping of generated invoices', () => {
  test('off by default: nothing is stamped', async () => {
    routeDb({ autoStamp: 0 });
    expect(await invoiceCfdiService.autoStampInvoice(60, 1)).toEqual({ attempted: false });
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('on: the invoice is stamped', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT cfdi_auto_stamp/.test(sql)) return [[{ cfdi_auto_stamp: 1 }]];
      if (/FROM client_mx_profiles/.test(sql)) return [[{ ...RECEPTOR }]];
      if (/FROM invoice_items/.test(sql)) return [ITEMS.map(i => ({ ...i }))];
      return [[]];
    });
    expect(await invoiceCfdiService.autoStampInvoice(60, 1)).toMatchObject({ attempted: true, stamped: true, cfdi_document_id: 900 });
    expect(cfdiService.stamp).toHaveBeenCalledWith(900, { userId: null });
  });

  test('a rerun does not stamp twice, and a refusal is returned rather than thrown', async () => {
    routeDb({ autoStamp: 1 });
    expect(await invoiceCfdiService.autoStampInvoice(60, 1)).toEqual({ attempted: true, stamped: false, already: true });

    Invoice.findByIdOrFail.mockResolvedValue({ ...INVOICE, status: 'draft' });
    expect(await invoiceCfdiService.autoStampInvoice(60, 1)).toMatchObject({ attempted: true, stamped: false, error: expect.stringMatching(/can be stamped/) });
  });
});
