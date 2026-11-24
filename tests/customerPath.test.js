// A customer's path through the network, hop by hop, and where a fault is.
jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/linkHealthService', () => {
  const real = jest.requireActual('../src/services/linkHealthService');
  return { ...real, assess: jest.fn(), getLimits: jest.fn(async () => real.DEFAULT_LIMITS) };
});

const db = require('../src/config/database');
const linkHealth = require('../src/services/linkHealthService');
const path = require('../src/services/customerPathService');

const good = { state: 'good', reasons: [] };
const unknown = { state: 'unknown', reasons: [] };

/** A small network: 40 sector → 30 PtP → 20 router (main NAS). 50 OLT → 20. */
function world({ contract = {}, customer, session, onu, reading, metrics = [], nodes = {} } = {}) {
  linkHealth.assess.mockResolvedValue({ nodes });
  db.query.mockImplementation(async (sql) => {
    const flat = sql.replace(/\s+/g, ' ');
    if (/FROM contracts c/.test(flat)) {
      return [[{ id: 9, client_id: 3, status: 'active', access_technology: 'wisp', plan_technology: 'wisp', wireless_signal_min_dbm: null, optical_min_dbm: null, plan_name: 'Hogar 50', download_speed_mbps: 50, upload_speed_mbps: 10, ...contract }]];
    }
    if (/FROM devices d LEFT JOIN cpe_devices/.test(flat)) return [customer === undefined ? [{ id: 70, name: 'CPE Ana', type: 'outdoor_cpe', status: 'online', parent_device_id: null }] : customer];
    if (/FROM wireless_client_sessions/.test(flat)) return [session === undefined ? [{ device_id: 40, signal_dbm: -60, snr_db: 30, ccq_pct: 95 }] : session];
    if (/FROM olt_onus/.test(flat)) return [onu || []];
    if (/FROM olt_onu_readings/.test(flat)) return [reading || []];
    if (/FROM snmp_metrics m/.test(flat)) return [metrics];
    if (/FROM devices d LEFT JOIN nas n/.test(flat)) {
      return [[
        { id: 40, name: 'Sector Norte', type: 'ptmp_ap', parent_device_id: 30, nas_id: null, is_main: null },
        { id: 30, name: 'PtP Cerro', type: 'ptp', parent_device_id: 20, nas_id: null, is_main: null },
        { id: 20, name: 'Core', type: 'router', parent_device_id: null, nas_id: 1, is_main: 1 },
        { id: 50, name: 'OLT 1', type: 'olt', parent_device_id: 20, nas_id: null, is_main: null },
      ]];
    }
    return [[]];
  });
}
const allGood = { 40: { equipment: good, uplink: good }, 30: { equipment: good, uplink: good }, 20: { equipment: good, uplink: null }, 50: { equipment: good, uplink: good } };

beforeEach(() => { db.query.mockReset(); linkHealth.assess.mockReset(); });

