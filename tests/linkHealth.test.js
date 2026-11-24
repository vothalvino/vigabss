// Each line of the network tree, and each piece of equipment, is judged good,
// degraded, off or unknown from polled measurements, with the reason.
jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const health = require('../src/services/linkHealthService');

const L = health.DEFAULT_LIMITS;
const dev = (extra = {}) => ({ type: 'switch', status: 'online', has_parent: true, uplink_interface: '3', uplink_capacity_mbps: 1000, ...extra });
const read = (extra = {}) => ({ device: null, uplink: null, rate_bps: null, errors_per_min: null, optical_normal_dbm: null, radio_capacity_mbps: null, radio_rate_bps: null, ...extra });

beforeEach(() => { db.query.mockReset(); });

describe('judge: the line to the parent', () => {
  test('nothing measured is unknown, never good', () => {
    expect(health.judge(dev(), read()).uplink).toEqual({ state: 'unknown', reasons: [] });
  });

  test('off when the equipment is offline or the port facing the parent is down', () => {
    expect(health.judge(dev({ status: 'offline' }), read()).uplink).toEqual({ state: 'off', reasons: [{ code: 'offline' }] });
    expect(health.judge(dev(), read({ uplink: { if_oper_status: 2 } })).uplink).toEqual({ state: 'off', reasons: [{ code: 'port_down' }] });
    expect(health.judge(dev(), read({ uplink: { if_oper_status: 1 } })).uplink.state).toBe('good');
  });

  test('a point-to-point radio is degraded by airtime, low SNR or low CCQ', () => {
    const ptp = dev({ type: 'ptp', uplink_interface: null, uplink_capacity_mbps: null });
    expect(health.judge(ptp, read({ device: { air_util_pct: 87, snr_db: 30, ccq_pct: 95 } })).uplink)
      .toEqual({ state: 'degraded', reasons: [{ code: 'airtime', value: 87, limit: L.airtime_pct }] });
    expect(health.judge(ptp, read({ device: { air_util_pct: 40, snr_db: 14, ccq_pct: 70 } })).uplink.reasons.map((r) => r.code)).toEqual(['snr', 'ccq']);
    expect(health.judge(ptp, read({ device: { air_util_pct: 40, snr_db: 30, ccq_pct: 95 } })).uplink).toEqual({ state: 'good', reasons: [] });
  });

  test('a radio without airtime figures is caught by traffic against capacity', () => {
    const ptp = dev({ type: 'ptp', uplink_capacity_mbps: 100 });
    const out = health.judge(ptp, read({ rate_bps: 92e6 })).uplink;
    expect(out).toEqual({ state: 'degraded', reasons: [{ code: 'capacity', value: 92, limit: L.capacity_pct }] });
    expect(health.judge(ptp, read({ rate_bps: 50e6 })).uplink.state).toBe('good');
    // Without a capacity, traffic alone says nothing.
    expect(health.judge(dev({ type: 'ptp', uplink_capacity_mbps: null }), read({ rate_bps: 92e6 })).uplink.state).toBe('unknown');
  });

  test('fibre: a sudden drop against its own normal is degraded even though traffic passes', () => {
    const out = health.judge(dev(), read({ uplink: { if_oper_status: 1, sfp_rx_power_dbm: -18.4 }, optical_normal_dbm: -14.2, rate_bps: 100e6 })).uplink;
    expect(out.state).toBe('degraded');
    expect(out.reasons).toEqual([{ code: 'optical_drop', value: -18.4, normal: -14.2, drop: 4.2, limit: L.optical_drop_db }]);
    // A small wobble is not a drop.
    expect(health.judge(dev(), read({ uplink: { sfp_rx_power_dbm: -15.1 }, optical_normal_dbm: -14.2 })).uplink.state).toBe('good');
  });

  test('fibre: a level near the floor is weak even with no history to compare', () => {
    expect(health.judge(dev(), read({ uplink: { sfp_rx_power_dbm: -28.3 } })).uplink)
      .toEqual({ state: 'degraded', reasons: [{ code: 'optical_weak', value: -28.3, limit: L.optical_floor_dbm }] });
  });

  test('errors climbing on the port degrade any line', () => {
    expect(health.judge(dev(), read({ errors_per_min: 240 })).uplink.reasons).toEqual([{ code: 'errors', value: 240, limit: L.errors_per_min }]);
  });

  test('equipment at the top of a tree has no line', () => {
    expect(health.judge(dev({ has_parent: false }), read({ device: { cpu_usage: 10 } })).uplink).toBeNull();
  });

  test('limits can be changed', () => {
    const ptp = dev({ type: 'ptp' });
    expect(health.judge(ptp, read({ device: { air_util_pct: 70 } }), { ...L, airtime_pct: 60 }).uplink.state).toBe('degraded');
  });
});

