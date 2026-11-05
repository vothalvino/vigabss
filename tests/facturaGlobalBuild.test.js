'use strict';
// =============================================================================
// Building a factura global's invoice set (the staff screen)
// =============================================================================
// The API could create a factura pública, link one invoice at a time and
// stamp, but nothing said which invoices could join (paid in the period, no
// CFDI of their own, in no other factura), there was no way to take one out
// of a draft, and a month of sales to the general public is hundreds of
// invoices. These cover the eligibility query, linking all of them at once
// and unlinking one, each on a draft only.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const facturaPublicaService = require('../src/services/facturaPublicaService');
const { businessDayStartUtc } = require('../src/utils/businessDate');

const DRAFT = { id: 3, organization_id: 1, status: 'draft', cfdi_document_id: null, periodicidad: '04', meses: '10', anio: 2026 };

let conn;
function wire({ factura = DRAFT, eligible = [], byCurrency = [], affected = 0 } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM factura_publica_invoices WHERE id = \? AND organization_id = \?/.test(sql)) return [factura ? [factura] : []];
    if (/GROUP BY i\.currency/.test(sql)) return [byCurrency];
    if (/SELECT i\.id, i\.invoice_number/.test(sql)) return [eligible];
    return [{ affectedRows: affected }];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  conn = mockTxConnection(db);
});

describe('businessDayStartUtc', () => {
  test('is midnight in the business zone, as a UTC instant', () => {
    expect(businessDayStartUtc('2026-01-01', 'America/Mexico_City').toISOString()).toBe('2026-01-01T06:00:00.000Z');
    expect(businessDayStartUtc('2026-07-01', 'Europe/Madrid').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    // The day daylight saving starts: midnight is still in standard time.
    expect(businessDayStartUtc('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(businessDayStartUtc('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('the period a factura covers', () => {
  test.each([
    ['01', '2026-01-01', '2026-02-01'],
    ['12', '2026-12-01', '2027-01-01'],
    ['13', '2026-01-01', '2026-03-01'],
    ['18', '2026-11-01', '2027-01-01'],
  ])('meses %s is [%s, %s) in business days', (meses, from, to) => {
    const range = facturaPublicaService.periodRange({ meses, anio: 2026 });
    expect(range.from).toEqual(businessDayStartUtc(from));
    expect(range.to).toEqual(businessDayStartUtc(to));
  });
});

describe('eligible invoices', () => {
  test('are live, paid in the period, without their own CFDI and in no factura yet', async () => {
    wire({ eligible: [{ id: 11 }], byCurrency: [{ currency: 'MXN', count: 2, total: '348.00' }] });

    const result = await facturaPublicaService.listEligibleInvoices(3, 1);

    const [sql, params] = db.query.mock.calls.find(([q]) => /SELECT i\.id, i\.invoice_number/.test(q));
    expect(sql).toMatch(/i\.deleted_at IS NULL/);
    expect(sql).toMatch(/i\.status = 'paid'/);
    expect(sql).toMatch(/i\.paid_at >= \? AND i\.paid_at < \?/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM cfdi_documents cd[\s\S]*sat_status IN \('draft', 'vigente', 'cancel_pending'\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM factura_publica_invoice_items fi WHERE fi\.invoice_id = i\.id\)/);
    expect(params).toEqual([1, businessDayStartUtc('2026-10-01'), businessDayStartUtc('2026-11-01')]);
    expect(result.meta).toMatchObject({ total: 2, byCurrency: [{ currency: 'MXN', count: 2, total: '348.00' }] });
  });

  test('of another organization\'s factura are a 404', async () => {
    wire({ factura: null });
    await expect(facturaPublicaService.listEligibleInvoices(3, 2)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('linking every eligible invoice', () => {
  test('locks the draft and links them in one statement, in the transaction', async () => {
    wire({ affected: 2 });

    const result = await facturaPublicaService.addEligibleInvoices(3, 1, { currency: 'MXN' });

    expect(result).toEqual({ added: 2 });
    const [lockSql] = conn.execute.mock.calls[0];
    expect(lockSql).toMatch(/FROM factura_publica_invoices WHERE id = \? AND organization_id = \? FOR UPDATE/);
    const [insertSql, params] = conn.execute.mock.calls.find(([q]) => /INSERT INTO factura_publica_invoice_items/.test(q));
    expect(insertSql).toMatch(/SELECT \?, i\.id FROM invoices i\s+WHERE i\.deleted_at IS NULL AND i\.organization_id = \?/);
    expect(insertSql).toMatch(/AND i\.currency = \?/);
    expect(params).toEqual([3, 1, businessDayStartUtc('2026-10-01'), businessDayStartUtc('2026-11-01'), 'MXN']);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('is refused on a stamped factura', async () => {
    wire({ factura: { ...DRAFT, status: 'stamped', cfdi_document_id: 900 } });

    await expect(facturaPublicaService.addEligibleInvoices(3, 1)).rejects.toMatchObject({ statusCode: 422, code: 'FACTURA_PUBLICA_NOT_DRAFT' });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.execute.mock.calls.some(([q]) => /INSERT INTO/.test(q))).toBe(false);
  });
});

describe('unlinking an invoice', () => {
  test('deletes the item of this factura only', async () => {
    wire({ affected: 1 });

    await facturaPublicaService.removeItem(3, 40, 1);

    const [sql, params] = conn.execute.mock.calls.find(([q]) => /DELETE FROM factura_publica_invoice_items/.test(q));
    expect(sql).toMatch(/WHERE id = \? AND factura_publica_invoice_id = \?/);
    expect(params).toEqual([40, 3]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('of an item that is not on it is a 404', async () => {
    wire({ affected: 0 });
    await expect(facturaPublicaService.removeItem(3, 41, 1)).rejects.toMatchObject({ statusCode: 404 });
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('is refused on a stamped factura', async () => {
    wire({ factura: { ...DRAFT, status: 'stamped', cfdi_document_id: 900 }, affected: 1 });
    await expect(facturaPublicaService.removeItem(3, 40, 1)).rejects.toMatchObject({ statusCode: 422 });
    expect(conn.execute.mock.calls.some(([q]) => /DELETE FROM/.test(q))).toBe(false);
  });
});

describe('the routes', () => {
  test('are served, behind the factura permissions and the MX gate', () => {
    const inventory = require('./helpers/routeInventory');
    inventory.install();
    const app = require('../src/app');
    const routes = inventory.list(app).filter(r => r.path.startsWith('/api/v1/facturas-publicas/'));
    const has = (method, path) => routes.some(r => r.method === method && r.path === `/api/v1/facturas-publicas${path}`);
    expect(has('GET', '/:id/eligible-invoices')).toBe(true);
    expect(has('POST', '/:id/items/add-eligible')).toBe(true);
    expect(has('DELETE', '/:id/items/:itemId')).toBe(true);
  });
});