describe('WISP: customer radio → sector → links → main NAS', () => {
  test('every hop in order, and nothing wrong', async () => {
    world({ nodes: allGood });
    const out = await path.pathForContract(5, 9);
    expect(out.technology).toBe('wisp');
    expect(out.hops.map((h) => [h.role, h.name])).toEqual([['customer', 'CPE Ana'], ['access', 'Sector Norte'], ['network', 'PtP Cerro'], ['network', 'Core']]);
    expect(out.reaches_main_nas).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.conclusion).toEqual({ side: 'none', state: 'good' });
    expect(out.gaps).toEqual([]);
  });

  test('a saturated backhaul link is our backhaul, and names the hop', async () => {
    const reasons = [{ code: 'capacity_live', value: 93, limit: 85, mbps: 112, capacity_mbps: 120 }];
    world({ nodes: { ...allGood, 30: { equipment: good, uplink: { state: 'degraded', reasons } } } });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'backhaul', state: 'degraded' });
    expect(out.findings).toEqual([{ side: 'backhaul', state: 'degraded', part: 'line', device_id: 30, name: 'PtP Cerro', reasons }]);
  });

  test('a saturated sector is our access, with who carries the most', async () => {
    const top = [{ device_id: 72, name: 'CPE Luis', mbps: 60 }];
    world({ nodes: { ...allGood, 40: { equipment: { state: 'degraded', reasons: [{ code: 'airtime', value: 91, limit: 80 }], top_clients: top }, uplink: good } } });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion.side).toBe('access');
    expect(out.findings[0]).toMatchObject({ side: 'access', part: 'equipment', device_id: 40, top_clients: top });
  });

  test('a weak signal with a healthy network is the link between the customer and us', async () => {
    world({ nodes: allGood, session: [{ device_id: 40, signal_dbm: -82, snr_db: 12, ccq_pct: 90 }] });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'customer_link', state: 'degraded' });
    expect(out.findings[0].reasons).toEqual([{ code: 'signal', value: -82, limit: -75 }, { code: 'snr', value: 12, limit: 20 }]);
  });

  test('the contract\'s own signal floor is used when it has one', async () => {
    world({ nodes: allGood, contract: { wireless_signal_min_dbm: -65 }, session: [{ device_id: 40, signal_dbm: -70, snr_db: 30, ccq_pct: 95 }] });
    expect((await path.pathForContract(5, 9)).findings[0].reasons).toEqual([{ code: 'signal', value: -70, limit: -65 }]);
  });

  test('the customer\'s router at high CPU is the customer\'s equipment', async () => {
    world({ nodes: allGood, metrics: [{ device_id: 70, interface_id: null, ts: 1300, cpu_usage: 99 }] });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'customer_equipment', state: 'degraded' });
    expect(out.findings[0]).toMatchObject({ device_id: 70, reasons: [{ code: 'cpu', value: 99, limit: 85 }] });
  });

  test('using all of the plan is the plan, not a fault of ours', async () => {
    world({ nodes: allGood, metrics: [
      { device_id: 70, interface_id: '1', ts: 1300, if_in_octets: 1800000000, if_out_octets: 0 },
      { device_id: 70, interface_id: '1', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
    ] });
    const out = await path.pathForContract(5, 9);
    expect(out.saturation).toEqual({ mbps: 48, plan_mbps: 50, pct: 96, full: true });
    expect(out.conclusion).toEqual({ side: 'customer_plan', state: 'degraded' });
    expect(out.findings[0].reasons).toEqual([{ code: 'plan_full', value: 96, limit: 90, mbps: 48, plan_mbps: 50 }]);
  });

  test('a network fault outranks a full plan; an outage outranks a slowdown', async () => {
    world({
      nodes: { ...allGood, 30: { equipment: good, uplink: { state: 'degraded', reasons: [{ code: 'airtime', value: 90, limit: 80 }] } }, 40: { equipment: { state: 'off', reasons: [{ code: 'offline' }] }, uplink: good } },
      metrics: [{ device_id: 70, interface_id: '1', ts: 1300, if_in_octets: 1800000000, if_out_octets: 0 }, { device_id: 70, interface_id: '1', ts: 1000, if_in_octets: 0, if_out_octets: 0 }],
    });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'access', state: 'off' });
    expect(out.findings.map((f) => f.side).sort()).toEqual(['access', 'backhaul', 'customer_plan']);
  });
});

