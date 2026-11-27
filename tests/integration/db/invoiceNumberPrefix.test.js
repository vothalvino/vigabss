'use strict';
// =============================================================================
// The prefix of invoice numbers — against a real database
// =============================================================================
// The prefix is read from the organization and its invoice settings on the
// same connection that advances the counter. That it follows the
// organization's country, the saved setting, and never disturbs the running
// number or another organization can only be seen with real rows.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const MX = 9921; // …, 990x global by payment, 991x cash bag zones
const GLOBAL = 9922;

describeDb('the prefix of invoice numbers against a real database', () => {
  let db;
  let app;
  let request;
  let mx;
  let global;
  let billingService;

  async function next(org) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const number = await billingService.nextInvoiceNumber(conn, org);
      await conn.commit();
      return number;
    } finally { conn.release(); }
  }
  const settings = (method, admin, body) => {
    const call = request(app)[method]('/api/v1/invoice-settings').set('Authorization', `Bearer ${admin.token}`);
    return body === undefined ? call : call.send(body);
  };

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    mx = await createOrgAdmin(db, MX, 'PREFIXMX');
    global = await createOrgAdmin(db, GLOBAL, 'PREFIXGL');
    await db.query("UPDATE organizations SET locale = 'MX', country = 'MX' WHERE id = ?", [MX]);
    billingService = require('../../../src/services/billingService');
    app = require('../../../src/app');
    request = require('supertest');
  }, 120000);

  afterAll(teardown);

  test('with nothing chosen a Mexican organization numbers REM- and any other INV-', async () => {
    expect(await next(MX)).toBe('REM-000001');
    expect(await next(GLOBAL)).toBe('INV-000001');
    const shown = await settings('get', mx);
    expect(shown.body).toMatchObject({ number_prefix: null, default_number_prefix: 'REM', effective_number_prefix: 'REM' });
    expect((await settings('get', global)).body).toMatchObject({ default_number_prefix: 'INV', effective_number_prefix: 'INV' });
  });

  test('a chosen prefix is used from the next invoice on, and the number keeps running', async () => {
    const saved = await settings('put', mx, { header_color: '#123456', number_prefix: 'nota-' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ number_prefix: 'NOTA', effective_number_prefix: 'NOTA', header_color: '#123456' });
    expect(await next(MX)).toBe('NOTA-000002');
    // The other organization is not touched.
    expect(await next(GLOBAL)).toBe('INV-000002');
  });

  test('saving other settings without the prefix keeps it; an empty prefix goes back to the default', async () => {
    expect((await settings('put', mx, { header_color: '#654321' })).body.number_prefix).toBe('NOTA');
    expect(await next(MX)).toBe('NOTA-000003');
    expect((await settings('put', mx, { header_color: '#654321', number_prefix: '' })).body).toMatchObject({ number_prefix: null, effective_number_prefix: 'REM' });
    expect(await next(MX)).toBe('REM-000004');
  });

  test('a prefix with a space or too long is refused and nothing changes', async () => {
    expect((await settings('put', mx, { number_prefix: 'A B' })).status).toBe(422);
    expect((await settings('put', mx, { number_prefix: 'TOO-LONG-PREFIX' })).status).toBe(422);
    expect((await settings('get', mx)).body.effective_number_prefix).toBe('REM');
  });
});