describe('radios: traffic against what the radio can carry right now', () => {
  const ptp = dev({ type: 'ptp', uplink_interface: null, uplink_capacity_mbps: 300 });

  test('the live rate the radio reports is used, not the capacity typed by hand', () => {
    // Rain: the radio fell to 120 Mbps and carries 110. Against the typed 300 it would look fine.
    const out = health.judge(ptp, read({ radio_capacity_mbps: 120, radio_rate_bps: 110e6, rate_bps: 110e6 })).uplink;
    expect(out).toEqual({ state: 'degraded', reasons: [{ code: 'capacity_live', value: 91.7, limit: L.capacity_pct, mbps: 110, capacity_mbps: 120 }] });
    expect(health.judge(ptp, read({ radio_capacity_mbps: 280, radio_rate_bps: 110e6 })).uplink).toEqual({ state: 'good', reasons: [] });
  });

  test('a saturated sector is judged the same way, as the sector\'s own problem', () => {
    const out = health.judge(dev({ type: 'ptmp_ap', uplink_interface: null, uplink_capacity_mbps: null }), read({ radio_capacity_mbps: 90, radio_rate_bps: 85e6 }));
    expect(out.equipment.reasons).toEqual([{ code: 'capacity_live', value: 94.4, limit: L.capacity_pct, mbps: 85, capacity_mbps: 90 }]);
    expect(out.uplink.state).toBe('unknown');
  });

  test('readings: capacity is the lower reported rate; traffic is that interface\'s', () => {
    const rows = [
      { interface_id: '5', ts: 1300, tx_rate_mbps: 144, rx_rate_mbps: 130, if_in_octets: 3000000000, if_out_octets: 100 },
      { interface_id: '2', ts: 1300, if_in_octets: 10, if_out_octets: 10 },
      { interface_id: '5', ts: 1000, tx_rate_mbps: 144, rx_rate_mbps: 130, if_in_octets: 0, if_out_octets: 0 },
      { interface_id: '2', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
    ];
    const out = health.readingsFor(rows, null, 'ptp');
    expect(out.radio_capacity_mbps).toBe(130);
    expect(out.radio_rate_bps).toBe(80e6);
    // Not a radio: its rates are not read as a capacity.
    expect(health.readingsFor(rows, null, 'switch').radio_capacity_mbps).toBeNull();
  });

  test('readings: rates on a device-wide row use the busiest interface for traffic', () => {
    const rows = [
      { interface_id: null, ts: 1300, tx_rate_mbps: 100, rx_rate_mbps: 0 },
      { interface_id: '1', ts: 1300, if_in_octets: 1500000000, if_out_octets: 0 },
      { interface_id: '2', ts: 1300, if_in_octets: 300, if_out_octets: 0 },
      { interface_id: '1', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
      { interface_id: '2', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
    ];
    const out = health.readingsFor(rows, null, 'ptmp_ap');
    expect(out.radio_capacity_mbps).toBe(100);
    expect(out.radio_rate_bps).toBe(40e6);
  });
});

describe('a saturated sector names the subscriber radios carrying the most', () => {
  test('ranked by traffic, limited to this organization and to radios seen on that sector', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [[{ id: 30, type: 'ptmp_ap', status: 'online', parent_device_id: 10, uplink_interface: null, uplink_capacity_mbps: null }]];
      if (/FROM wireless_client_sessions/.test(sql)) return [[{ sector_id: 30, client_device_id: 71, name: 'CPE Ana' }, { sector_id: 30, client_device_id: 72, name: 'CPE Luis' }, { sector_id: 30, client_device_id: 73, name: 'CPE unpolled' }]];
      if (/m\.device_id IN \(\?, \?, \?\)/.test(sql)) {
        return [[
          { device_id: 71, interface_id: '1', ts: 1300, if_in_octets: 750000000, if_out_octets: 0 }, { device_id: 71, interface_id: '1', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
          { device_id: 72, interface_id: '1', ts: 1300, if_in_octets: 2250000000, if_out_octets: 0 }, { device_id: 72, interface_id: '1', ts: 1000, if_in_octets: 0, if_out_octets: 0 },
        ]];
      }
      if (/FROM snmp_metrics m/.test(sql)) return [[{ device_id: 30, interface_id: null, ts: 1300, air_util_pct: 93 }]];
      return [[]];
    });
    const out = await health.assess(5);
    expect(out.nodes[30].equipment.top_clients).toEqual([{ device_id: 72, name: 'CPE Luis', mbps: 60 }, { device_id: 71, name: 'CPE Ana', mbps: 20 }]);
    const sessions = db.query.mock.calls.find(([sql]) => /FROM wireless_client_sessions/.test(sql));
    expect(sessions[0]).toMatch(/c\.organization_id = \? AND c\.deleted_at IS NULL/);
    expect(sessions[1]).toEqual([5, 5, 30]);
  });

  test('a sector that is not saturated is not looked up', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [[{ id: 30, type: 'ptmp_ap', status: 'online', parent_device_id: 10, uplink_interface: null, uplink_capacity_mbps: null }]];
      if (/FROM snmp_metrics m/.test(sql)) return [[{ device_id: 30, interface_id: null, ts: 1300, air_util_pct: 30 }]];
      return [[]];
    });
    await health.assess(5);
    expect(db.query.mock.calls.some(([sql]) => /wireless_client_sessions/.test(sql))).toBe(false);
  });
});

