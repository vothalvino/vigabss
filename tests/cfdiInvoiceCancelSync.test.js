// =============================================================================
// VigaBSS 5.0 — CFDI cancellation → invoice sync wiring
// =============================================================================
// When SAT ACCEPTS a CFDI cancellation (sat_status → 'cancelado'), cfdiService
// must sync the underlying invoice to 'cancelled' via billingService so it drops
// out of receivables and tax reports. billingService is mocked here so we assert
// only the wiring: the cancel flow reaches the accepted branch and calls
// cancelInvoiceForSat with the invoice behind the CFDI.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/billingService', () => ({
  cancelInvoiceForSat: jest.fn().mockResolvedValue({ status: 'cancelled' }),
}));

const db = require('../src/config/database');
const billingService = require('../src/services/billingService');
const cfdiService = require('../src/services/cfdiService');
const auditLog = require('../src/services/auditLog');

// A vigente CFDI (id 7) stamped for invoice 55, org 1. 'dev_placeholder' is an
// unknown provider → callPacCancel returns a simulated 'accepted' outside prod.
const DOC = { id: 7, organization_id: 1, invoice_id: 55, uuid: 'UUID-VIGENTE-1', sat_status: 'vigente' };
const PAC = { id: 2, provider_name: 'dev_placeholder', organization_id: 1, status: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  cfdiService._resetProviderBreakers();
  db.query.mockImplementation((sql) => {
    if (/SELECT invoice_id, .*FROM cfdi_documents/.test(sql)) {
      return Promise.resolve([[{ invoice_id: 55, organization_id: 1 }]]);
    }
    if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return Promise.resolve([[DOC]]);
    if (/FROM pac_providers/.test(sql)) return Promise.resolve([[PAC]]);
    if (/INSERT INTO cfdi_cancellations/.test(sql)) return Promise.resolve([{ insertId: 900 }]);
    // The document moves only from vigente/cancel_pending (CFD-01).
    if (/^\s*UPDATE cfdi_documents/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
    return Promise.resolve([[]]);
  });
});

test('accepting a SAT cancellation syncs the invoice to cancelled', async () => {
  const res = await cfdiService.cancel(7, '02', null);

  expect(res.status).toBe('cancelado');
  expect(billingService.cancelInvoiceForSat).toHaveBeenCalledWith(55, 1, null);
});

test('a CFDI with no linked invoice does not attempt a sync', async () => {
  db.query.mockImplementation((sql) => {
    if (/SELECT invoice_id, .*FROM cfdi_documents/.test(sql)) {
      return Promise.resolve([[{ invoice_id: null, organization_id: 1 }]]);
    }
    if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return Promise.resolve([[DOC]]);
    if (/FROM pac_providers/.test(sql)) return Promise.resolve([[PAC]]);
    if (/INSERT INTO cfdi_cancellations/.test(sql)) return Promise.resolve([{ insertId: 901 }]);
    return Promise.resolve([[]]);
  });

  const res = await cfdiService.cancel(7, '02', null);

  expect(res.status).toBe('cancelado');
  expect(billingService.cancelInvoiceForSat).not.toHaveBeenCalled();
});

test('a sync failure does not fail the (already-succeeded) SAT cancellation', async () => {
  billingService.cancelInvoiceForSat.mockRejectedValueOnce(new Error('ledger down'));

  const res = await cfdiService.cancel(7, '02', null);

  // The CFDI is cancelado at SAT regardless — the sync is best-effort.
  expect(res.status).toBe('cancelado');
});

test('refuses to cancel a CFDI while a vigente payment complement (REP) references it', async () => {
  // SAT requires the REP to be cancelled first; the guard must fire BEFORE any
  // state change (no cfdi_cancellations insert, no cancel_pending flip, no PAC).
  db.query.mockImplementation((sql) => {
    if (/FROM cfdi_payment_complement_items/.test(sql)) {
      return Promise.resolve([[{ id: 30, uuid: 'REP-UUID-0001' }]]);
    }
    if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return Promise.resolve([[DOC]]);
    if (/FROM pac_providers/.test(sql)) return Promise.resolve([[PAC]]);
    return Promise.resolve([[]]);
  });

  await expect(cfdiService.cancel(7, '02', null))
    .rejects.toMatchObject({ statusCode: 422, code: 'CFDI_HAS_LIVE_REP' });

  const sqls = db.query.mock.calls.map((c) => c[0]).join('\n');
  expect(sqls).not.toMatch(/INSERT INTO cfdi_cancellations/);
  expect(sqls).not.toMatch(/SET sat_status/);
  expect(billingService.cancelInvoiceForSat).not.toHaveBeenCalled();
});

