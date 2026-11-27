'use strict';
// =============================================================================
// Cash bags by zone, carrier and date — against a real database
// =============================================================================
// The cash bags page totals the bags waiting and on their way and filters its
// list by the zone of the point, the carrier and a date range. Zones live on
// the points, so the totals and the list reach them through a join that only
// real rows can prove.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9911; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6, 95xx menus, 9601 billing ahead, 97xx tie-out, 98xx clientless CFDI, 990x global by payment
const OTHER = 9912;

describeDb('cash bags by zone, carrier and date against a real database', () => {
  let db;
  let app;
  let request;
  let admin;
  let other;
  const ids = {};

  async function insert(table, row) {
    const cols = Object.keys(row);
    const [r] = await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => row[c]));
    return r.insertId;
  }
  const api = (method, path, body, token = admin.token) => {
    const call = request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    return body === undefined ? call : call.send(body);
  };
  const bag = (serial, row) => insert('cash_bags', { organization_id: ORG, serial, currency: 'MXN', created_by: admin.userId, ...row });
  const serials = (res) => res.body.data.map(b => b.serial).sort();

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    admin = await createOrgAdmin(db, ORG, 'BAGZONES');
    other = await createOrgAdmin(db, OTHER, 'BAGZONES2');
    app = require('../../../src/app');
    request = require('supertest');
    ids.north = await insert('resellers', { organization_id: ORG, name: 'North Store', status: 'active', kind: 'reseller' });
    ids.south = await insert('resellers', { organization_id: ORG, name: 'South Collector', status: 'active', kind: 'collector' });
    ids.loose = await insert('resellers', { organization_id: ORG, name: 'No Zone Store', status: 'active', kind: 'reseller' });
    const user = (name) => insert('users', {
      organization_id: ORG, first_name: name, last_name: 'Carrier', email: `${name.toLowerCase()}-${ORG}@example.com`,
      password_hash: 'not-a-login', role: 'support', status: 'active',
    });
    ids.carrierA = await user('Ana');
    ids.carrierB = await user('Beto');
    await bag('Z-READY-N', { status: 'ready_for_pickup', reseller_id: ids.north, carrier_user_id: ids.carrierA, declared_amount: '500.00', sealed_at: '2026-10-05 18:00:00' });
    await bag('Z-TRANSIT-N', { status: 'in_transit', reseller_id: ids.north, carrier_user_id: ids.carrierA, declared_amount: '300.00', sealed_at: '2026-10-10 18:00:00', picked_up_at: '2026-10-12 18:00:00' });
    await bag('Z-READY-S', { status: 'ready_for_pickup', reseller_id: ids.south, carrier_user_id: ids.carrierB, declared_amount: '200.00', sealed_at: '2026-10-20 18:00:00' });
    await bag('Z-READY-L', { status: 'ready_for_pickup', reseller_id: ids.loose, carrier_user_id: ids.carrierB, declared_amount: '50.00', sealed_at: '2026-10-21 18:00:00' });
    await bag('Z-DONE-N', { status: 'received', reseller_id: ids.north, carrier_user_id: ids.carrierA, declared_amount: '900.00', counted_amount: '900.00', sealed_at: '2026-09-28 18:00:00', received_at: '2026-10-02 18:00:00' });
    await bag('Z-EMPTY', { status: 'in_stock' });
  }, 120000);

  afterAll(teardown);

  test('zones are created, renamed, listed with their points, and a name cannot be used twice', async () => {
    const north = await api('post', '/point-zones', { name: 'North' });
    expect(north.status).toBe(201);
    ids.zoneNorth = north.body.data.id;
    ids.zoneSouth = (await api('post', '/point-zones', { name: 'Sur' })).body.data.id;
    expect((await api('post', '/point-zones', { name: 'North' })).body.error.code).toBe('ZONE_EXISTS');
    expect((await api('put', `/point-zones/${ids.zoneSouth}`, { name: 'South' })).body.data.name).toBe('South');

    expect((await api('put', `/point-zones/points/${ids.north}`, { zone_id: ids.zoneNorth })).status).toBe(200);
    expect((await api('put', `/point-zones/points/${ids.south}`, { zone_id: ids.zoneSouth })).status).toBe(200);
    const list = await api('get', '/point-zones');
    expect(list.body.data).toEqual([{ id: ids.zoneNorth, name: 'North', points: 1 }, { id: ids.zoneSouth, name: 'South', points: 1 }]);
    const points = await api('get', '/point-zones/points');
    expect(points.body.data.map(p => [p.name, p.kind, p.zone_id])).toEqual([
      ['No Zone Store', 'reseller', null], ['North Store', 'reseller', ids.zoneNorth], ['South Collector', 'collector', ids.zoneSouth],
    ]);
  });

  test('the dashboard totals the bags waiting and on their way, for all or for a zone or a carrier', async () => {
    const all = await api('get', '/cash-bags/dashboard');
    expect(all.status).toBe(200);
    expect(all.body.data).toEqual({ ready: { bags: 3, amount: 750 }, in_transit: { bags: 1, amount: 300 } });
    expect((await api('get', `/cash-bags/dashboard?zone_id=${ids.zoneNorth}`)).body.data).toEqual({ ready: { bags: 1, amount: 500 }, in_transit: { bags: 1, amount: 300 } });
    expect((await api('get', `/cash-bags/dashboard?zone_id=${ids.zoneSouth}`)).body.data).toEqual({ ready: { bags: 1, amount: 200 }, in_transit: { bags: 0, amount: 0 } });
    expect((await api('get', '/cash-bags/dashboard?zone_id=none')).body.data.ready).toEqual({ bags: 1, amount: 50 });
    expect((await api('get', `/cash-bags/dashboard?carrier_user_id=${ids.carrierB}`)).body.data).toEqual({ ready: { bags: 2, amount: 250 }, in_transit: { bags: 0, amount: 0 } });
    expect((await api('get', `/cash-bags/dashboard?carrier_user_id=${ids.carrierB}&zone_id=${ids.zoneSouth}`)).body.data.ready).toEqual({ bags: 1, amount: 200 });
    expect((await api('get', '/cash-bags/dashboard?zone_id=abc')).status).toBe(422);
  });

  test('the list filters by zone, carrier, status and a date range on the chosen date, and names the zone', async () => {
    const north = await api('get', `/cash-bags?zone_id=${ids.zoneNorth}&limit=50`);
    expect(serials(north)).toEqual(['Z-DONE-N', 'Z-READY-N', 'Z-TRANSIT-N']);
    expect(north.body.data.every(b => b.zone_name === 'North' && b.zone_id === ids.zoneNorth)).toBe(true);
    expect(serials(await api('get', '/cash-bags?zone_id=none&limit=50'))).toEqual(['Z-READY-L']);
    expect(serials(await api('get', `/cash-bags?zone_id=${ids.zoneNorth}&status=ready_for_pickup&limit=50`))).toEqual(['Z-READY-N']);
    // Sealed in October (the bag sealed in September is out, and so is the one never sealed).
    expect(serials(await api('get', '/cash-bags?date_from=2026-10-01&date_to=2026-10-31&limit=50'))).toEqual(['Z-READY-L', 'Z-READY-N', 'Z-READY-S', 'Z-TRANSIT-N']);
    // The same days on the received date find the September bag, received in October.
    expect(serials(await api('get', '/cash-bags?date_field=received&date_from=2026-10-01&date_to=2026-10-31&limit=50'))).toEqual(['Z-DONE-N']);
    expect(serials(await api('get', '/cash-bags?date_field=picked_up&date_from=2026-10-12&date_to=2026-10-12&limit=50'))).toEqual(['Z-TRANSIT-N']);
    expect((await api('get', '/cash-bags?date_from=10/01/2026')).status).toBe(422);
    expect((await api('get', '/cash-bags?date_field=created&date_from=2026-10-01')).status).toBe(422);
  });

  test('another organization sees and touches none of it', async () => {
    expect((await api('get', '/point-zones', undefined, other.token)).body.data).toEqual([]);
    expect((await api('get', '/cash-bags/dashboard', undefined, other.token)).body.data).toEqual({ ready: { bags: 0, amount: 0 }, in_transit: { bags: 0, amount: 0 } });
    expect((await api('put', `/point-zones/${ids.zoneNorth}`, { name: 'Taken' }, other.token)).status).toBe(404);
    expect((await api('put', `/point-zones/points/${ids.north}`, { zone_id: null }, other.token)).status).toBe(404);
    // A point cannot be put in another organization's zone.
    const theirs = (await api('post', '/point-zones', { name: 'Theirs' }, other.token)).body.data.id;
    expect((await api('put', `/point-zones/points/${ids.north}`, { zone_id: theirs })).status).toBe(404);
  });

  test('removing a zone leaves its points with none, and frees the name', async () => {
    expect((await api('delete', `/point-zones/${ids.zoneSouth}`)).status).toBe(200);
    const points = await api('get', '/point-zones/points');
    expect(points.body.data.find(p => p.id === ids.south).zone_id).toBeNull();
    expect((await api('get', '/cash-bags/dashboard?zone_id=none')).body.data.ready).toEqual({ bags: 2, amount: 250 });
    expect((await api('post', '/point-zones', { name: 'South' })).status).toBe(201);
  });
});