describe('judge: the equipment itself', () => {
  test('CPU, memory, heat and a low battery', () => {
    const out = health.judge(dev(), read({ device: { cpu_usage: 97, memory_usage: 50, temperature_c: 81.5, ups_battery_pct: 12 } })).equipment;
    expect(out.state).toBe('degraded');
    expect(out.reasons).toEqual([
      { code: 'cpu', value: 97, limit: L.cpu_pct }, { code: 'temperature', value: 81.5, limit: L.temperature_c }, { code: 'battery', value: 12, limit: L.battery_pct },
    ]);
  });

  test('a saturated sector is the sector\'s problem, not its feed\'s', () => {
    const out = health.judge(dev({ type: 'ptmp_ap', uplink_interface: null }), read({ device: { air_util_pct: 91 } }));
    expect(out.equipment).toEqual({ state: 'degraded', reasons: [{ code: 'airtime', value: 91, limit: L.airtime_pct }] });
    expect(out.uplink.state).toBe('unknown');
  });

  test('offline is off; unpolled is unknown; measured and within limits is good', () => {
    expect(health.judge(dev({ status: 'offline' }), read()).equipment).toEqual({ state: 'off', reasons: [{ code: 'offline' }] });
    expect(health.judge(dev(), read()).equipment.state).toBe('unknown');
    expect(health.judge(dev(), read({ device: { cpu_usage: 20 } })).equipment.state).toBe('good');
  });
});

describe('readingsFor', () => {
  const row = (iface, ts, extra = {}) => ({ interface_id: iface, ts, ...extra });

  test('traffic and errors come from the two newest polls of the uplink port only', () => {
    const rows = [
      row('3', 1300, { if_in_octets: 4000000, if_out_octets: 1000000, if_in_errors: 30, if_out_errors: 0, if_oper_status: 1 }),
      row('7', 1300, { if_in_octets: 9e12, if_out_octets: 9e12 }),
      row('3', 1000, { if_in_octets: 1000000, if_out_octets: 400000, if_in_errors: 0, if_out_errors: 0 }),
    ];
    const out = health.readingsFor(rows, '3');
    expect(out.rate_bps).toBe((3000000 * 8) / 300);
    expect(out.errors_per_min).toBe(6);
    expect(out.uplink).toEqual({ if_oper_status: 1 });
  });

  test('a counter that went backwards gives no figure', () => {
    const rows = [row('3', 1300, { if_in_octets: 10, if_out_octets: 10 }), row('3', 1000, { if_in_octets: 5000, if_out_octets: 5000 })];
    expect(health.readingsFor(rows, '3').rate_bps).toBeNull();
  });

  test('device-wide values are the newest that are not empty; radio figures may sit on an interface', () => {
    const rows = [row(null, 1300, { cpu_usage: null, memory_usage: 40 }), row('1', 1290, { air_util_pct: 66 }), row(null, 1000, { cpu_usage: 12 })];
    expect(health.readingsFor(rows, null).device).toEqual({ cpu_usage: 12, memory_usage: 40, air_util_pct: 66 });
  });

  test('no rows, no readings', () => {
    expect(health.readingsFor([], '3')).toEqual({ device: null, uplink: null, rate_bps: null, errors_per_min: null, optical_normal_dbm: null, radio_capacity_mbps: null, radio_rate_bps: null });
  });
});