test('stamp() refuses a draft whose linked invoice is void (backstop)', async () => {
  db.query.mockImplementation((sql) => {
    if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) {
      return Promise.resolve([[{ id: 9, organization_id: 1, invoice_id: 70, xml_content: '<xml/>', sat_status: 'draft' }]]);
    }
    if (/SELECT status FROM invoices/.test(sql)) return Promise.resolve([[{ status: 'void' }]]);
    return Promise.resolve([[]]);
  });
  await expect(cfdiService.stamp(9))
    .rejects.toMatchObject({ statusCode: 422, code: 'INVOICE_TERMINAL' });
  const sqls = db.query.mock.calls.map((c) => c[0]).join('\n');
  expect(sqls).not.toMatch(/pac_providers/); // refused before any PAC work
});

test('acuse_fecha is bound as a Date object, never an ISO-Z string (MySQL DATETIME strict mode)', async () => {
  // The simulator/dev PAC branches return acuseFecha as toISOString() — the
  // 'T'+'Z' form MySQL DATETIME rejects (1292 → 500 in live testing).
  const res = await cfdiService.cancel(7, '02', null);
  expect(res.status).toBe('cancelado');
  const upd = db.query.mock.calls.find(([sql]) => /UPDATE cfdi_cancellations/.test(sql) && /acuse_fecha/.test(sql));
  expect(upd).toBeTruthy();
  const acuseFechaParam = upd[1][2];
  expect(acuseFechaParam instanceof Date).toBe(true);
});

// CFD-07: an egreso carries credit_note_id, not invoice_id, so its SAT
// cancellation never reached the note, which stayed 'issued' and kept
// crediting the client.
describe('a cancelled CFDI de Egreso cancels its credit note', () => {
  const EGRESO = { id: 8, organization_id: 1, invoice_id: null, credit_note_id: 40, tipo_comprobante: 'E', uuid: 'UUID-EGRESO-1', sat_status: 'vigente' };
  const NOTE = { id: 40, organization_id: 1, client_id: 42, total: '232.00', currency: 'MXN', status: 'issued', credit_note_number: 'NC-40' };
  let conn;

  function wire(note) {
    db.query.mockImplementation((sql) => {
      if (/SELECT invoice_id, .*FROM cfdi_documents/.test(sql)) return Promise.resolve([[EGRESO]]);
      if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return Promise.resolve([[EGRESO]]);
      if (/FROM pac_providers/.test(sql)) return Promise.resolve([[PAC]]);
      if (/INSERT INTO cfdi_cancellations/.test(sql)) return Promise.resolve([{ insertId: 902 }]);
      if (/^\s*UPDATE cfdi_documents/.test(sql)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    conn = {
      beginTransaction: jest.fn().mockResolvedValue(), commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/FROM credit_notes WHERE id = \? .*FOR UPDATE/.test(sql)) return [note ? [{ ...note }] : []];
        // The note's posted credit: 232 credited (the signed sum is negative for credits).
        if (/FROM client_balance_ledger/.test(sql)) return [[{ net: '-232.00' }]];
        return [{ affectedRows: 1, insertId: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
  }

  test('the note turns cancelled and its credit is reversed, in one transaction', async () => {
    wire(NOTE);
    const res = await cfdiService.cancel(8, '02', null);
    expect(res.status).toBe('cancelado');

    const sqls = conn.execute.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => /UPDATE credit_notes SET status = 'cancelled' WHERE id = \?/.test(sql))).toBe(true);
    const reversal = conn.execute.mock.calls.find(([sql]) => /INSERT INTO client_balance_ledger/.test(sql));
    expect(reversal[1]).toEqual(expect.arrayContaining([42, 1, 'debit', 232]));
    expect(conn.commit).toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ tableName: 'credit_notes', recordId: 40 }));
    expect(billingService.cancelInvoiceForSat).not.toHaveBeenCalled();
  });

  test('an already-cancelled note is left alone', async () => {
    wire({ ...NOTE, status: 'cancelled' });
    await cfdiService.cancel(8, '02', null);
    expect(conn.execute.mock.calls.some(([sql]) => /UPDATE credit_notes/.test(sql))).toBe(false);
    expect(conn.commit).not.toHaveBeenCalled();
  });
});
