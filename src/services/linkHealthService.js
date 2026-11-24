// =============================================================================
// VigaBSS 5.0 — health of each line and each piece of equipment in the tree
// =============================================================================
// The network tree says what feeds what. This service says, for every piece
// of equipment in it, two things:
//
//   equipment  is the equipment itself well?   (CPU, memory, heat, battery,
//                                               a saturated sector)
//   uplink     is the line to its parent well? (port down, airtime, signal,
//                                               traffic against capacity,
//                                               optical power, errors)
//
// Each is one of:
//   good      measured, and nothing is past its limit
//   degraded  working, but something is past its limit
//   off       the equipment is offline or the port facing its parent is down
//   unknown   not measured recently, so nothing is claimed
//
// Every verdict carries its reasons as a code plus the numbers behind it, so
// a screen can explain it in any language and a later reader (a technician,
// the support assistant) sees the same evidence.
//
// What "degraded" means depends on the line:
//   - A radio (point-to-point link or sector) is judged on its traffic
//     against what it can carry RIGHT NOW: the rate the radio itself reports
//     over SNMP, which moves with weather and interference. A fixed capacity
//     typed by hand is only used when the radio reports none. Where the radio
//     reports airtime (airMAX), that is judged too, plus SNR and CCQ.
//   - A fibre port is judged on its received optical power: a sudden drop
//     against its own normal of the last days means the fibre needs attention
//     even while traffic still passes, and a level near the floor is weak.
//   - Any line with a known port and capacity is judged on traffic.
//   - A sector (point-to-multipoint AP) that is saturated is a problem of the
//     equipment, not of the line that feeds it. A saturated sector also lists
//     the subscriber radios on it that carry the most traffic.
//
// Measurements come from the SNMP poller (snmp_metrics). Equipment that is
// not polled is "unknown", never "good".
// =============================================================================

const db = require('../config/database');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { SUBSCRIBER_TYPES } = require('./networkTreeService');

const SETTING_KEY = 'link_health_limits';
const FRESH_MINUTES = 20;
const BASELINE_DAYS = 7;
const BASELINE_MIN_HOURS = 12;

// Default limits. Each can be changed per organization.
const LIMITS = {
  airtime_pct: { default: 80, min: 10, max: 100 },
  capacity_pct: { default: 85, min: 10, max: 100 },
  snr_db: { default: 20, min: 1, max: 60 },
  ccq_pct: { default: 80, min: 10, max: 100 },
  optical_drop_db: { default: 3, min: 0.5, max: 20 },
  optical_floor_dbm: { default: -27, min: -40, max: 0 },
  errors_per_min: { default: 60, min: 1, max: 100000 },
  cpu_pct: { default: 85, min: 10, max: 100 },
  memory_pct: { default: 90, min: 10, max: 100 },
  temperature_c: { default: 75, min: 20, max: 120 },
  battery_pct: { default: 30, min: 1, max: 99 },
};
const DEFAULT_LIMITS = Object.fromEntries(Object.entries(LIMITS).map(([key, def]) => [key, def.default]));

const WORST = { unknown: 0, good: 1, degraded: 2, off: 3 };
const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const round = (value, places = 1) => Number(Number(value).toFixed(places));

/** Limits stored for the organization merged over the defaults. */
function mergeLimits(stored) {
  const out = { ...DEFAULT_LIMITS };
  if (!stored || typeof stored !== 'object') return out;
  for (const [key, def] of Object.entries(LIMITS)) {
    const value = num(stored[key]);
    if (value !== null && value >= def.min && value <= def.max) out[key] = value;
  }
  return out;
}

async function getLimits(orgId) {
  const [rows] = await db.query(
    'SELECT setting_value FROM organization_settings WHERE organization_id = ? AND setting_key = ?', [orgId, SETTING_KEY],
  );
  if (!rows[0]) return mergeLimits(null);
  try { return mergeLimits(JSON.parse(rows[0].setting_value)); } catch (_) { return mergeLimits(null); }
}

