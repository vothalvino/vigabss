'use strict';
// =============================================================================
// A General Public invoice built from chosen payments — against a real database
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
  const eligible = (q) => api('get', `/facturas-publicas/eligible-payments?date_from=${q.from}&date_to=${q.to}&forma_pago=${q.forma}`);

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

  test('lists the payments of the range and form of payment, each with its invoices', async () => {
    const res = await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '01' });
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.payment_id)).toEqual([made.cash1.payment, made.cash2.payment, made.cash3.payment]);
    expect(res.body.data[1]).toMatchObject({ payment_method: 'cash', client_name: 'Walk-in', total: 232, invoices: [{ id: made.cash2.invoice, total: 232 }] });
    expect(res.body.meta).toMatchObject({ payments: 3, invoices: 3, total: 464, periodicidad: '04', meses: '10', anio: 2026 });
    // Card and transfer are their own documents; a narrower range is its own periodicity.
    expect((await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '04' })).body.data.map(p => p.payment_id)).toEqual([made.card1.payment]);
    expect((await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '03' })).body.data.map(p => p.payment_id)).toEqual([made.spei1.payment]);
    const day = await eligible({ from: '2026-10-12', to: '2026-10-12', forma: '01' });
    expect(day.body.data.map(p => p.payment_id)).toEqual([made.cash2.payment]);
    expect(day.body.meta.periodicidad).toBe('01');
  });

  test('a range across two months, dates out of order or an unknown form are refused', async () => {
    expect((await eligible({ from: '2026-10-20', to: '2026-11-05', forma: '01' })).body.error.code).toBe('FACTURA_PUBLICA_RANGE');
    expect((await eligible({ from: '2026-10-20', to: '2026-10-05', forma: '01' })).status).toBe(422);
    expect((await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '99' })).status).toBe(422);
  });

  test('a draft holds exactly the invoices of the payments left ticked, and they are then taken', async () => {
    const res = await api('post', '/facturas-publicas/generate', {
      date_from: '2026-10-01', date_to: '2026-10-31', forma_pago: '01', payment_ids: [made.cash1.payment, made.cash3.payment],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'draft', forma_pago: '01', payments: 2, invoices: 2, total: 232, periodicidad: '04', meses: '10', anio: 2026 });
    const [items] = await db.query('SELECT invoice_id FROM factura_publica_invoice_items WHERE factura_publica_invoice_id = ? ORDER BY invoice_id', [res.body.data.id]);
    expect(items.map(i => i.invoice_id)).toEqual([made.cash1.invoice, made.cash3.invoice].sort((a, b) => a - b));
    const [[row]] = await db.query('SELECT forma_pago, date_from, date_to FROM factura_publica_invoices WHERE id = ?', [res.body.data.id]);
    expect(row.forma_pago).toBe('01');

    // What is left for cash in October is the payment that was unticked.
    const left = await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '01' });
    expect(left.body.data.map(p => p.payment_id)).toEqual([made.cash2.payment]);
    // A second record for the same month is allowed: by default it takes everything left.
    const second = await api('post', '/facturas-publicas/generate', { date_from: '2026-10-01', date_to: '2026-10-31', forma_pago: '01' });
    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({ payments: 1, invoices: 1, total: 232 });
    // Nothing is left, so a third has nothing to report.
    const third = await api('post', '/facturas-publicas/generate', { date_from: '2026-10-01', date_to: '2026-10-31', forma_pago: '01' });
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('FACTURA_PUBLICA_EMPTY');
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

    const res = await eligible({ from: '2026-10-01', to: '2026-10-31', forma: '02' });
    // Only the partly credited one, at what is left of it.
    expect(res.body.data.map(p => [p.payment_id, p.total])).toEqual([[part.payment, 174]]);
    // Naming another organization's payment takes nothing.
    const stolen = await api('post', '/facturas-publicas/generate', { date_from: '2026-10-01', date_to: '2026-10-31', forma_pago: '02', payment_ids: [made.theirs.payment] });
    expect(stolen.status).toBe(422);
  });
});
