'use strict';
// =============================================================================
// General Public invoices built from a range of payment days — against a real database
// =============================================================================
// services/facturaPublicaService.js picks the invoices to report from the
// payments of a date range and one form of payment. Which invoice belongs to
// which payment, what is already taken, and that a draft holds exactly the
// invoices of the chosen payments can only be seen with real rows.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9901; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6, 95xx menus, 9601 billing ahead, 97xx tie-out, 98xx clientless CFDI
const OTHER = 9902;

describeDb('a General Public invoice from chosen payments against a real database', () => {
  let db;
  let app;
  let request;
  let admin;
  let client;
  const made = {};

  async function insert(table, row) {
    const cols = Object.keys(row);
    const [r] = await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
    return r.insertId;
  }
  const api = (method, path, body) => {
    const call = request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${admin.token}`);
    return body === undefined ? call : call.send(body);
  };
  // A paid invoice settled by one payment of the given method and day.
  async function sale(name, { method, day, total = '116.00', org = ORG, clientId = client }) {
    const invoice = await insert('invoices', {
      organization_id: org, client_id: clientId, invoice_number: `G-${name}`, issue_date: day, due_date: day,
      subtotal: (Number(total) / 1.16).toFixed(2), tax_rate: '0.1600', tax_amount: (Number(total) - Number(total) / 1.16).toFixed(2),
      total, currency: 'MXN', status: 'paid', paid_at: `${day} 18:00:00`,
    });
    const payment = await insert('payments', {
      organization_id: org, client_id: clientId, amount: total, currency: 'MXN', status: 'completed',
      payment_method: method, payment_date: day,
    });
    await insert('payment_allocations', { payment_id: payment, invoice_id: invoice, amount: total });
    made[name] = { invoice, payment };
    return made[name];
  }
  const unreported = (from, to) => api('get', `/facturas-publicas/unreported-invoices?date_from=${from}&date_to=${to}`);
  const generate = (body) => api('post', '/facturas-publicas/generate', body);

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    admin = await createOrgAdmin(db, ORG, 'GLOBALPAY');
    await db.query("UPDATE organizations SET locale = 'MX', country = 'MX' WHERE id = ?", [ORG]);
    app = require('../../../src/app');
    request = require('supertest');
    client = await insert('clients', { organization_id: ORG, name: 'Walk-in', status: 'active', locale: 'MX' });
    await sale('cash1', { method: 'cash', day: '2026-10-05' });
    await sale('cash2', { method: 'cash', day: '2026-10-12', total: '232.00' });
    await sale('cash3', { method: 'cash', day: '2026-10-20' });
    await sale('card1', { method: 'card', day: '2026-10-12' });
    await sale('spei1', { method: 'spei', day: '2026-10-12' });
    await sale('nov1', { method: 'cash', day: '2026-11-02' });
  }, 120000);

  afterAll(teardown);

  test('lists the unstamped paid invoices of the range, each with its payment id, day and form', async () => {
    const res = await unreported('2026-10-01', '2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.invoice_id)).toEqual([made.cash1.invoice, made.cash2.invoice, made.card1.invoice, made.spei1.invoice, made.cash3.invoice]);
    expect(res.body.data[1]).toMatchObject({
      invoice_number: 'G-cash2', client_name: 'Walk-in', payment_id: made.cash2.payment, payment_method: 'cash', forma_pago: '01', total: 232,
    });
    expect(String(res.body.data[1].payment_date).slice(0, 10)).toBe('2026-10-12');
    expect(res.body.meta).toMatchObject({ invoices: 5, total: 696, periodicidad: '04', meses: '10', anio: 2026 });
    expect(res.body.meta.by_forma).toEqual([
      { forma_pago: '01', invoices: 3, total: 464 }, { forma_pago: '04', invoices: 1, total: 116 }, { forma_pago: '03', invoices: 1, total: 116 },
    ]);
    // The span decides how it is filed: a day, a week, a fortnight, a month.
    expect((await unreported('2026-10-12', '2026-10-12')).body.meta).toMatchObject({ periodicidad: '01', invoices: 3 });
    expect((await unreported('2026-10-01', '2026-10-07')).body.meta).toMatchObject({ periodicidad: '02', invoices: 1 });
    expect((await unreported('2026-10-01', '2026-10-15')).body.meta.periodicidad).toBe('03');
  });

  test('a range across two months or with its dates out of order is refused', async () => {
    expect((await unreported('2026-10-20', '2026-11-05')).body.error.code).toBe('FACTURA_PUBLICA_RANGE');
    expect((await unreported('2026-10-20', '2026-10-05')).status).toBe(422);
    expect((await unreported('2026-10-20', 'soon')).status).toBe(422);
  });

  test('separated, each form of payment gets its own draft with the invoices left ticked', async () => {
    const res = await generate({
      date_from: '2026-10-01', date_to: '2026-10-15',
      invoice_ids: [made.cash1.invoice, made.cash2.invoice, made.card1.invoice],
    });
    expect(res.status).toBe(201);
    const byForma = Object.fromEntries(res.body.data.map(r => [r.forma_pago, r]));
    expect(Object.keys(byForma).sort()).toEqual(['01', '04']);
    expect(byForma['01']).toMatchObject({ status: 'draft', invoices: 2, total: 348, periodicidad: '03', meses: '10', anio: 2026 });
    expect(byForma['04']).toMatchObject({ invoices: 1, total: 116 });
    const [items] = await db.query('SELECT invoice_id FROM factura_publica_invoice_items WHERE factura_publica_invoice_id = ? ORDER BY invoice_id', [byForma['01'].id]);
    expect(items.map(i => i.invoice_id)).toEqual([made.cash1.invoice, made.cash2.invoice].sort((a, b) => a - b));

    // What was taken is not offered again; the transfer that was unticked is.
    const left = await unreported('2026-10-01', '2026-10-31');
    expect(left.body.data.map(r => r.invoice_id)).toEqual([made.spei1.invoice, made.cash3.invoice]);
  });

  test('not separated, one draft holds every form; and a second draft for the same month is allowed', async () => {
    const res = await generate({ date_from: '2026-10-01', date_to: '2026-10-31', separate: false });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ forma_pago: null, invoices: 2, total: 232, periodicidad: '04' });
    // Nothing is left, so another has nothing to report.
    const again = await generate({ date_from: '2026-10-01', date_to: '2026-10-31' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('FACTURA_PUBLICA_EMPTY');
  });

  test('each item of the stamped document names its invoice, payment id and payment day', async () => {
    const cfdiService = require('../../../src/services/cfdiService');
    jest.spyOn(cfdiService, 'getEmisorProfile').mockResolvedValue({ rfc: 'EKU9003173C9', razon_social: 'ESCUELA KEMPER URGATE', regimen_fiscal: '601', codigo_postal_fiscal: '26015', cfdi_serie_ingreso: 'A' });
    jest.spyOn(cfdiService, 'generateXml').mockResolvedValue({ xml: '<x/>' });
    jest.spyOn(cfdiService, 'stamp').mockResolvedValue({ uuid: 'UUID-TEST', status: 'vigente' });
    const draft = (await generate({ date_from: '2026-11-01', date_to: '2026-11-30' })).body.data[0];
    expect(draft).toMatchObject({ forma_pago: '01', invoices: 1 });
    const { stampGlobal } = require('../../../src/services/facturaPublicaService');
    const out = await stampGlobal(draft.id, ORG, { userId: admin.userId });
    const [[doc]] = await db.query('SELECT client_id, forma_pago, metodo_pago, receptor_rfc, total FROM cfdi_documents WHERE id = ?', [out.cfdi_document_id]);
    expect(doc).toMatchObject({ client_id: null, forma_pago: '01', metodo_pago: 'PUE', receptor_rfc: 'XAXX010101000' });
    expect(Number(doc.total)).toBe(116);
    const [conceptos] = await db.query('SELECT no_identificacion, descripcion FROM cfdi_conceptos WHERE cfdi_document_id = ?', [out.cfdi_document_id]);
    expect(conceptos).toEqual([{ no_identificacion: `G-nov1 PAGO ${made.nov1.payment} 2026-11-02`, descripcion: 'Venta' }]);
    jest.restoreAllMocks();
  });

  test('an invoice with its own CFDI, one credited in full, and another organization\'s payments are never offered', async () => {
    const own = await sale('own', { method: 'check', day: '2026-10-15' });
    await db.query(
      `INSERT INTO cfdi_documents (organization_id, client_id, invoice_id, tipo_comprobante, serie, folio, uso_cfdi, metodo_pago, forma_pago, moneda, exportacion,
         receptor_rfc, receptor_nombre, receptor_regimen, receptor_cp, subtotal, total_impuestos, total, sat_status)
       VALUES (?, ?, ?, 'I', 'A', 9001, 'G03', 'PUE', '02', 'MXN', '01', 'AAA010101AAA', 'ACME', '601', '06700', 100, 16, 116, 'vigente')`,
      [ORG, client, own.invoice],
    );
    const credited = await sale('credited', { method: 'check', day: '2026-10-16' });
    await insert('credit_notes', {
      organization_id: ORG, client_id: client, invoice_id: credited.invoice, credit_note_number: 'GCN-1', issue_date: '2026-10-17',
      reason: 'other', subtotal: '100.00', tax_rate: '0.1600', tax_amount: '16.00', total: '116.00', currency: 'MXN', status: 'applied',
    });
    const part = await sale('part', { method: 'check', day: '2026-10-18', total: '232.00' });
    await insert('credit_notes', {
      organization_id: ORG, client_id: client, invoice_id: part.invoice, credit_note_number: 'GCN-2', issue_date: '2026-10-19',
      reason: 'other', subtotal: '50.00', tax_rate: '0.1600', tax_amount: '8.00', total: '58.00', currency: 'MXN', status: 'applied',
    });
    await createOrgAdmin(db, OTHER, 'GLOBALPAY2');
    const theirs = await insert('clients', { organization_id: OTHER, name: 'Theirs', status: 'active' });
    await sale('theirs', { method: 'check', day: '2026-10-15', org: OTHER, clientId: theirs });

    const res = await unreported('2026-10-01', '2026-10-31');
    // Only the partly credited one, at what is left of it.
    expect(res.body.data.map(r => [r.invoice_id, r.payment_id, r.forma_pago, r.total])).toEqual([[part.invoice, part.payment, '02', 174]]);
    // Naming another organization's invoice takes nothing.
    const stolen = await generate({ date_from: '2026-10-01', date_to: '2026-10-31', invoice_ids: [made.theirs.invoice] });
    expect(stolen.status).toBe(422);
  });
});