/** Save limits. Every key given must be a known limit within its range. */
async function saveLimits(orgId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Limits are required');
  const next = await getLimits(orgId);
  for (const [key, raw] of Object.entries(input)) {
    const def = LIMITS[key];
    if (!def) throw new ValidationError(`${key} is not a limit`);
    const value = typeof raw === 'boolean' ? null : num(raw);
    if (value === null || value < def.min || value > def.max) throw new ValidationError(`${key} must be between ${def.min} and ${def.max}`);
    next[key] = value;
  }
  await db.query(
    `INSERT INTO organization_settings (organization_id, setting_key, setting_value)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [orgId, SETTING_KEY, JSON.stringify(next)],
  );
  return next;
}

function median(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function verdict(reasons, measured, offReasons = []) {
  if (offReasons.length) return { state: 'off', reasons: offReasons };
  if (reasons.length) return { state: 'degraded', reasons };
  return { state: measured ? 'good' : 'unknown', reasons: [] };
}

/**
 * Judge one piece of equipment. Pure: everything it needs is passed in.
 *
 * @param {{type: string, status: string|null, has_parent: boolean, uplink_interface: string|null, uplink_capacity_mbps: number|null}} device
 * @param {{device: object|null, uplink: object|null, rate_bps: number|null, errors_per_min: number|null, optical_normal_dbm: number|null, radio_capacity_mbps: number|null, radio_rate_bps: number|null}} readings
 *   device = newest device-wide values; uplink = newest values of the port facing the parent;
 *   radio_* = what a radio can carry right now and what it is carrying
 * @returns {{equipment: {state: string, reasons: object[]}, uplink: {state: string, reasons: object[]}|null}}
 */
function judge(device, readings, limits = DEFAULT_LIMITS) {
  const d = readings.device || {};
  const u = readings.uplink || {};
  const offline = device.status === 'offline';
  const isPtp = device.type === 'ptp';
  const wireless = (key) => num(u[key]) ?? num(d[key]);
  const over = (code, value, limit) => ({ code, value: round(value), limit });
  // A radio's traffic against what it can carry right now.
  const radioCapacity = num(readings.radio_capacity_mbps);
  const radioRate = num(readings.radio_rate_bps);
  const liveLoad = radioCapacity && radioRate !== null
    ? { pct: Math.min(100, (radioRate / (radioCapacity * 1e6)) * 100), mbps: round(radioRate / 1e6), capacity_mbps: round(radioCapacity) }
    : null;
  const liveReason = () => ({ code: 'capacity_live', value: round(liveLoad.pct), limit: limits.capacity_pct, mbps: liveLoad.mbps, capacity_mbps: liveLoad.capacity_mbps });

  // --- the equipment itself ---
  const equipment = [];
  let equipmentMeasured = false;
  const check = (code, value, limit, breached) => {
    if (value === null) return;
    equipmentMeasured = true;
    if (breached(value, limit)) equipment.push(over(code, value, limit));
  };
  const atLeast = (value, limit) => value >= limit;
  const atMost = (value, limit) => value <= limit;
  check('cpu', num(d.cpu_usage), limits.cpu_pct, atLeast);
  check('memory', num(d.memory_usage), limits.memory_pct, atLeast);
  check('temperature', num(d.temperature_c), limits.temperature_c, atLeast);
  check('battery', num(d.ups_battery_pct), limits.battery_pct, atMost);
  // A saturated sector is the sector's problem, not its feed's.
  if (!isPtp) check('airtime', wireless('air_util_pct'), limits.airtime_pct, atLeast);
  if (device.type === 'ptmp_ap' && liveLoad) {
    equipmentMeasured = true;
    if (liveLoad.pct >= limits.capacity_pct) equipment.push(liveReason());
  }
  const equipmentVerdict = verdict(equipment, equipmentMeasured, offline ? [{ code: 'offline' }] : []);

  // --- the line to its parent ---
  if (!device.has_parent) return { equipment: equipmentVerdict, uplink: null };
  const line = [];
  let lineMeasured = false;
  const lineCheck = (code, value, limit, breached) => {
    if (value === null) return;
    lineMeasured = true;
    if (breached(value, limit)) line.push(over(code, value, limit));
  };
  const off = [];
  if (offline) off.push({ code: 'offline' });
  // ifOperStatus: 1 = up, 2 = down.
  const oper = num(u.if_oper_status);
  if (oper !== null) { lineMeasured = true; if (oper === 2) off.push({ code: 'port_down' }); }

  if (isPtp) {
    lineCheck('airtime', wireless('air_util_pct'), limits.airtime_pct, atLeast);
    lineCheck('snr', wireless('snr_db'), limits.snr_db, (value, limit) => value < limit);
    lineCheck('ccq', wireless('ccq_pct'), limits.ccq_pct, (value, limit) => value < limit);
  }
  const rate = num(readings.rate_bps);
  const capacity = num(device.uplink_capacity_mbps);
  if (isPtp && liveLoad) {
    lineMeasured = true;
    if (liveLoad.pct >= limits.capacity_pct) line.push(liveReason());
  } else if (rate !== null && capacity) {
    lineCheck('capacity', Math.min(100, (rate / (capacity * 1e6)) * 100), limits.capacity_pct, atLeast);
  }
  const optical = num(u.sfp_rx_power_dbm);
  if (optical !== null) {
    lineMeasured = true;
    const normal = num(readings.optical_normal_dbm);
    if (normal !== null && normal - optical >= limits.optical_drop_db) {
      line.push({ code: 'optical_drop', value: round(optical), normal: round(normal), drop: round(normal - optical), limit: limits.optical_drop_db });
    } else if (optical <= limits.optical_floor_dbm) {
      line.push(over('optical_weak', optical, limits.optical_floor_dbm));
    }
  }
  lineCheck('errors', num(readings.errors_per_min), limits.errors_per_min, atLeast);
  return { equipment: equipmentVerdict, uplink: verdict(line, lineMeasured, off) };
}

const WIRELESS_COLUMNS = ['air_util_pct', 'snr_db', 'ccq_pct'];
const RADIO_TYPES = ['ptp', 'ptmp_ap'];
const DEVICE_COLUMNS = ['cpu_usage', 'memory_usage', 'temperature_c', 'ups_battery_pct', ...WIRELESS_COLUMNS];
const PORT_COLUMNS = ['if_oper_status', 'sfp_rx_power_dbm', ...WIRELESS_COLUMNS];

/**
 * Turn the recent metric rows of one device (newest first) into what judge()
 * reads. A value is the newest one that is not empty. Traffic and errors are
 * the difference between the two newest polls of the uplink port over their
 * real elapsed time; a counter that went backwards (reset, wrap) gives no
 * figure instead of an invented one.
 */
function readingsFor(rows, uplinkInterface, type = null) {
  const newest = (list, columns) => {
    const out = {};
    for (const column of columns) {
      const hit = list.find((row) => num(row[column]) !== null);
      if (hit) out[column] = num(hit[column]);
    }
    return Object.keys(out).length ? out : null;
  };
  const wide = rows.filter((row) => row.interface_id === null || row.interface_id === undefined);
  const device = newest(wide, DEVICE_COLUMNS) || {};
  // Radios often report their wireless figures on the radio interface.
  for (const column of WIRELESS_COLUMNS) {
    if (device[column] === undefined) {
      const hit = rows.find((row) => num(row[column]) !== null);
      if (hit) device[column] = num(hit[column]);
    }
  }
  const port = uplinkInterface === null || uplinkInterface === undefined
    ? []
    : rows.filter((row) => String(row.interface_id) === String(uplinkInterface));
  // Traffic of one interface from its two newest counted polls.
  const trafficOf = (list) => {
    const counted = list.filter((row) => num(row.if_in_octets) !== null && num(row.if_out_octets) !== null);
    if (counted.length < 2) return null;
    const seconds = Number(counted[0].ts) - Number(counted[1].ts);
    const dIn = Number(counted[0].if_in_octets) - Number(counted[1].if_in_octets);
    const dOut = Number(counted[0].if_out_octets) - Number(counted[1].if_out_octets);
    return seconds > 0 && dIn >= 0 && dOut >= 0 ? (Math.max(dIn, dOut) * 8) / seconds : null;
  };
  const rowsOf = (iface) => rows.filter((row) => row.interface_id !== null && row.interface_id !== undefined && String(row.interface_id) === String(iface));
  const rateBps = trafficOf(port);
  let errorsPerMin = null;
  // A radio: what it can carry now is the lower of the two rates it reports;
  // what it carries is the traffic of the interface reporting them, else of
  // the port facing its parent, else of its busiest interface (all of a
  // radio's traffic crosses the air).
  let radioCapacity = null;
  let radioRate = null;
  if (RADIO_TYPES.includes(type)) {
    const reporting = rows.find((row) => (num(row.tx_rate_mbps) ?? 0) > 0 || (num(row.rx_rate_mbps) ?? 0) > 0);
    if (reporting) {
      const rates = [num(reporting.tx_rate_mbps), num(reporting.rx_rate_mbps)].filter((v) => v !== null && v > 0);
      radioCapacity = Math.min(...rates);
      const own = reporting.interface_id === null || reporting.interface_id === undefined ? null : trafficOf(rowsOf(reporting.interface_id));
      const interfaces = [...new Set(rows.filter((row) => row.interface_id !== null && row.interface_id !== undefined).map((row) => String(row.interface_id)))];
      const busiest = interfaces.map((iface) => trafficOf(rowsOf(iface))).filter((v) => v !== null);
      radioRate = own ?? rateBps ?? (busiest.length ? Math.max(...busiest) : null);
    }
  }
  const counted = port.filter((row) => num(row.if_in_octets) !== null && num(row.if_out_octets) !== null);
  if (counted.length >= 2) {
    const [newer, older] = counted;
    const seconds = Number(newer.ts) - Number(older.ts);
    const errors = (row) => (num(row.if_in_errors) ?? 0) + (num(row.if_out_errors) ?? 0);
    const hasErrors = (row) => num(row.if_in_errors) !== null || num(row.if_out_errors) !== null;
    if (seconds > 0 && hasErrors(newer) && hasErrors(older) && errors(newer) >= errors(older)) {
      errorsPerMin = ((errors(newer) - errors(older)) / seconds) * 60;
    }
  }
  return {
    device: Object.keys(device).length ? device : null,
    uplink: newest(port, PORT_COLUMNS),
    rate_bps: rateBps,
    errors_per_min: errorsPerMin,
    optical_normal_dbm: null,
    radio_capacity_mbps: radioCapacity,
    radio_rate_bps: radioRate,
  };
}

/**
 * Health of every piece of network equipment of the organization.
 * @returns {Promise<{checked_at: string, limits: object, nodes: Object<string, object>}>}
 */
async function assess(orgId) {
  const [devices] = await db.query(
    `SELECT d.id, d.type, d.status, d.parent_device_id, d.uplink_interface, d.uplink_capacity_mbps
       FROM devices d
      WHERE d.organization_id = ? AND d.deleted_at IS NULL
        AND d.type NOT IN (${SUBSCRIBER_TYPES.map(() => '?').join(', ')})`,
    [orgId, ...SUBSCRIBER_TYPES],
  );
  const limits = await getLimits(orgId);
  const nodes = {};
  if (!devices.length) return { checked_at: new Date().toISOString(), limits, nodes };

  const ids = devices.map((d) => Number(d.id));
  const marks = ids.map(() => '?').join(', ');
  const [metricRows] = await db.query(
    `SELECT m.device_id, m.interface_id, UNIX_TIMESTAMP(m.polled_at) AS ts,
            m.if_in_octets, m.if_out_octets, m.if_in_errors, m.if_out_errors, m.if_oper_status,
            m.cpu_usage, m.memory_usage, m.temperature_c, m.ups_battery_pct,
            m.air_util_pct, m.snr_db, m.ccq_pct, m.sfp_rx_power_dbm, m.tx_rate_mbps, m.rx_rate_mbps
       FROM snmp_metrics m
      WHERE m.device_id IN (${marks})
        AND m.polled_at >= DATE_SUB(NOW(), INTERVAL ${FRESH_MINUTES} MINUTE)
      ORDER BY m.device_id ASC, m.polled_at DESC`,
    ids,
  );
  const byDevice = new Map();
  for (const row of metricRows) {
    const key = Number(row.device_id);
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key).push(row);
  }

  // The normal optical level of each uplink port: the median of its hourly
  // averages over the last days, leaving out the newest hour so that a drop
  // happening now is not already part of "normal".
  const withPort = devices.filter((d) => d.uplink_interface !== null && d.uplink_interface !== undefined && d.uplink_interface !== '');
  const normals = new Map();
  if (withPort.length) {
    const [hourly] = await db.query(
      `SELECT h.device_id, h.interface_id, h.avg_sfp_rx_power_dbm
         FROM snmp_metrics_1hr h
        WHERE h.device_id IN (${withPort.map(() => '?').join(', ')})
          AND h.avg_sfp_rx_power_dbm IS NOT NULL
          AND h.period_start >= DATE_SUB(NOW(), INTERVAL ${BASELINE_DAYS} DAY)
          AND h.period_start < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      withPort.map((d) => Number(d.id)),
    );
    const samples = new Map();
    const portOf = new Map(withPort.map((d) => [Number(d.id), String(d.uplink_interface)]));
    for (const row of hourly) {
      const id = Number(row.device_id);
      if (String(row.interface_id) !== portOf.get(id)) continue;
      if (!samples.has(id)) samples.set(id, []);
      samples.get(id).push(num(row.avg_sfp_rx_power_dbm));
    }
    for (const [id, list] of samples) {
      if (list.length >= BASELINE_MIN_HOURS) normals.set(id, median(list));
    }
  }

  for (const device of devices) {
    const id = Number(device.id);
    const readings = readingsFor(byDevice.get(id) || [], device.uplink_interface, device.type);
    readings.optical_normal_dbm = normals.get(id) ?? null;
    nodes[id] = judge({
      type: device.type,
      status: device.status,
      has_parent: Boolean(device.parent_device_id),
      uplink_interface: device.uplink_interface,
      uplink_capacity_mbps: device.uplink_capacity_mbps,
    }, readings, limits);
  }
  await addTopClients(orgId, devices, nodes);
  return { checked_at: new Date().toISOString(), limits, nodes };
}

