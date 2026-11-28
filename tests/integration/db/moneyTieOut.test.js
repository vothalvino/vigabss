'use strict';
// =============================================================================
// Money tie-out — against a real database
// =============================================================================
// services/moneyTieOutService.js reads cash from five places (point ledgers,
// cash bags, cashier drawers, the safe, bank deposits) and claims that a
// month's cash adds up. Only real rows can show that it does: this walks cash
// through a cashier and through a point to the bank with the real cashier and
// payment routes, and checks that every peso is in one place and nothing is
// left unexplained.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9701; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6, 95xx menus, 9601 billing ahead

describeDb('the money tie-out against a real database', () => {
  let db;
  let app;
  let request;
  let admin;

  async function insert(table, row) {
    const cols = Object.keys(row);
    const [r] = await db.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => row[c]),
    );
    return r.insertId;
  }
  const api = (method, path, body) => {
    const call = request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${admin.token}`);
    return body === undefined ? call : call.send(body);
  };
  const tieOut = async () => {
    const res = await api('get', '/money-tieout');
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    admin = await createOrgAdmin(db, ORG, 'TIEOUT');
    app = require('../../../src/app');
    request = require('supertest');
  }, 120000);

  afterAll(teardown);

  test('before the safe is counted its cash is unknown, and nothing can be deposited', async () => {
    const report = await tieOut();
    expect(report.cash.tracked).toBe(false);
    expect(report.cash.in_transit_end.in_safe).toBeNull();
    expect(report.cash.differences).toBeNull();
    expect(report.attention.map(a => a.kind)).toContain('safe_not_counted');

    const account = await api('post', '/money-tieout/bank-accounts', { name: 'Early', purpose: 'any' });
    expect(account.status).toBe(201);
    const deposit = await api('post', '/money-tieout/safe-movements', { kind: 'deposit', amount: 10, bank_account_id: account.body.data.id });
    expect(deposit.status).toBe(422);
    expect(deposit.body.error.code).toBe('SAFE_NOT_COUNTED');
  });

  test('cash walks from a cashier and from a point to the bank, and the month adds up to the cent', async () => {
    // The safe is counted empty: tracking starts.
    const count = await api('post', '/money-tieout/safe-movements', { kind: 'count', amount: 0 });
    expect(count.status).toBe(201);
    const formal = (await api('post', '/money-tieout/bank-accounts', { name: 'Client invoices', bank_name: 'Bank A', account_hint: '1234', purpose: 'client_invoices' })).body.data;
    const publico = (await api('post', '/money-tieout/bank-accounts', { name: 'General Public', purpose: 'general_public' })).body.data;

    // A cashier opens with 500 in the drawer and takes 300 in cash.
    const opened = await api('post', '/cash-reconciliation/sessions', { opening_total: 500 });
    expect(opened.status).toBe(201);
    const session = opened.body.data.id;
    const client = await insert('clients', { organization_id: ORG, name: 'Tie-out Client', status: 'active' });
    const paid = await api('post', '/payments', { client_id: client, amount: 300, currency: 'MXN', payment_method: 'cash', payment_date: today() });
    expect(paid.status).toBe(201);
    // A supervisor takes 200 from the drawer (an admin's own pickup counts at once).
    const pickup = await api('post', `/cash-reconciliation/sessions/${session}/pickups`, { amount: 200 });
    expect(pickup.status).toBe(201);
    if (pickup.body.data.status !== 'confirmed') {
      expect((await api('post', `/cash-reconciliation/pickups/${pickup.body.data.id}/confirm`)).status).toBe(200);
    }

    // A point takes 1,000, keeps 50 of commission, seals 600 in a bag; the bag
    // is counted at 590, so the point owes the 10.
    const point = await insert('resellers', { organization_id: ORG, name: 'Tie-out Point', status: 'active' });
    const collection = await insert('payments', {
      organization_id: ORG, client_id: client, amount: '1000.00', currency: 'MXN', status: 'completed',
      payment_method: 'cash', payment_date: today(), reseller_id: point,
    });
    const ledger = (entry_type, amount, extra = {}) => insert('reseller_ledger_entries', {
      organization_id: ORG, reseller_id: point, entry_type, amount, currency: 'MXN', ...extra,
    });
    await ledger('collection', '1000.00', { payment_id: collection });
    await ledger('commission', '-50.00');
    const bag = await insert('cash_bags', {
      organization_id: ORG, serial: 'TIE-0001', status: 'received', reseller_id: point, currency: 'MXN',
      declared_amount: '600.00', counted_amount: '590.00', sealed_at: new Date(), received_at: new Date(), created_by: admin.userId,
    });
    await ledger('bag_sealed', '-600.00', { cash_bag_id: bag });
    await ledger('adjustment', '10.00', { cash_bag_id: bag, note: 'bag counted 10 short' });

    // The safe now holds the pickup and the bag: 790. More than that cannot leave it.
    const tooMuch = await api('post', '/money-tieout/safe-movements', { kind: 'deposit', amount: 5000, bank_account_id: publico.id });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('SAFE_INSUFFICIENT');
    const deposit = await api('post', '/money-tieout/safe-movements', { kind: 'deposit', amount: 700, bank_account_id: publico.id, reference: 'slip 1' });
    expect(deposit.status).toBe(201);
    expect(deposit.body.data.in_safe).toBe(90);

    // The cashier closes counting 590 where 600 was expected.
    const closed = await api('post', `/cash-reconciliation/sessions/${session}/close`, { counted_total: 590 });
    expect(closed.status).toBe(200);

    const report = await tieOut();
    expect(report.collected).toMatchObject({ total: 1300, cash: 1300, cash_staff: 300, cash_points: 1000, non_cash: 0 });
    // Nothing is invoiced, so all of it is credit that will end in a General Public invoice.
    expect(report.fiscal).toMatchObject({ client_cfdi: 0, credit: 1300, general_public: 1300 });
    expect(report.cash.tracked).toBe(true);
    // The first count was made this month, so the page says the month started untracked.
    expect(report.cash.started_in_month).toBe(true);
    expect(new Date(report.cash.tracking_since).getTime()).toBeLessThanOrEqual(Date.now());
    expect(report.cash.recorded).toBe(1300);
    expect(report.cash.in_transit_end).toMatchObject({ at_points: 360, owed_to_points: 0, in_bags: 0, in_drawers: 590, in_safe: 90, total: 1040 });
    expect(report.cash).toMatchObject({ deposited: 700, commissions_kept: 50, other_in: 0, other_out: 0 });
    expect(report.cash.reached_safe).toEqual({ pickups: 200, bags: 590, handed_in: 0 });
    // Every difference is one that was recorded: the opening float (+500), the
    // cashier's short count (-10), the short bag (-10) and what the point owes for it (+10).
    expect(report.cash.differences).toEqual({
      total: 490, cashier_counts: 490, bag_counts: -10, safe_counts: 0, point_adjustments: 10, point_payouts: 0, unexplained: 0,
    });
    expect(report.bank.deposited).toBe(700);
    expect(report.bank.accounts.find(a => a.id === publico.id)).toMatchObject({ deposits: 1, deposited: 700, purpose: 'general_public' });
    expect(report.bank.accounts.find(a => a.id === formal.id)).toMatchObject({ deposits: 0, deposited: 0 });

    // The identity, spelled out: what was recorded is in the bank, kept as
    // commission, or still on its way, give or take the recorded differences.
    const c = report.cash;
    const cents = (n) => Math.round(n * 100);
    expect(cents(c.recorded) + cents(c.differences.total))
      .toBe(cents(c.deposited) + cents(c.commissions_kept) + cents(c.other_out) - cents(c.other_in)
        + cents(c.in_transit_end.position) - cents(c.in_transit_start.position));
  });

  test('a recount of the safe records the difference, and a movement can be removed', async () => {
    const before = (await tieOut()).cash.in_transit_end.in_safe;
    const recount = await api('post', '/money-tieout/safe-movements', { kind: 'count', amount: before - 5, note: 'recount' });
    expect(recount.status).toBe(201);
    expect(recount.body.data.expected_amount).toBe(before);
    let report = await tieOut();
    expect(report.cash.in_transit_end.in_safe).toBe(before - 5);
    expect(report.cash.differences.safe_counts).toBe(-5);
    expect(report.cash.differences.unexplained).toBe(0);

    const list = await api('get', '/money-tieout/safe-movements');
    expect(list.body.data.map(m => m.kind)).toEqual(expect.arrayContaining(['count', 'deposit']));
    expect((await api('delete', `/money-tieout/safe-movements/${recount.body.data.id}`)).status).toBe(200);
    report = await tieOut();
    expect(report.cash.in_transit_end.in_safe).toBe(before);
    expect(report.cash.differences.unexplained).toBe(0);
  });

  test('a transfer names the bank account it reached; another organization\'s account is refused and cash never names one', async () => {
    const accounts = (await api('get', '/payments/bank-accounts')).body.data;
    const formal = accounts.find(a => a.purpose === 'client_invoices');
    expect(formal).toBeDefined();
    const [[client]] = await db.query('SELECT id FROM clients WHERE organization_id = ? LIMIT 1', [ORG]);
    const pay = (body) => api('post', '/payments', { client_id: client.id, currency: 'MXN', payment_date: today(), ...body });

    expect((await pay({ amount: 400, payment_method: 'transfer', bank_account_id: formal.id })).status).toBe(201);
    expect((await pay({ amount: 150, payment_method: 'card' })).status).toBe(201);
    // Cash goes to the drawer and reaches the bank as a deposit: the account is dropped.
    // (The cashier reopens with the 590 it was left with.)
    expect((await api('post', '/cash-reconciliation/sessions', { opening_total: 590 })).status).toBe(201);
    const cash = await pay({ amount: 20, payment_method: 'cash', bank_account_id: formal.id });
    expect(cash.status).toBe(201);
    const [[stored]] = await db.query('SELECT bank_account_id FROM payments WHERE id = ?', [cash.body.data.id]);
    expect(stored.bank_account_id).toBeNull();

    const other = await createOrgAdmin(db, ORG + 2, 'TIEOUT3');
    const foreign = await request(app).post('/api/v1/money-tieout/bank-accounts').set('Authorization', `Bearer ${other.token}`).send({ name: 'Theirs' });
    expect(foreign.status).toBe(201);
    const refused = await pay({ amount: 5, payment_method: 'transfer', bank_account_id: foreign.body.data.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('BANK_ACCOUNT_INVALID');

    const report = await tieOut();
    expect(report.collected.non_cash).toBe(550);
    expect(report.bank.accounts.find(a => a.id === formal.id)).toMatchObject({ payments: 1, received: 400 });
    expect(report.bank.direct_unassigned).toBe(150);
    expect(report.bank.in_client_invoice_accounts).toBe(400);
    expect(report.bank.in_general_public_accounts).toBe(700);
    // The 20 in cash is in the reopened drawer, so the month still adds up.
    expect(report.cash.in_transit_end.in_drawers).toBe(610);
    expect(report.cash.differences.unexplained).toBe(0);
  });

  test('a cash limit set for one person stops that person at it when strict, and clearing it goes back to the company\'s', async () => {
    const [[client]] = await db.query('SELECT id FROM clients WHERE organization_id = ? LIMIT 1', [ORG]);
    const cash = () => api('post', '/payments', { client_id: client.id, amount: 5, currency: 'MXN', payment_method: 'cash', payment_date: today() });
    const limit = (body) => api('put', `/cash-reconciliation/staff/${admin.userId}/limit`, body);
    // The admin's cashier is open with about 610 in it; the company has no limit.
    expect((await cash()).status).toBe(201);

    const strict = await limit({ pickup_threshold: 100, pickup_strict: true });
    expect(strict.status).toBe(200);
    expect(strict.body.data).toEqual({ pickup_threshold: 100, pickup_strict: true, own: true });
    const refused = await cash();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CASHIER_OVER_LIMIT');
    const line = (await api('get', '/cash-reconciliation/staff')).body.data.find(p => p.user_id === admin.userId);
    expect(line).toMatchObject({ reasons: expect.arrayContaining(['over_limit']), limit: { pickup_threshold: 100, pickup_strict: true, own: true } });

    // Not strict: reminded, not stopped.
    expect((await limit({ pickup_threshold: 100, pickup_strict: false })).body.data.pickup_strict).toBe(false);
    expect((await cash()).status).toBe(201);
    // 0 is no limit for this person.
    expect((await limit({ pickup_threshold: 0, pickup_strict: true })).body.data).toEqual({ pickup_threshold: 0, pickup_strict: false, own: true });
    expect((await limit({ pickup_threshold: -5 })).status).toBe(422);

    const cleared = await api('delete', `/cash-reconciliation/staff/${admin.userId}/limit`);
    expect(cleared.body.data).toEqual({ pickup_threshold: 0, pickup_strict: false, own: false });
    // Someone with no cashier in this organization has no limit to set.
    expect((await limit({ pickup_threshold: 100 })).status).toBe(200);
    expect((await api('put', '/cash-reconciliation/staff/999999/limit', { pickup_threshold: 100 })).status).toBe(404);
    await api('delete', `/cash-reconciliation/staff/${admin.userId}/limit`);
  });

  test('the Cashier page lists staff, never the login of a reseller or collector', async () => {
    const [[point]] = await db.query('SELECT id FROM resellers WHERE organization_id = ? LIMIT 1', [ORG]);
    const login = await insert('users', {
      organization_id: ORG, first_name: 'Point', last_name: 'Login', email: `point-${ORG}@example.com`,
      password_hash: 'not-a-login', role: 'billing', status: 'active',
    });
    await insert('reseller_user_bindings', { organization_id: ORG, user_id: login, reseller_id: point.id });
    // A cashier that login closed before points stopped having one.
    await insert('cash_reconciliation_sessions', {
      organization_id: ORG, agent_user_id: login, status: 'approved', opened_at: '2026-10-01 15:00:00',
      closed_at: '2026-10-01 23:00:00', expected_total: '20.00', counted_total: '20.00', variance: '0.00',
    });
    const list = await api('get', '/cash-reconciliation/staff');
    expect(list.status).toBe(200);
    expect(list.body.data.map(p => p.user_id)).toEqual([admin.userId]);
    expect((await api('get', `/cash-reconciliation/staff/${login}`)).status).toBe(404);
    expect((await api('get', `/cash-reconciliation/staff/${admin.userId}`)).status).toBe(200);
  });

  test('another organization sees none of it', async () => {
    const other = await createOrgAdmin(db, ORG + 1, 'TIEOUT2');
    const res = await request(app).get('/api/v1/money-tieout').set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.collected.total).toBe(0);
    expect(res.body.data.bank.accounts).toEqual([]);
    const accounts = await request(app).get('/api/v1/money-tieout/bank-accounts').set('Authorization', `Bearer ${other.token}`);
    expect(accounts.body.data).toEqual([]);
  });
});
