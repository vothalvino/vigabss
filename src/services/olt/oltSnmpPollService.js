// =============================================================================
// VigaBSS 5.0 — scheduled OLT monitoring over SNMP (Huawei xPON MIB)
// =============================================================================
// The command line is for provisioning and on-demand checks; it is too heavy
// to run against every port every few minutes. SNMP is light, so the
// scheduled read of "which ONUs are up, how far, how strong" goes over SNMP.
//
// Each OLT with SNMP enabled is walked for six columns of HUAWEI-XPON-MIB and
// the result is stored with the same code the Live OLT tab uses
// (fibreFaultService.record), so the fibre check always has recent distances
// and can be answered from stored readings without touching the OLT.
//
// STATUS: the object numbers, scales and codes below come from published
// copies of HUAWEI-XPON-MIB and from operators' notes. They have NOT been
// verified against an OLT. Each one is listed with what it is believed to
// return so it can be checked with an snmpwalk on real equipment.
// =============================================================================

const db = require('../../config/database');
const snmpPoller = require('../snmpPoller');
const fibreFaultService = require('./fibreFaultService');
const logger = require('../../utils/logger').child({ service: 'oltSnmpPoll' });

const XPON = '1.3.6.1.4.1.2011.6.128.1.1.2';
// Indexed by ifIndex.ontId.
const OID = Object.freeze({
  serial: `${XPON}.43.1.3`,       // hwGponDeviceOntSn            8 bytes
  description: `${XPON}.43.1.9`,  // hwGponDeviceOntDespt         text
  runStatus: `${XPON}.46.1.15`,   // hwGponDeviceOntControlRunStatus      1 online, 2 offline
  ranging: `${XPON}.46.1.20`,     // hwGponDeviceOntControlRanging        metres; -1 when unknown
  lastDownCause: `${XPON}.46.1.24`, // hwGponDeviceOntControlLastDownCause  code, see DOWN_CAUSES
  rxPower: `${XPON}.51.1.4`,      // hwGponOntOpticalDdmRxPower           0.01 dBm; 2147483647 when unknown
});

// hwGponDeviceOntControlLastDownCause. Named as the OLT's command line names
// them, so both sources classify the same way in fibreFaultService.
const DOWN_CAUSES = Object.freeze({
  1: 'LOS', 2: 'LOSi/LOBi', 3: 'LOFi', 4: 'SFi', 5: 'LOAi', 6: 'LOAMi',
  7: 'deactive ONT fail', 8: 'deactive ONT success', 9: 'reset ONT', 10: 're-register ONT',
  11: 'pop up fail', 13: 'dying-gasp', 15: 'LOKi', 18: 'deactived ONT due to the ring',
  30: 'shut down ONT optical module', 31: 'reset ONT by ONT command', 32: 'reset ONT by ONT reset button',
  33: 'reset ONT by ONT software', 34: 'deactived ONT due to broadcast attack', 35: 'operator check fail',
  37: 'a rogue ONT detected by itself',
});

const GPON_IFINDEX_BASE = 0xFA000000; // 4194304000

/**
 * A GPON port's ifIndex to "frame/slot/port". For frame 0, Huawei numbers a
 * GPON port 0xFA000000 + slot * 8192 + port * 256 (4194312192 is 0/1/0).
 * Other frames are not decoded: an ifIndex that does not fit returns null and
 * its ONUs are left out rather than filed under a wrong port.
 */
function portOfIfIndex(ifIndex) {
  const n = Number(ifIndex);
  if (!Number.isInteger(n) || n < GPON_IFINDEX_BASE) return null;
  const rest = n - GPON_IFINDEX_BASE;
  if (rest % 256 !== 0) return null;
  const slot = Math.floor(rest / 8192);
  const port = (rest % 8192) / 256;
  if (slot > 63 || port > 31) return null;
  return `0/${slot}/${port}`;
}

/** The last two numbers of a varbind's OID under `base`: [ifIndex, ontId]. */
function indexOf(oid, base) {
  const tail = String(oid).slice(base.length + 1).split('.');
  if (tail.length !== 2) return null;
  const [ifIndex, ontId] = tail.map(Number);
  return Number.isInteger(ifIndex) && Number.isInteger(ontId) ? [ifIndex, ontId] : null;
}

const asNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Buffer.isBuffer(value)) return Number(value.toString());
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const asText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, '').trim(); // eslint-disable-line no-control-regex
/** An 8-byte serial as 16 hex digits, as the command line shows it. */
const asSerial = (value) => {
  if (Buffer.isBuffer(value) && value.length === 8) return value.toString('hex').toUpperCase();
  const text = asText(value);
  return /^[0-9A-Fa-f]{16}$/.test(text) ? text.toUpperCase() : (text || null);
};

/**
 * Turn the walked columns into ONUs grouped by PON port. Pure.
 *
 * @param {Record<keyof typeof OID, Array<{oid:string, value:any}>>} columns
 * @returns {Map<string, Array<object>>} port -> ONUs, in the shape the command line gives
 */
function assemble(columns) {
  const onus = new Map(); // "ifIndex.ontId" -> onu
  const at = (name, apply) => {
    for (const vb of columns[name] || []) {
      const index = indexOf(vb.oid, OID[name]);
      if (!index) continue;
      const port = portOfIfIndex(index[0]);
      if (!port) continue;
      const key = `${index[0]}.${index[1]}`;
      if (!onus.has(key)) onus.set(key, { port, ont_id: index[1] });
      apply(onus.get(key), vb.value);
    }
  };
  at('runStatus', (o, v) => { const n = asNumber(v); o.state = n === 1 ? 'online' : 'offline'; });
  at('serial', (o, v) => { o.serial_number = asSerial(v); });
  at('description', (o, v) => { o.description = asText(v) || null; });
  at('lastDownCause', (o, v) => { const n = asNumber(v); o.last_down_cause = DOWN_CAUSES[n] || null; });
  at('ranging', (o, v) => { const n = asNumber(v); o.distance_m = n !== null && n > 0 && n < 100000 ? n : null; });
  at('rxPower', (o, v) => {
    const n = asNumber(v);
    // 0.01 dBm. Anything outside what an optical receiver can report is "no reading".
    o.rx_power_dbm = n !== null && n > -5000 && n < 1000 ? Math.round(n) / 100 : null;
  });
  const byPort = new Map();
  for (const onu of onus.values()) {
    // An entry with no run status is not an ONU row we understand.
    if (!onu.state) continue;
    if (!byPort.has(onu.port)) byPort.set(onu.port, []);
    byPort.get(onu.port).push(onu);
  }
  return byPort;
}

/**
 * Read one OLT over SNMP and remember every port's ONUs.
 * @param {object} device  devices row (SNMP fields)
 * @returns {Promise<{ports:number, onus:number}>}
 */
async function pollOlt(device, { createSession = snmpPoller.createSnmpSession, subtree = snmpPoller.snmpSubtree } = {}) {
  const session = createSession(device, { timeout: 8000, retries: 1 });
  try {
    const columns = {};
    // Run status first: without it nothing else is usable, so fail fast.
    columns.runStatus = await subtree(session, OID.runStatus);
    for (const name of ['serial', 'description', 'lastDownCause', 'ranging', 'rxPower']) {
      // A column this release lacks must not lose the others.
      columns[name] = await subtree(session, OID[name]).catch((err) => {
        logger.warn({ deviceId: device.id, column: name, err: err.message }, 'OLT SNMP column could not be read');
        return [];
      });
    }
    const byPort = assemble(columns);
    let total = 0;
    for (const [port, onus] of byPort) {
      await fibreFaultService.record(device.organization_id, device.id, port, onus);
      total += onus.length;
    }
    return { ports: byPort.size, onus: total };
  } finally {
    try { session.close(); } catch (_) { /* already closed */ }
  }
}

/** Every OLT with SNMP enabled, one after another. One OLT failing does not stop the rest. */
async function pollAll(organizationId = null) {
  const params = [];
  let org = '';
  if (organizationId) { org = ' AND organization_id = ?'; params.push(organizationId); }
  const [devices] = await db.query(
    `SELECT * FROM devices
      WHERE type = 'olt' AND snmp_enabled = 1 AND deleted_at IS NULL AND organization_id IS NOT NULL${org}`,
    params,
  );
  const results = [];
  for (const device of devices) {
    try {
      results.push({ device_id: device.id, ...(await pollOlt(device)) });
    } catch (err) {
      logger.warn({ deviceId: device.id, err: err.message }, 'OLT SNMP poll failed');
      results.push({ device_id: device.id, error: err.message });
    }
  }
  return {
    olts: devices.length,
    polled: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    onus: results.reduce((n, r) => n + (r.onus || 0), 0),
    results,
  };
}

module.exports = { pollOlt, pollAll, assemble, portOfIfIndex, OID, DOWN_CAUSES };
