'use strict';
// =============================================================================
// OPS-20 — money, numbering and locking paths against a real database
// =============================================================================
// The mocked suites can show which SQL a path sends, not what MySQL does with
// two of them at once: whether FOR UPDATE serializes, whether a unique key or
// the over-allocation trigger refuses the second writer, and whether the code
// handles that refusal. Each test here races the real code against itself.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9201;
const OTHER = 9202;

describeDb('money and locking against a real database', () => {
  let db;
  let app;
  let request;
  let admin;
  const fx = {};

  async function insert(table, row) {
    const cols = Object.keys(row);
    const [r] = await db.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c]),
    );
    return r.insertId;
  }

  async function invoice(org, client, total, number) {
    return insert('invoices', {
      organization_id: org, client_id: client, invoice_number: number, subtotal: total, tax_amount: 0,
      total, currency: 'MXN', tax_rate: 0, due_date: '2026-12-31', issue_date: '2026-11-01', status: 'issued',
    });
  }

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    admin = await createOrgAdmin(db, ORG, 'MONEY');
    await createOrgAdmin(db, OTHER, 'MONEY2');
    for (const org of [ORG, OTHER]) {
      const client = await insert('clients', { organization_id: org, name: `Client ${org}`, status: 'active' });
      const plan = await insert('plans', {
        organization_id: org, name: `Plan ${org}`, download_speed_mbps: 50, upload_speed_mbps: 10,
        price: '500.00', currency: 'MXN', billing_cycle: 'monthly', status: 'active',
      });
      const contract = await insert('contracts', {
        organization_id: org, client_id: client, plan_id: plan, start_date: '2026-01-01', status: 'active', connection_type: 'pppoe',
      });
      fx[org] = { client, plan, contract };
    }
    app = require('../../../src/app');
    request = require('supertest');
  }, 120000);

  afterAll(teardown);

  test('concurrent invoice numbers are distinct and gapless, and each organization counts on its own', async () => {
    const { nextInvoiceNumber } = require('../../../src/services/billingService');
    const draw = async org => {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const n = await nextInvoiceNumber(conn, org);
        await conn.commit();
        return n;
      } finally {
        conn.release();
      }
    };
    const [ours, theirs] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, () => draw(ORG))),
      Promise.all(Array.from({ length: 5 }, () => draw(OTHER))),
    ]);
    const nums = ours.map(n => Number(n.slice(4))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(20);
    expect(nums.at(-1) - nums[0]).toBe(19);
    expect(theirs.map(n => Number(n.slice(4))).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test('concurrent quote numbers are distinct', async () => {
    const { nextQuoteNumber } = require('../../../src/services/billingService');
    const nums = await Promise.all(Array.from({ length: 10 }, async () => {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const n = await nextQuoteNumber(conn, ORG);
        await conn.commit();
        return n;
      } finally {
        conn.release();
      }
    }));
    expect(new Set(nums).size).toBe(10);
  });

  test('concurrent service-order numbers are distinct', async () => {
    const { nextOrderNumber } = require('../../../src/services/lifecycleService');
    const nums = await Promise.all(Array.from({ length: 10 }, async () => {
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const n = await nextOrderNumber(conn, ORG);
        await conn.commit();
        return n;
      } finally {
        conn.release();
      }
    }));
    expect(new Set(nums).size).toBe(10);
  });

  test('two runs for the same contract create one billing period and one invoice', async () => {
    const billing = require('../../../src/services/billingService');
    const [[contract]] = await db.query('SELECT * FROM contracts WHERE id = ?', [fx[ORG].contract]);
    const [[plan]] = await db.query('SELECT * FROM plans WHERE id = ?', [fx[ORG].plan]);

    const periods = await Promise.all([billing.generateBillingPeriod(contract), billing.generateBillingPeriod(contract)]);
    expect(periods[0].id).toBe(periods[1].id);
    const [[{ n: periodCount }]] = await db.query('SELECT COUNT(*) AS n FROM billing_periods WHERE contract_id = ?', [contract.id]);
    expect(Number(periodCount)).toBe(1);

    const invoices = await Promise.all([
      billing.generateInvoice(periods[0], contract, plan, ORG),
      billing.generateInvoice(periods[0], contract, plan, ORG),
    ]);
    expect(invoices[0].id).toBe(invoices[1].id);
    const [[{ n: invoiceCount }]] = await db.query(
      'SELECT COUNT(*) AS n FROM invoices WHERE contract_id = ? AND deleted_at IS NULL', [contract.id],
    );
    expect(Number(invoiceCount)).toBe(1);
  });

  test('two payments raced onto one invoice never allocate more than its total', async () => {
    const inv = await invoice(ORG, fx[ORG].client, '100.00', 'RACE-0001');
    const payments = [];
    for (let i = 0; i < 2; i++) {
      payments.push(await insert('payments', {
        organization_id: ORG, client_id: fx[ORG].client, amount: '100.00', currency: 'MXN',
        status: 'completed', payment_method: 'cash', payment_date: '2026-11-02',
      }));
    }
    const results = await Promise.all(payments.map(id => request(app)
      .post(`/api/v1/payments/${id}/allocate`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ invoice_id: inv, amount: 100 })));
    expect(results.map(r => r.status).sort()).toEqual([201, 422]);
    const [[{ allocated }]] = await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS allocated FROM payment_allocations WHERE invoice_id = ? AND deleted_at IS NULL', [inv],
    );
    expect(Number(allocated)).toBe(100);
    const [[row]] = await db.query('SELECT status FROM invoices WHERE id = ?', [inv]);
    expect(row.status).toBe('paid');
  });

  test('the over-allocation trigger refuses what the route checks would miss', async () => {
    const inv = await invoice(ORG, fx[ORG].client, '50.00', 'RACE-0002');
    const pay = await insert('payments', {
      organization_id: ORG, client_id: fx[ORG].client, amount: '80.00', currency: 'MXN',
      status: 'completed', payment_method: 'cash', payment_date: '2026-11-02',
    });
    await expect(db.query('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)', [pay, inv, '60.00']))
      .rejects.toMatchObject({ sqlState: '45000' });
  });

  test('a webhook event is deduplicated per organization, including concurrent redeliveries', async () => {
    const gateway = require('../../../src/services/paymentGatewayService');
    // An event type the gateway does not act on settles as 'ignored', so a
    // later redelivery is a duplicate whether or not it overlaps the first.
    const event = (org, id) => ({
      provider: 'stripe', providerEventId: id, eventType: 'customer.created',
      payload: { id, data: { object: { id: 'cus_it' } } }, organizationId: org,
    });
    // The same provider event id in two organizations is two events.
    const [a, b] = await Promise.all([
      gateway.handleWebhookEvent(event(ORG, 'evt_it_shared')),
      gateway.handleWebhookEvent(event(OTHER, 'evt_it_shared')),
    ]);
    expect([a.status, b.status]).toEqual(['ignored', 'ignored']);

    // Two deliveries of one event racing: one is processed, the other is a
    // duplicate, and neither throws.
    const outcomes = await Promise.allSettled([
      gateway.handleWebhookEvent(event(ORG, 'evt_it_race')),
      gateway.handleWebhookEvent(event(ORG, 'evt_it_race')),
    ]);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM webhook_events WHERE provider_event_id = 'evt_it_race'");
    expect(Number(n)).toBe(1);
    expect(outcomes.filter(o => o.value.status === 'duplicate')).toHaveLength(1);
  });

  test('BaseModel reads, updates and deletes stay inside the organization', async () => {
    const Client = require('../../../src/models/Client');
    const theirs = fx[OTHER].client;
    expect(await Client.findById(theirs, ORG)).toBeFalsy();
    await Client.update(theirs, { name: 'hijacked' }, ORG).catch(() => null);
    await Client.delete(theirs, ORG).catch(() => null);
    const [[row]] = await db.query('SELECT name, deleted_at FROM clients WHERE id = ?', [theirs]);
    expect(row).toEqual({ name: `Client ${OTHER}`, deleted_at: null });
    expect((await Client.findById(theirs, OTHER))?.id).toBe(theirs);
  });
});