describe('FTTH: ONU → OLT → main NAS', () => {
  const ftth = { contract: { access_technology: 'ftth' }, customer: [{ id: 80, name: 'ONU Ana', type: 'onu', status: 'online', parent_device_id: null }], onu: [{ olt_device_id: 50, port: '0/1/3', ont_id: 7, serial_number: 'X', active: 1 }] };

  test('walks from the OLT up, and reads the fibre drop from the OLT', async () => {
    world({ ...ftth, nodes: allGood, reading: [{ state: 'online', rx_power_dbm: -19.5, distance_m: 2100, ts: 1 }] });
    const out = await path.pathForContract(5, 9);
    expect(out.technology).toBe('ftth');
    expect(out.hops.map((h) => [h.role, h.name])).toEqual([['customer', 'ONU Ana'], ['access', 'OLT 1'], ['network', 'Core']]);
    expect(out.hops[0].detail).toEqual({ port: '0/1/3', ont_id: 7, rx_power_dbm: -19.5, distance_m: 2100 });
    expect(out.conclusion).toEqual({ side: 'none', state: 'good' });
    const readingCall = db.query.mock.calls.find(([sql]) => /FROM olt_onu_readings/.test(sql));
    expect(readingCall[1]).toEqual([5, 50, '0/1/3', 7]);
  });

  test('an ONU the OLT sees offline is the customer link, with the OLT\'s cause', async () => {
    world({ ...ftth, nodes: allGood, reading: [{ state: 'offline', last_down_cause: 'LOS', rx_power_dbm: null }] });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'customer_link', state: 'off' });
    expect(out.findings[0].reasons).toEqual([{ code: 'onu_offline', cause: 'LOS' }]);
  });

  test('weak light at the ONU is degraded', async () => {
    world({ ...ftth, nodes: allGood, reading: [{ state: 'online', rx_power_dbm: -28.4 }] });
    expect((await path.pathForContract(5, 9)).findings[0].reasons).toEqual([{ code: 'optical_weak', value: -28.4, limit: -27 }]);
  });

  test('an ONU not registered on any OLT is a gap, not a guess', async () => {
    world({ ...ftth, onu: [], nodes: allGood });
    const out = await path.pathForContract(5, 9);
    expect(out.gaps).toEqual(expect.arrayContaining(['onu_not_registered', 'access_equipment_unknown']));
    expect(out.hops).toHaveLength(1);
    expect(out.conclusion.side).toBe('unknown');
  });
});

describe('what cannot be checked is said', () => {
  test('unpolled hops are gaps and the conclusion is unknown, never "all good"', async () => {
    world({ nodes: {}, session: [{ device_id: 40, signal_dbm: null, snr_db: null, ccq_pct: null }] });
    const out = await path.pathForContract(5, 9);
    expect(out.conclusion).toEqual({ side: 'unknown', state: 'unknown' });
    expect(out.gaps).toEqual(['not_measured:40', 'not_measured:30', 'not_measured:20']);
    expect(out.hops[1].equipment).toEqual(unknown);
  });

  test('a path that does not reach a main NAS says so', async () => {
    world({ nodes: allGood });
    linkHealth.assess.mockResolvedValue({ nodes: allGood });
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM devices d\s+LEFT JOIN nas n/.test(sql)) return [[{ id: 40, name: 'Sector Norte', type: 'ptmp_ap', parent_device_id: null, nas_id: null, is_main: null }]];
      return original(sql, params);
    });
    const out = await path.pathForContract(5, 9);
    expect(out.reaches_main_nas).toBe(false);
    expect(out.gaps).toContain('path_stops_before_main_nas');
  });

  test('a customer with no known equipment and not seen on a sector', async () => {
    world({ customer: [], session: [] });
    const out = await path.pathForContract(5, 9);
    expect(out.gaps).toEqual(['no_customer_equipment']);
    expect(out.hops).toHaveLength(1);
    expect(linkHealth.assess).not.toHaveBeenCalled();
  });

  test('a loop in the tree ends the walk', async () => {
    world({ nodes: allGood });
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM devices d\s+LEFT JOIN nas n/.test(sql)) return [[{ id: 40, name: 'A', type: 'ptmp_ap', parent_device_id: 30 }, { id: 30, name: 'B', type: 'ptp', parent_device_id: 40 }]];
      return original(sql, params);
    });
    const out = await path.pathForContract(5, 9);
    expect(out.hops.map((h) => h.name)).toEqual(['CPE Ana', 'A', 'B']);
  });
});

describe('scoping', () => {
  test('another organization\'s contract is not found', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(path.pathForContract(5, 9)).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query.mock.calls[0][1]).toEqual([9, 5]);
  });

  test('every lookup carries the organization', async () => {
    world({ nodes: allGood });
    await path.pathForContract(5, 9);
    for (const [sql, params] of db.query.mock.calls) {
      if (/snmp_metrics/.test(sql)) continue; // keyed by a device already checked against the organization
      expect([sql.replace(/\s+/g, ' ').slice(0, 60), params.includes(5)]).toEqual([expect.any(String), true]);
    }
  });
});
