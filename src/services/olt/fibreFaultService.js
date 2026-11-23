// =============================================================================
// VigaBSS 5.0 — is the fibre cut, and how far away?
// =============================================================================
// Works from what every GPON OLT reports for a PON port: which ONUs are
// online, why the others went down, and (while an ONU is online) its distance
// from the OLT. No special hardware is needed.
//
//   - An ONU that lost its optical signal goes down with a LOS-type cause
//     (LOSi/LOBi, LOFi...). One that lost mains power says dying-gasp. That
//     separates a fibre problem from a power cut.
//   - An ONU with no signal reports no distance, so each read stores the
//     distance of the ONUs that ARE online (olt_onu_readings, migration 023).
//     When an ONU later loses signal, its remembered distance is how far it is.
//   - A PON is a tree: one fibre from the OLT, splitters, then branches. A
//     break is always upstream of every ONU it took down, so it is no farther
//     from the OLT than the NEAREST of them.
//
// What this cannot do is measure the break itself. That takes an OTDR (a
// transceiver with eOTDR measures reflections along the fibre). The figure
// given here is an upper bound, and the wording says so.
// =============================================================================

const db = require('../../config/database');

const LOS = /\b(LOS|LOSI|LOBI|LOFI|LOF|LOAMI|SF|SD)\b/i;
const POWER = /dying|gasp|power/i;

const causeKind = (cause) => {
  const text = String(cause || '').replace(/[/_-]/g, ' ');
  if (POWER.test(text)) return 'power';
  if (LOS.test(text)) return 'signal';
  return 'other';
};

/**
 * Judge one PON port from its ONUs. Pure.
 *
 * @param {Array<{ont_id:number, state:string, last_down_cause?:string|null, distance_m?:number|null}>} onus
 *   distance_m is the distance when last online
 * @returns {{
 *   verdict: 'no_onus'|'healthy'|'no_fibre_fault'|'whole_port'|'branch'|'single_onu',
 *   total:number, online:number, lost_signal:number, lost_power:number, offline_other:number,
 *   affected: number[], nearest_affected_m: number|null, farthest_affected_m: number|null,
 *   affected_without_distance: number
 * }}
 */
function analyse(onus) {
  const list = Array.isArray(onus) ? onus : [];
  const online = list.filter((o) => o.state === 'online');
  const offline = list.filter((o) => o.state !== 'online');
  const lostSignal = offline.filter((o) => causeKind(o.last_down_cause) === 'signal');
  const lostPower = offline.filter((o) => causeKind(o.last_down_cause) === 'power');
  const distances = lostSignal.map((o) => Number(o.distance_m)).filter((d) => Number.isFinite(d) && d > 0);

  let verdict;
  if (list.length === 0) verdict = 'no_onus';
  else if (lostSignal.length === 0) verdict = offline.length === 0 ? 'healthy' : 'no_fibre_fault';
  // Nobody has light: the shared fibre, or the port itself.
  else if (online.length === 0) verdict = 'whole_port';
  else if (lostSignal.length === 1) verdict = 'single_onu';
  else verdict = 'branch';

  return {
    verdict,
    total: list.length,
    online: online.length,
    lost_signal: lostSignal.length,
    lost_power: lostPower.length,
    offline_other: offline.length - lostSignal.length - lostPower.length,
    affected: lostSignal.map((o) => o.ont_id).sort((a, b) => a - b),
    nearest_affected_m: distances.length ? Math.min(...distances) : null,
    farthest_affected_m: distances.length ? Math.max(...distances) : null,
    affected_without_distance: lostSignal.length - distances.length,
  };
}

/**
 * Remember this read of a port. An online ONU's distance and signal replace
 * the stored ones; an offline ONU keeps what it had while it was online.
 * ONUs no longer on the port are forgotten.
 */
async function record(orgId, oltDeviceId, port, onus) {
  for (const o of onus) {
    const isOnline = o.state === 'online';
    await db.query(
      `INSERT INTO olt_onu_readings
         (organization_id, olt_device_id, port, ont_id, serial_number, model, description, state, last_down_cause,
          distance_m, rx_power_dbm, last_online_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isOnline ? 'NOW()' : 'NULL'}, NOW())
       ON DUPLICATE KEY UPDATE
         serial_number = VALUES(serial_number), model = VALUES(model), description = VALUES(description),
         state = VALUES(state), last_down_cause = VALUES(last_down_cause),
         distance_m = COALESCE(VALUES(distance_m), distance_m),
         rx_power_dbm = COALESCE(VALUES(rx_power_dbm), rx_power_dbm),
         last_online_at = COALESCE(VALUES(last_online_at), last_online_at),
         read_at = VALUES(read_at)`,
      [orgId, oltDeviceId, port, o.ont_id, o.serial_number || null, o.model || null,
        o.description ? String(o.description).slice(0, 100) : null, isOnline ? 'online' : 'offline',
        o.last_down_cause ? String(o.last_down_cause).slice(0, 40) : null,
        isOnline ? (o.distance_m ?? null) : null, isOnline ? (o.rx_power_dbm ?? null) : null],
    );
  }
  const ids = onus.map((o) => o.ont_id);
  await db.query(
    `DELETE FROM olt_onu_readings
      WHERE organization_id = ? AND olt_device_id = ? AND port = ?${ids.length ? ` AND ont_id NOT IN (${ids.map(() => '?').join(', ')})` : ''}`,
    [orgId, oltDeviceId, port, ...ids],
  );
}

async function stored(orgId, oltDeviceId, port) {
  const [rows] = await db.query(
    `SELECT ont_id, serial_number, model, description, state, last_down_cause, distance_m, rx_power_dbm, last_online_at
       FROM olt_onu_readings
      WHERE organization_id = ? AND olt_device_id = ? AND port = ?
      ORDER BY ont_id`,
    [orgId, oltDeviceId, port],
  );
  return rows.map((r) => ({
    ...r,
    distance_m: r.distance_m === null ? null : Number(r.distance_m),
    rx_power_dbm: r.rx_power_dbm === null ? null : Number(r.rx_power_dbm),
  }));
}

/**
 * Take a live read of a port (driver.onusOnPort), remember it, and judge the
 * fibre using each ONU's remembered distance.
 *
 * @returns {Promise<{fault: object, remembered: object[]}>}
 */
async function assess(orgId, oltDeviceId, live) {
  await record(orgId, oltDeviceId, live.port, live.onus);
  const remembered = await stored(orgId, oltDeviceId, live.port);
  return { fault: analyse(remembered), remembered };
}

module.exports = { analyse, assess, record, stored, causeKind };
