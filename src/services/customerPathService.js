// =============================================================================
// VigaBSS 5.0 — a customer's path through the network, checked hop by hop
// =============================================================================
// For one contract, every piece of the way from the customer's equipment up
// to the main NAS, each with its health:
//
//   WISP   customer radio (CPE) → sector → every link and router above → main NAS
//   FTTH   ONU → OLT → everything above → main NAS
//
// and one conclusion about WHERE a fault is:
//
//   backhaul            our network above the access equipment
//   access              our sector or OLT, or the line that feeds it
//   customer_link       the radio link or fibre drop between the customer and us
//   customer_equipment  the customer's own radio, ONU or router
//   customer_plan       the customer is using all the speed of their plan
//   none                everything measured is good
//   unknown             not enough is measured to say
//
// The hops above the customer are the network tree (devices.parent_device_id)
// judged by linkHealthService. What cannot be checked is reported as a gap,
// never assumed good: a path that stops before a main NAS, equipment that is
// not polled, a customer with no known equipment.
//
// The result is plain data (codes and numbers). Staff screens, tickets and
// the support assistant all read the same thing.
// =============================================================================

const db = require('../config/database');
const { NotFoundError } = require('../utils/errors');
const { effectiveTechnology } = require('../utils/accessTechnology');
const linkHealth = require('./linkHealthService');

const MAX_HOPS = 64;
const SESSION_MINUTES = 30;
const ONU_READING_HOURS = 6;
const DEFAULT_SIGNAL_MIN_DBM = -75;
const DEFAULT_OPTICAL_MIN_DBM = -27;
const PLAN_FULL_PCT = 90;
const CUSTOMER_TYPES = ['outdoor_cpe', 'indoor_cpe', 'onu'];

const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const round = (value, places = 1) => Number(Number(value).toFixed(places));
const UNKNOWN = Object.freeze({ state: 'unknown', reasons: [] });
const SIDE_ORDER = ['backhaul', 'access', 'customer_link', 'customer_equipment', 'customer_plan'];

/**
 * The single conclusion from every finding. The worst state wins; between
 * equals, the side that affects the most people comes first.
 */
function conclude(findings, anythingMeasured) {
  if (!findings.length) return { side: anythingMeasured ? 'none' : 'unknown', state: anythingMeasured ? 'good' : 'unknown' };
  const ranked = [...findings].sort((a, b) => (
    (linkHealth.WORST[b.state] - linkHealth.WORST[a.state]) || (SIDE_ORDER.indexOf(a.side) - SIDE_ORDER.indexOf(b.side))
  ));
  return { side: ranked[0].side, state: ranked[0].state };
}

/** The customer's radio link, from what the sector last saw of it. */
function judgeWirelessLink(session, contract, limits) {
  if (!session) return UNKNOWN;
  const reasons = [];
  const floor = num(contract.wireless_signal_min_dbm) ?? DEFAULT_SIGNAL_MIN_DBM;
  const signal = num(session.signal_dbm);
  const snr = num(session.snr_db);
  const ccq = num(session.ccq_pct);
  if (signal !== null && signal < floor) reasons.push({ code: 'signal', value: round(signal), limit: floor });
  if (snr !== null && snr < limits.snr_db) reasons.push({ code: 'snr', value: round(snr), limit: limits.snr_db });
  if (ccq !== null && ccq < limits.ccq_pct) reasons.push({ code: 'ccq', value: round(ccq), limit: limits.ccq_pct });
  if (reasons.length) return { state: 'degraded', reasons };
  return signal === null && snr === null && ccq === null ? UNKNOWN : { state: 'good', reasons: [] };
}

/** The customer's fibre drop, from the OLT's last reading of the ONU. */
function judgeFibreDrop(reading, contract) {
  if (!reading) return UNKNOWN;
  const state = String(reading.state || '').toLowerCase();
  if (state && state !== 'online') {
    return { state: 'off', reasons: [{ code: 'onu_offline', cause: reading.last_down_cause || null }] };
  }
  const floor = num(contract.optical_min_dbm) ?? DEFAULT_OPTICAL_MIN_DBM;
  const power = num(reading.rx_power_dbm);
  if (power !== null && power <= floor) return { state: 'degraded', reasons: [{ code: 'optical_weak', value: round(power), limit: floor }] };
  return power === null && !state ? UNKNOWN : { state: 'good', reasons: [] };
}

/**
 * @param {number} orgId
 * @param {number|string} contractId
 * @returns {Promise<object>} the path, its findings and the conclusion
 */