describe('assess', () => {
  test('judges every piece of network equipment of the organization, with the optical normal from history', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) {
        return [[
          { id: 10, type: 'router', status: 'online', parent_device_id: null, uplink_interface: null, uplink_capacity_mbps: null },
          { id: 11, type: 'switch', status: 'online', parent_device_id: 10, uplink_interface: '3', uplink_capacity_mbps: 1000 },
          { id: 12, type: 'ptp', status: 'offline', parent_device_id: 11, uplink_interface: null, uplink_capacity_mbps: null },
        ]];
      }
      if (/FROM organization_settings/.test(sql)) return [[{ setting_value: JSON.stringify({ optical_drop_db: 2 }) }]];
      if (/FROM snmp_metrics m/.test(sql)) {
        return [[
          { device_id: 10, interface_id: null, ts: 1300, cpu_usage: 22 },
          { device_id: 11, interface_id: '3', ts: 1300, sfp_rx_power_dbm: -17, if_oper_status: 1 },
        ]];
      }
      if (/FROM snmp_metrics_1hr/.test(sql)) {
        return [[
          ...Array.from({ length: 24 }, () => ({ device_id: 11, interface_id: '3', avg_sfp_rx_power_dbm: -14 })),
          { device_id: 11, interface_id: '9', avg_sfp_rx_power_dbm: -30 },
        ]];
      }
      return [[]];
    });
    const out = await health.assess(5);
    expect(out.limits.optical_drop_db).toBe(2);
    expect(out.nodes[10]).toEqual({ equipment: { state: 'good', reasons: [] }, uplink: null });
    expect(out.nodes[11].uplink).toEqual({ state: 'degraded', reasons: [{ code: 'optical_drop', value: -17, normal: -14, drop: 3, limit: 2 }] });
    expect(out.nodes[12].uplink.state).toBe('off');
    const [deviceSql, deviceParams] = db.query.mock.calls[0];
    expect(deviceSql).toMatch(/d\.organization_id = \? AND d\.deleted_at IS NULL/);
    expect(deviceParams).toEqual([5, 'outdoor_cpe', 'indoor_cpe', 'onu']);
    const metrics = db.query.mock.calls.find(([sql]) => /FROM snmp_metrics m/.test(sql));
    expect(metrics[1]).toEqual([10, 11, 12]);
    expect(metrics[0]).toMatch(/INTERVAL 20 MINUTE/);
    // The newest hour is left out of "normal" so a drop happening now is not part of it.
    const hourly = db.query.mock.calls.find(([sql]) => /FROM snmp_metrics_1hr/.test(sql));
    expect(hourly[0]).toMatch(/period_start < DATE_SUB\(NOW\(\), INTERVAL 1 HOUR\)/);
    expect(hourly[1]).toEqual([11]);
  });

  test('too little history gives no normal, so no drop is claimed', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [[{ id: 11, type: 'switch', status: 'online', parent_device_id: 10, uplink_interface: '3', uplink_capacity_mbps: null }]];
      if (/FROM snmp_metrics m/.test(sql)) return [[{ device_id: 11, interface_id: '3', ts: 1300, sfp_rx_power_dbm: -20 }]];
      if (/FROM snmp_metrics_1hr/.test(sql)) return [[{ device_id: 11, interface_id: '3', avg_sfp_rx_power_dbm: -14 }]];
      return [[]];
    });
    expect((await health.assess(5)).nodes[11].uplink).toEqual({ state: 'good', reasons: [] });
  });

  test('no equipment, no metric queries', async () => {
    db.query.mockResolvedValue([[]]);
    expect((await health.assess(5)).nodes).toEqual({});
    expect(db.query.mock.calls.some(([sql]) => /snmp_metrics/.test(sql))).toBe(false);
  });
});

