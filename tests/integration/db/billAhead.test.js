'use strict';
// =============================================================================
// Paying ahead bills ahead — against a real database
// =============================================================================
// services/billAheadService.js drives the real billing run, credit
// application and locks. What matters can only be seen with MySQL: that the
// months come out consecutive and paid, that the money is used exactly once,
// that the monthly run then leaves those months alone, and that two runs at
// once do not invoice a month twice.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9601; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6, 95xx menus

describeDb('billing ahead against a real database', () => {
  let db;
  let app;
  let request;
  let admin;
  let billAhead;

  async function insert(table, row) {
    const cols = Object.keys(row);
    const [r] = await db.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c]),
    );
    return r.insertId;
  }

  // A client with one active contract that started on the first of this month.
  async function customer(name, price = '100.00') {
    const client = await insert('clients', { organization_id: ORG, name, status: 'active' });
    const plan = await insert('plans', {
      organization_id: ORG, name: `Plan ${name}`, download_speed_mbps: 50, upload_speed_mbps: 10,
      price, currency: 'MXN', billing_cycle: 'monthly', status: 'active',
    });
    const start = `${new Date().toISOString().slice(0, 7)}-01`;
    const contract = await insert('contracts', {
      organization_id: ORG, client_id: client, plan_id: plan, start_date: start, status: 'active', connection_type: 'pppoe',
    });
    return { client, plan, contract };
  }

  const pay = (client, amount) => insert('payments', {
    organization_id: ORG, client_id: client, amount, currency: 'MXN', status: 'completed',
    payment_method: 'transfer', payment_date: new Date().toISOString().slice(0, 10),
  });

  async function invoicesOf(client) {
    const [rows] = await db.query(
      `SELECT i.id, i.status, i.total, i.billed_ahead, bp.period_start, bp.period_end,
              COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0) AS paid
         FROM invoices i JOIN billing_periods bp ON bp.invoice_id = i.id
        WHERE i.client_id = ? AND i.deleted_at IS NULL ORDER BY bp.period_start`,
      [client],
    );
    return rows.map(r => ({ ...r, total: Number(r.total), paid: Number(r.paid), start: new Date(r.period_start).toISOString().slice(0, 10), end: new Date(r.period_end).toISOString().slice(0, 10) }));
  }

  const dayAfter = (ymd) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    admin = await createOrgAdmin(db, ORG, 'AHEAD');
    ({ billAhead } = require('../../../src/services/billAheadService'));
    app = require('../../../src/app');
    request = require('supertest');
  }, 120000);

  afterAll(teardown);

  test('money paid ahead becomes consecutive months, each paid, the last one in part', async () => {
    const c = await customer('Ahead One');
    await pay(c.client, '1000.00');
    const out = await billAhead({ orgId: ORG, clientId: c.client });
    const invoices = await invoicesOf(c.client);

    expect(out.invoices.length).toBe(invoices.length);
    expect(invoices.length).toBeGreaterThanOrEqual(3);
    // Every peso of the payment is on an invoice, and none twice.
    const applied = Math.round(invoices.reduce((t, i) => t + i.paid, 0) * 100) / 100;
    expect(applied).toBe(1000);
    expect(out.applied).toBe(1000);
    // All but the last are fully paid; the last holds what was left.
    const last = invoices.at(-1);
    for (const inv of invoices.slice(0, -1)) expect([inv.id, inv.status, inv.paid]).toEqual([inv.id, 'paid', inv.total]);
    expect(last.paid).toBeGreaterThan(0);
    expect(last.paid).toBeLessThanOrEqual(last.total);
    if (last.paid < last.total) expect(last.status).not.toBe('paid');
    // The months follow each other with no gap and no overlap.
    for (let i = 1; i < invoices.length; i += 1) expect(invoices[i].start).toBe(dayAfter(invoices[i - 1].end));
    // Months whose billing day has not come are marked as billed ahead.
    expect(invoices.filter(i => Number(i.billed_ahead) === 1).length).toBeGreaterThanOrEqual(invoices.length - 2);
  });

  test('running it again invoices nothing more, and the monthly run leaves those months alone', async () => {
    const c = await customer('Ahead Two');
    await pay(c.client, '1000.00');
    await billAhead({ orgId: ORG, clientId: c.client });
    const before = await invoicesOf(c.client);

    const again = await billAhead({ orgId: ORG, clientId: c.client });
    expect(again.invoices).toEqual([]);
    const run = await require('../../../src/services/taskRunner').runAutoInvoice(ORG);
    expect(run.contracts_failed).toBe(0);
    const after = await invoicesOf(c.client);
    expect(after.map(i => i.id)).toEqual(before.map(i => i.id));
  });

  test('two runs at once invoice each month once', async () => {
    const c = await customer('Ahead Three');
    await pay(c.client, '1000.00');
    await Promise.all([
      billAhead({ orgId: ORG, clientId: c.client }),
      billAhead({ orgId: ORG, clientId: c.client }),
      billAhead({ orgId: ORG, clientId: c.client }),
    ]);
    // A run that found the client busy steps aside; one more makes sure the work is done.
    await billAhead({ orgId: ORG, clientId: c.client });
    const invoices = await invoicesOf(c.client);
    expect(new Set(invoices.map(i => i.start)).size).toBe(invoices.length);
    expect(Math.round(invoices.reduce((t, i) => t + i.paid, 0) * 100) / 100).toBe(1000);
    // No month was invoiced beyond what the money reaches.
    expect(invoices.filter(i => i.paid === 0)).toEqual([]);
  });

  test('what the client already owes is paid before any month is invoiced ahead', async () => {
    const c = await customer('Ahead Four');
    const owed = await insert('invoices', {
      organization_id: ORG, client_id: c.client, invoice_number: 'AHEAD-OWED-1', subtotal: '300.00', tax_amount: 0,
      total: '300.00', currency: 'MXN', tax_rate: 0, due_date: '2026-12-31', issue_date: '2026-11-01', status: 'issued',
    });
    await pay(c.client, '350.00');
    await billAhead({ orgId: ORG, clientId: c.client });
    const [[row]] = await db.query('SELECT status FROM invoices WHERE id = ?', [owed]);
    expect(row.status).toBe('paid');
    const ahead = await invoicesOf(c.client);
    // Only the 50 left over went to a month.
    expect(Math.round(ahead.reduce((t, i) => t + i.paid, 0) * 100) / 100).toBe(50);
    expect(ahead.length).toBe(1);
  });

  test('a client with no money ahead is not invoiced', async () => {
    const c = await customer('Ahead Five');
    const out = await billAhead({ orgId: ORG, clientId: c.client });
    expect(out.invoices).toEqual([]);
    expect(await invoicesOf(c.client)).toEqual([]);
  });

  test('a plan that charges data overage is not billed ahead: the money waits', async () => {
    const c = await customer('Ahead Six');
    await db.query("UPDATE plans SET overage_mode = 'per_gb', data_cap_gb = 100, overage_price_per_gb = 1 WHERE id = ?", [c.plan]);
    await pay(c.client, '1000.00');
    const out = await billAhead({ orgId: ORG, clientId: c.client });
    expect(out.invoices).toEqual([]);
    expect(await invoicesOf(c.client)).toEqual([]);
  });

  test('the route does the same for a signed-in person, and refuses another organization\'s client', async () => {
    const c = await customer('Ahead Seven');
    await pay(c.client, '250.00');
    const res = await request(app).post(`/api/v1/clients/${c.client}/bill-ahead`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(250);
    expect(res.body.data.invoices.length).toBeGreaterThanOrEqual(1);
    const none = await request(app).post('/api/v1/clients/999999999/bill-ahead').set('Authorization', `Bearer ${admin.token}`);
    expect(none.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // A plan change midway (services/planChangeProrationService.js)
  // ---------------------------------------------------------------------------
  const otherPlan = (name, price) => insert('plans', {
    organization_id: ORG, name, download_speed_mbps: 20, upload_speed_mbps: 5,
    price, currency: 'MXN', billing_cycle: 'monthly', status: 'active',
  });
  const changePlan = (contract, plan) => request(app)
    .put(`/api/v1/contracts/${contract}`).set('Authorization', `Bearer ${admin.token}`).send({ plan_id: plan });
  const money = (n) => Math.round(Number(n) * 100) / 100;

  test('a downgrade keeps every invoiced month, credits the difference, and the freed money pays for more months', async () => {
    const c = await customer('Change Down', '200.00');
    await pay(c.client, '1000.00');
    await billAhead({ orgId: ORG, clientId: c.client });
    const before = await invoicesOf(c.client);
    const cheaper = await otherPlan('Change Down cheaper', '100.00');

    const res = await changePlan(c.contract, cheaper);
    expect(res.status).toBe(200);
    const after = await invoicesOf(c.client);

    // The months invoiced before are all still there, and more follow them.
    expect(after.slice(0, before.length).map(i => i.id)).toEqual(before.map(i => i.id));
    expect(after.length).toBeGreaterThan(before.length);
    for (let i = 1; i < after.length; i += 1) expect(after[i].start).toBe(dayAfter(after[i - 1].end));
    // The customer's 1,000 is still exactly on invoices: nothing lost, nothing counted twice.
    expect(money(after.reduce((t, i) => t + i.paid, 0))).toBe(1000);
    // Each month that had been fully paid is still paid: by the payment plus its credit note.
    const [notes] = await db.query(
      `SELECT cn.invoice_id, cn.total, COALESCE((SELECT SUM(a.amount) FROM credit_note_applications a
                WHERE a.credit_note_id = cn.id AND a.deleted_at IS NULL), 0) AS applied
         FROM credit_notes cn WHERE cn.client_id = ? AND cn.invoice_id IS NOT NULL AND cn.deleted_at IS NULL`,
      [c.client],
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const [rows] = await db.query('SELECT id, status FROM invoices WHERE id IN (?) ', [before.filter(i => i.status === 'paid').map(i => i.id)]);
    for (const row of rows) expect([row.id, row.status]).toEqual([row.id, 'paid']);
    for (const note of notes) expect(money(note.applied)).toBe(money(note.total));
    // A month the payment had only partly paid is completed before any new
    // month is added: no earlier month owes while a later one is paid.
    const firstUnpaid = after.findIndex(i => i.status !== 'paid');
    if (firstUnpaid !== -1) expect(after.slice(firstUnpaid + 1).every(i => i.paid === 0)).toBe(true);
    // The new months are at the new price.
    const added = after.slice(before.length);
    expect(added.every(i => i.total < before[0].total)).toBe(true);
  });

  test('a downgrade completes a month the payment had only partly paid before it adds new months', async () => {
    // Amounts whose float sum falls a hair short of the total (346.84 paid +
    // 232.00 credited against 578.84): the month must still come out paid.
    const c = await customer('Change Partial', '578.84');
    await pay(c.client, '2025.94');
    await billAhead({ orgId: ORG, clientId: c.client });
    const before = await invoicesOf(c.client);
    const partial = before.find(i => i.paid > 0 && i.paid < i.total);
    expect(partial).toBeDefined();
    const cheaper = await otherPlan('Change Partial cheaper', '346.84');

    expect((await changePlan(c.contract, cheaper)).status).toBe(200);
    const after = await invoicesOf(c.client);
    // The month that was partly paid is now paid in full...
    expect(after.find(i => i.id === partial.id).status).toBe('paid');
    // ...no earlier month owes while a later one holds money...
    const firstUnpaid = after.findIndex(i => i.status !== 'paid');
    if (firstUnpaid !== -1) expect(after.slice(firstUnpaid + 1).every(i => i.paid === 0)).toBe(true);
    // ...and the payment is still exactly on invoices.
    expect(money(after.reduce((t, i) => t + i.paid, 0))).toBe(2025.94);
    expect(after.length).toBeGreaterThan(before.length);
  });

  test('an upgrade bills the difference of every month already invoiced on one extra invoice', async () => {
    const c = await customer('Change Up', '100.00');
    await pay(c.client, '1000.00');
    await billAhead({ orgId: ORG, clientId: c.client });
    const before = await invoicesOf(c.client);
    const dearer = await otherPlan('Change Up dearer', '150.00');

    const res = await changePlan(c.contract, dearer);
    expect(res.status).toBe(200);
    const after = await invoicesOf(c.client);
    // No month is added or removed.
    expect(after.map(i => i.id)).toEqual(before.map(i => i.id));
    const [extra] = await db.query(
      `SELECT i.id, i.subtotal, i.status FROM invoices i
        WHERE i.client_id = ? AND i.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM billing_periods bp WHERE bp.invoice_id = i.id)`,
      [c.client],
    );
    expect(extra.length).toBe(1);
    // At least the whole difference (50) of every month after the current one.
    const today = new Date().toISOString().slice(0, 10);
    const monthsAhead = before.filter(i => i.start > today).length;
    expect(monthsAhead).toBeGreaterThanOrEqual(1);
    expect(Number(extra[0].subtotal)).toBeGreaterThanOrEqual(50 * monthsAhead);
    expect(Number(extra[0].subtotal)).toBeLessThanOrEqual(50 * (monthsAhead + 1));
  });
});