async function pathForContract(orgId, contractId) {
  const [[contract]] = await db.query(
    `SELECT c.id, c.client_id, c.status, c.access_technology, c.wireless_signal_min_dbm, c.optical_min_dbm,
            p.name AS plan_name, p.access_technology AS plan_technology, p.download_speed_mbps, p.upload_speed_mbps
       FROM contracts c
       LEFT JOIN plans p ON p.id = c.plan_id AND p.organization_id = c.organization_id
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL`,
    [contractId, orgId],
  );
  if (!contract) throw new NotFoundError('Contract');
  const technology = effectiveTechnology(contract.access_technology, contract.plan_technology);
  const gaps = [];
  const findings = [];
  const hops = [];
  let measured = false;

  // --- the customer's own equipment ---
  const [customerDevices] = await db.query(
    `SELECT DISTINCT d.id, d.name, d.type, d.status, d.parent_device_id
       FROM devices d
       LEFT JOIN cpe_devices cd ON cd.device_id = d.id AND cd.organization_id = d.organization_id AND cd.deleted_at IS NULL
      WHERE d.organization_id = ? AND d.deleted_at IS NULL
        AND d.type IN (${CUSTOMER_TYPES.map(() => '?').join(', ')})
        AND (d.contract_id = ? OR cd.contract_id = ?)
      ORDER BY d.id DESC`,
    [orgId, ...CUSTOMER_TYPES, contract.id, contract.id],
  );
  const wanted = technology === 'ftth' ? ['onu'] : ['outdoor_cpe', 'indoor_cpe'];
  const customer = customerDevices.find((d) => wanted.includes(d.type)) || customerDevices[0] || null;
  const limits = await linkHealth.getLimits(orgId);

  let accessId = null;
  let link = UNKNOWN;
  let linkDetail = null;
  if (technology === 'ftth') {
    const [[onu]] = await db.query(
      `SELECT o.olt_device_id, o.port, o.ont_id, o.serial_number, o.active
         FROM olt_onus o
        WHERE o.contract_id = ? AND o.organization_id = ?
        ORDER BY o.id DESC LIMIT 1`,
      [contract.id, orgId],
    );
    if (onu) {
      accessId = Number(onu.olt_device_id);
      const [[reading]] = await db.query(
        `SELECT r.state, r.last_down_cause, r.rx_power_dbm, r.distance_m, UNIX_TIMESTAMP(r.read_at) AS ts
           FROM olt_onu_readings r
          WHERE r.organization_id = ? AND r.olt_device_id = ? AND r.port = ? AND r.ont_id = ?
            AND r.read_at >= DATE_SUB(NOW(), INTERVAL ${ONU_READING_HOURS} HOUR)
          ORDER BY r.read_at DESC LIMIT 1`,
        [orgId, onu.olt_device_id, onu.port, onu.ont_id],
      );
      link = judgeFibreDrop(reading || null, contract);
      linkDetail = { port: onu.port, ont_id: onu.ont_id, rx_power_dbm: reading ? num(reading.rx_power_dbm) : null, distance_m: reading ? num(reading.distance_m) : null };
      if (!reading) gaps.push('onu_not_read');
    } else {
      gaps.push('onu_not_registered');
    }
  } else if (customer) {
    const [[session]] = await db.query(
      `SELECT w.device_id, w.signal_dbm, w.snr_db, w.ccq_pct, w.tx_rate_mbps, w.rx_rate_mbps
         FROM wireless_client_sessions w
        WHERE w.organization_id = ? AND w.client_device_id = ?
          AND w.last_seen_at >= DATE_SUB(NOW(), INTERVAL ${SESSION_MINUTES} MINUTE)
        ORDER BY w.last_seen_at DESC LIMIT 1`,
      [orgId, customer.id],
    );
    if (session) {
      accessId = Number(session.device_id);
      link = judgeWirelessLink(session, contract, limits);
      linkDetail = { signal_dbm: num(session.signal_dbm), snr_db: num(session.snr_db), ccq_pct: num(session.ccq_pct) };
    } else {
      gaps.push('not_seen_on_a_sector');
    }
  }
  // Fall back to where the equipment hangs in the tree.
  if (!accessId && customer && customer.parent_device_id) accessId = Number(customer.parent_device_id);
  if (!customer) gaps.push('no_customer_equipment');

  // The customer's equipment itself and how much of the plan it is using.
  let customerVerdict = UNKNOWN;
  let saturation = null;
  if (customer) {
    const [rows] = await db.query(
      `SELECT m.device_id, m.interface_id, UNIX_TIMESTAMP(m.polled_at) AS ts,
              m.if_in_octets, m.if_out_octets, m.if_in_errors, m.if_out_errors, m.if_oper_status,
              m.cpu_usage, m.memory_usage, m.temperature_c, m.ups_battery_pct,
              m.air_util_pct, m.snr_db, m.ccq_pct, m.sfp_rx_power_dbm, m.tx_rate_mbps, m.rx_rate_mbps
         FROM snmp_metrics m
        WHERE m.device_id = ?
          AND m.polled_at >= DATE_SUB(NOW(), INTERVAL ${linkHealth.FRESH_MINUTES} MINUTE)
        ORDER BY m.polled_at DESC`,
      [customer.id],
    );
    const readings = linkHealth.readingsFor(rows, null);
    customerVerdict = linkHealth.judge({ type: customer.type, status: customer.status, has_parent: false, uplink_interface: null, uplink_capacity_mbps: null }, readings, limits).equipment;
    // Traffic: the busiest interface of the customer's equipment.
    const interfaces = [...new Set(rows.filter((r) => r.interface_id !== null && r.interface_id !== undefined).map((r) => String(r.interface_id)))];
    const rates = interfaces.map((iface) => linkHealth.readingsFor(rows, iface).rate_bps).filter((v) => v !== null);
    const speed = num(contract.download_speed_mbps);
    if (rates.length && speed) {
      const mbps = Math.max(...rates) / 1e6;
      const pct = Math.min(100, (mbps / speed) * 100);
      saturation = { mbps: round(mbps), plan_mbps: speed, pct: round(pct), full: pct >= PLAN_FULL_PCT };
      measured = true;
    }
    if (customerVerdict.state !== 'unknown') measured = true;
    if (customerVerdict.state === 'degraded' || customerVerdict.state === 'off') {
      findings.push({ side: 'customer_equipment', state: customerVerdict.state, part: 'equipment', device_id: Number(customer.id), name: customer.name, reasons: customerVerdict.reasons });
    }
  }
  if (link.state !== 'unknown') measured = true;
  if (link.state === 'degraded' || link.state === 'off') {
    findings.push({ side: 'customer_link', state: link.state, part: 'line', device_id: customer ? Number(customer.id) : null, name: customer ? customer.name : null, reasons: link.reasons });
  }
  if (saturation && saturation.full) {
    findings.push({ side: 'customer_plan', state: 'degraded', part: 'plan', device_id: null, name: contract.plan_name || null, reasons: [{ code: 'plan_full', value: saturation.pct, limit: PLAN_FULL_PCT, mbps: saturation.mbps, plan_mbps: saturation.plan_mbps }] });
  }
  hops.push({
    role: 'customer',
    device_id: customer ? Number(customer.id) : null,
    name: customer ? customer.name : null,
    type: customer ? customer.type : (technology === 'ftth' ? 'onu' : 'outdoor_cpe'),
    equipment: customerVerdict,
    line: link,
    detail: linkDetail,
  });

  // --- our network: from the access equipment up the tree ---
  let reachesMainNas = false;
  if (accessId) {
    const [networkDevices] = await db.query(
      `SELECT d.id, d.name, d.type, d.parent_device_id, n.id AS nas_id, n.is_main
         FROM devices d
         LEFT JOIN nas n ON n.device_id = d.id AND n.organization_id = d.organization_id AND n.deleted_at IS NULL
        WHERE d.organization_id = ? AND d.deleted_at IS NULL`,
      [orgId],
    );
    const byId = new Map(networkDevices.map((d) => [Number(d.id), d]));
    const report = await linkHealth.assess(orgId);
    const seen = new Set();
    let cursor = byId.get(accessId) || null;
    if (!cursor) gaps.push('access_equipment_unknown');
    let first = true;
    while (cursor && !seen.has(Number(cursor.id)) && hops.length <= MAX_HOPS) {
      const id = Number(cursor.id);
      seen.add(id);
      const verdicts = report.nodes[id] || { equipment: UNKNOWN, uplink: null };
      const role = first ? 'access' : 'network';
      const isMain = Number(cursor.is_main) === 1;
      hops.push({
        role, device_id: id, name: cursor.name, type: cursor.type,
        nas_id: cursor.nas_id ? Number(cursor.nas_id) : null, is_main: isMain,
        equipment: verdicts.equipment, line: verdicts.uplink,
      });
      const side = first ? 'access' : 'backhaul';
      for (const [part, verdict] of [['equipment', verdicts.equipment], ['line', verdicts.uplink]]) {
        if (!verdict) continue;
        if (verdict.state !== 'unknown') measured = true;
        if (verdict.state === 'degraded' || verdict.state === 'off') {
          findings.push({ side, state: verdict.state, part, device_id: id, name: cursor.name, reasons: verdict.reasons, ...(verdict.top_clients ? { top_clients: verdict.top_clients } : {}) });
        }
      }
      if (verdicts.equipment.state === 'unknown') gaps.push(`not_measured:${id}`);
      if (isMain) { reachesMainNas = true; break; }
      first = false;
      cursor = cursor.parent_device_id ? byId.get(Number(cursor.parent_device_id)) || null : null;
    }
    if (!reachesMainNas) gaps.push('path_stops_before_main_nas');
  } else if (customer) {
    gaps.push('access_equipment_unknown');
  }

  return {
    contract_id: Number(contract.id),
    client_id: Number(contract.client_id),
    technology,
    plan: { name: contract.plan_name || null, download_mbps: num(contract.download_speed_mbps), upload_mbps: num(contract.upload_speed_mbps) },
    hops,
    saturation,
    reaches_main_nas: reachesMainNas,
    findings,
    conclusion: conclude(findings, measured),
    gaps: [...new Set(gaps)],
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  pathForContract,
  // exported for tests
  conclude, judgeWirelessLink, judgeFibreDrop, SIDE_ORDER, PLAN_FULL_PCT,
};