describe('limits', () => {
  test('stored values outside their range, or unreadable, fall back to the default', async () => {
    expect(health.mergeLimits({ airtime_pct: 500, cpu_pct: 70, nonsense: 1 })).toEqual({ ...L, cpu_pct: 70 });
    db.query.mockResolvedValueOnce([[{ setting_value: '{not json' }]]);
    await expect(health.getLimits(5)).resolves.toEqual(L);
  });

  test('saving changes only what is sent, per organization', async () => {
    db.query.mockResolvedValueOnce([[{ setting_value: JSON.stringify({ cpu_pct: 70 }) }]]).mockResolvedValueOnce([{}]);
    const saved = await health.saveLimits(5, { airtime_pct: 65 });
    expect(saved).toEqual({ ...L, cpu_pct: 70, airtime_pct: 65 });
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO organization_settings/);
    expect(params).toEqual([5, 'link_health_limits', JSON.stringify(saved)]);
  });

  test('refuses an unknown limit and a value outside its range', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(health.saveLimits(5, { made_up: 1 })).rejects.toThrow(/not a limit/);
    await expect(health.saveLimits(5, { airtime_pct: 5 })).rejects.toThrow(/between 10 and 100/);
    await expect(health.saveLimits(5, { airtime_pct: true })).rejects.toThrow(/between/);
    await expect(health.saveLimits(5, [80])).rejects.toThrow(/required/);
    expect(db.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });
});

describe('uplink port', () => {
  test('lists the ports seen, in order, with what each carries', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 11, uplink_interface: '3', uplink_capacity_mbps: 1000 }]])
      .mockResolvedValueOnce([[
        { interface_id: '10', ts: 1300, if_in_octets: 100, if_out_octets: 100, if_oper_status: 2 },
        { interface_id: '3', ts: 1300, if_in_octets: 75000000, if_out_octets: 10, if_oper_status: 1 },
        { interface_id: '3', ts: 1000, if_in_octets: 0, if_out_octets: 0, if_oper_status: 1 },
      ]]);
    const out = await health.listPorts(5, 11);
    expect(out).toEqual({
      uplink_interface: '3', uplink_capacity_mbps: 1000,
      ports: [{ interface: '3', up: true, rate_mbps: 2 }, { interface: '10', up: false, rate_mbps: null }],
    });
    expect(db.query.mock.calls[0][1]).toEqual([11, 5]);
  });

  test('another organization\'s device is not found', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(health.listPorts(5, 11)).rejects.toMatchObject({ statusCode: 404 });
    db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(health.setUplink(5, 11, { uplink_interface: '3' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('saves the port and capacity, or clears them', async () => {
    db.query.mockResolvedValue([{ affectedRows: 1 }]);
    await expect(health.setUplink(5, 11, { uplink_interface: 3, uplink_capacity_mbps: '1000' })).resolves.toEqual({ id: 11, uplink_interface: '3', uplink_capacity_mbps: 1000 });
    expect(db.query.mock.calls[0]).toEqual(['UPDATE devices SET uplink_interface = ?, uplink_capacity_mbps = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', ['3', 1000, 11, 5]]);
    await expect(health.setUplink(5, 11, {})).resolves.toEqual({ id: 11, uplink_interface: null, uplink_capacity_mbps: null });
  });

  test('refuses a port that is not a port and a capacity that is not a whole number', async () => {
    await expect(health.setUplink(5, 11, { uplink_interface: "3'; DROP" })).rejects.toThrow(/not a port/);
    for (const bad of [0, -5, 1.5, 'fast', true]) await expect(health.setUplink(5, 11, { uplink_capacity_mbps: bad })).rejects.toThrow(/whole number/);
    expect(db.query).not.toHaveBeenCalled();
  });
});