const TOP_CLIENTS = 5;

/**
 * For each saturated sector, the subscriber radios on it carrying the most
 * traffic right now: who is filling it. A subscriber radio counts when the
 * sector saw it in the last half hour and it is polled itself. Airtime per
 * subscriber is not collected, so traffic stands in for it.
 */
async function addTopClients(orgId, devices, nodes) {
  const saturated = devices
    .filter((d) => d.type === 'ptmp_ap')
    .map((d) => Number(d.id))
    .filter((id) => nodes[id].equipment.reasons.some((r) => r.code === 'airtime' || r.code === 'capacity_live'));
  if (!saturated.length) return;
  const [sessions] = await db.query(
    `SELECT DISTINCT w.device_id AS sector_id, c.id AS client_device_id, c.name
       FROM wireless_client_sessions w
       JOIN devices c ON c.id = w.client_device_id AND c.organization_id = ? AND c.deleted_at IS NULL
      WHERE w.organization_id = ? AND w.device_id IN (${saturated.map(() => '?').join(', ')})
        AND w.last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
    [orgId, orgId, ...saturated],
  );
  if (!sessions.length) return;
  const clientIds = [...new Set(sessions.map((row) => Number(row.client_device_id)))];
  const [rows] = await db.query(
    `SELECT m.device_id, m.interface_id, UNIX_TIMESTAMP(m.polled_at) AS ts, m.if_in_octets, m.if_out_octets
       FROM snmp_metrics m
      WHERE m.device_id IN (${clientIds.map(() => '?').join(', ')}) AND m.interface_id IS NOT NULL
        AND m.polled_at >= DATE_SUB(NOW(), INTERVAL ${FRESH_MINUTES} MINUTE)
      ORDER BY m.device_id ASC, m.polled_at DESC`,
    clientIds,
  );
  const byClient = new Map();
  for (const row of rows) {
    const key = Number(row.device_id);
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(row);
  }
  const traffic = new Map();
  for (const [id, list] of byClient) {
    // Read as a radio with no reported rate: the busiest interface.
    const interfaces = [...new Set(list.map((row) => String(row.interface_id)))];
    const best = interfaces
      .map((iface) => readingsFor(list, iface).rate_bps)
      .filter((v) => v !== null);
    if (best.length) traffic.set(id, Math.max(...best));
  }
  for (const sector of saturated) {
    const top = sessions
      .filter((row) => Number(row.sector_id) === sector && traffic.has(Number(row.client_device_id)))
      .map((row) => ({ device_id: Number(row.client_device_id), name: row.name, mbps: round(traffic.get(Number(row.client_device_id)) / 1e6, 2) }))
      .sort((a, b) => b.mbps - a.mbps)
      .slice(0, TOP_CLIENTS);
    if (top.length) nodes[sector].equipment.top_clients = top;
  }
}

/**
 * The ports the poller has seen on a device in the last day, with how much
 * each is carrying now, to choose the one that faces its parent.
 */
async function listPorts(orgId, deviceId) {
  const [[device]] = await db.query(
    'SELECT id, uplink_interface, uplink_capacity_mbps FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [deviceId, orgId],
  );
  if (!device) throw new NotFoundError('Device');
  const [rows] = await db.query(
    `SELECT m.interface_id, UNIX_TIMESTAMP(m.polled_at) AS ts, m.if_in_octets, m.if_out_octets, m.if_oper_status
       FROM snmp_metrics m
      WHERE m.device_id = ? AND m.interface_id IS NOT NULL
        AND m.polled_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
      ORDER BY m.polled_at DESC
      LIMIT 5000`,
    [device.id],
  );
  const ports = new Map();
  for (const row of rows) {
    const key = String(row.interface_id);
    if (!ports.has(key)) ports.set(key, []);
    if (ports.get(key).length < 2) ports.get(key).push(row);
  }
  const list = [...ports.entries()].map(([port, pair]) => {
    const reading = readingsFor(pair, port);
    return {
      interface: port,
      up: num(pair[0].if_oper_status) === null ? null : num(pair[0].if_oper_status) === 1,
      rate_mbps: reading.rate_bps === null ? null : round(reading.rate_bps / 1e6, 2),
    };
  }).sort((a, b) => a.interface.localeCompare(b.interface, undefined, { numeric: true }));
  return {
    uplink_interface: device.uplink_interface ?? null,
    uplink_capacity_mbps: device.uplink_capacity_mbps === null || device.uplink_capacity_mbps === undefined ? null : Number(device.uplink_capacity_mbps),
    ports: list,
  };
}

/** Say which port of a device faces its parent and what the line can carry. */
async function setUplink(orgId, deviceId, input) {
  const body = input || {};
  let port = null;
  if (body.uplink_interface !== undefined && body.uplink_interface !== null && body.uplink_interface !== '') {
    port = String(body.uplink_interface);
    if (!/^[\w.:/-]{1,64}$/.test(port)) throw new ValidationError('That is not a port of the device');
  }
  let capacity = null;
  if (body.uplink_capacity_mbps !== undefined && body.uplink_capacity_mbps !== null && body.uplink_capacity_mbps !== '') {
    capacity = typeof body.uplink_capacity_mbps === 'boolean' ? NaN : Number(body.uplink_capacity_mbps);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) throw new ValidationError('Capacity must be a whole number of Mbps');
  }
  const [result] = await db.query(
    'UPDATE devices SET uplink_interface = ?, uplink_capacity_mbps = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [port, capacity, deviceId, orgId],
  );
  if (!result.affectedRows) throw new NotFoundError('Device');
  return { id: Number(deviceId), uplink_interface: port, uplink_capacity_mbps: capacity };
}

module.exports = {
  assess, getLimits, saveLimits, listPorts, setUplink,
  // exported for tests and for the customer path check
  judge, readingsFor, mergeLimits, median, LIMITS, DEFAULT_LIMITS, WORST, FRESH_MINUTES,
};
