// =============================================================================
// VigaBSS 5.0 — provisioning ONUs on an OLT
// =============================================================================
// Authorise an ONU for a contract, change its speed, switch it off or on, and
// remove it. Every operation has two forms from the same code:
//
//   preview  builds the exact commands and returns them. It reads from the
//            OLT (which ONT ids are taken) but changes nothing.
//   apply    builds the same commands and sends them, stopping at the first
//            one the OLT refuses, and records what was sent and answered in
//            olt_operations.
//
// Speeds are traffic tables on the OLT, created once per speed in a range of
// indexes that belongs to VigaBSS (olt_connections.traffic_table_base) and
// remembered in olt_traffic_tables.
//
// A failed operation can leave the OLT part-configured (for example an ONU
// added but no service-port). Nothing is rolled back automatically: the log
// shows exactly which commands ran, and VigaBSS records the ONU only when
// the whole plan succeeded.
// =============================================================================

const db = require('../../config/database');
const { ValidationError, NotFoundError, AppError } = require('../../utils/errors');
const connections = require('./oltConnectionService');
const write = require('./huaweiMa5800Write');
const { failureOf } = require('./huaweiMa5800');
const logger = require('../../utils/logger').child({ service: 'oltProvisioning' });

const MAX_ONT_ID = 127;

function settings(conn) {
  const missing = ['line_profile_id', 'srv_profile_id', 'service_vlan', 'gem_port']
    .filter((f) => conn[f] === null || conn[f] === undefined);
  if (missing.length) {
    throw new ValidationError(`This OLT's provisioning settings are incomplete (${missing.join(', ')}). Fill them in first.`);
  }
  return conn;
}

function kbpsOf(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 64 || n > 10000000) throw new ValidationError(`${name} must be a whole number of kbps from 64 to 10000000`);
  return n;
}

/** Speeds for an ONU: given explicitly, or the plan speed of its contract. */
async function speedsFor(orgId, { contractId, upKbps, downKbps }) {
  if (upKbps !== undefined && upKbps !== null && downKbps !== undefined && downKbps !== null) {
    return { up: kbpsOf(upKbps, 'up_kbps'), down: kbpsOf(downKbps, 'down_kbps') };
  }
  if (!contractId) throw new ValidationError('Give the speeds, or a contract to take them from');
  const [rows] = await db.query(
    `SELECT p.upload_speed_mbps, p.download_speed_mbps
       FROM contracts c JOIN plans p ON p.id = c.plan_id AND p.deleted_at IS NULL
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL`,
    [contractId, orgId],
  );
  if (!rows[0]) throw new ValidationError('That contract does not exist, or its plan is gone');
  return { up: kbpsOf(Number(rows[0].upload_speed_mbps) * 1000, 'plan upload'), down: kbpsOf(Number(rows[0].download_speed_mbps) * 1000, 'plan download') };
}

async function assertContract(orgId, contractId) {
  if (contractId === undefined || contractId === null) return null;
  const [rows] = await db.query(
    'SELECT id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [contractId, orgId],
  );
  if (!rows[0]) throw new ValidationError('That contract does not exist');
  return Number(rows[0].id);
}

/**
 * The traffic table for a speed: the one VigaBSS already created on this
 * OLT, or the next free index in its range plus the steps that create it.
 * `taken` collects indexes claimed during this call so two new speeds do not
 * pick the same one.
 */
async function tableFor(orgId, oltId, conn, kbps, taken) {
  const [rows] = await db.query(
    'SELECT table_index, kbps FROM olt_traffic_tables WHERE organization_id = ? AND olt_device_id = ? ORDER BY table_index',
    [orgId, oltId],
  );
  const known = rows.find((r) => Number(r.kbps) === kbps);
  if (known) return { index: Number(known.table_index), steps: [], created: false };
  const pending = [...taken.entries()].find(([, speed]) => speed === kbps);
  if (pending) return { index: pending[0], steps: [], created: false };
  const used = new Set([...rows.map((r) => Number(r.table_index)), ...taken.keys()]);
  let index = Number(conn.traffic_table_base) || 200;
  while (used.has(index)) index += 1;
  if (index > 1023) throw new ValidationError('No traffic-table index is left in the range VigaBSS may use on this OLT');
  taken.set(index, kbps);
  return { index, steps: write.planTrafficTable({ index, name: `VIGA-${kbps}K`, kbps }), created: true, kbps };
}

async function recordTables(orgId, oltId, tables) {
  for (const t of tables.filter((x) => x.created)) {
    await db.query(
      'INSERT IGNORE INTO olt_traffic_tables (organization_id, olt_device_id, table_index, kbps) VALUES (?, ?, ?, ?)',
      [orgId, oltId, t.index, t.kbps],
    );
  }
}

async function log(orgId, oltId, kind, target, result, userId) {
  const failed = result.ok ? null : result.transcript[result.transcript.length - 1]?.failed || 'failed';
  await db.query(
    `INSERT INTO olt_operations (organization_id, olt_device_id, kind, port, ont_id, serial_number, contract_id, transcript, status, error, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, oltId, kind, target.port || null, target.ontId ?? null, target.serial || null, target.contractId || null,
      JSON.stringify(result.transcript), result.ok ? 'applied' : 'failed', failed ? String(failed).slice(0, 255) : null, userId || null],
  ).catch((err) => logger.error({ err: err.message, oltId, kind }, 'Could not record an OLT operation'));
}

/** Apply a plan on an open driver, log it, and turn a refusal into a 502 that carries the OLT's words. */
async function run(driver, orgId, oltId, kind, target, plan, userId) {
  const result = await write.apply(driver.session, plan);
  await log(orgId, oltId, kind, target, result, userId);
  if (!result.ok) {
    const last = result.transcript[result.transcript.length - 1];
    const err = new AppError(`The OLT refused "${last.command}": ${last.failed}`, 502, 'OLT_COMMAND_REFUSED');
    err.transcript = result.transcript;
    throw err;
  }
  return result;
}

const lines = (plan) => plan.map((s) => ({ command: s.command, note: s.note }));

/**
 * Authorise an ONU that is waiting on a PON port.
 * @param {object} input  port, serial, contractId?, upKbps?, downKbps?, description?
 * @param {{apply?: boolean, userId?: number}} opts
 */
async function authorise(orgId, oltId, input, { apply = false, userId = null } = {}) {
  const conn = settings((await connections.connectionRow(oltId, orgId)) || (() => { throw new ValidationError('This OLT has no login saved yet'); })());
  const serial = write.serialOf(input.serial);
  const contractId = await assertContract(orgId, input.contractId);
  const { up, down } = await speedsFor(orgId, { contractId, upKbps: input.upKbps, downKbps: input.downKbps });
  const description = write.descriptionOf(input.description || (contractId ? `contract-${contractId}` : `onu-${serial.slice(-8)}`));

  return connections.withDriver(oltId, orgId, async (driver) => {
    const live = await driver.onusOnPort(input.port);
    if (live.onus.some((o) => o.serial_number === serial)) {
      throw new ValidationError('That ONU is already authorised on this port');
    }
    const usedIds = new Set(live.onus.map((o) => o.ont_id));
    let ontId = 0;
    while (usedIds.has(ontId)) ontId += 1;
    if (ontId > MAX_ONT_ID) throw new ValidationError('This PON port has no free ONT id');

    const taken = new Map();
    const upTable = await tableFor(orgId, oltId, conn, up, taken);
    const downTable = await tableFor(orgId, oltId, conn, down, taken);
    const plan = [
      ...upTable.steps, ...downTable.steps,
      ...write.planAuthorise({
        port: live.port, ontId, serial, description,
        lineProfileId: conn.line_profile_id, srvProfileId: conn.srv_profile_id,
        vlan: conn.service_vlan, userVlan: conn.user_vlan ?? conn.service_vlan, gemPort: conn.gem_port,
        nativeVlanEthPort: conn.native_vlan_eth_port ?? undefined,
        upTableIndex: upTable.index, downTableIndex: downTable.index,
      }),
    ];
    const summary = { port: live.port, ont_id: ontId, serial_number: serial, contract_id: contractId, description, up_kbps: up, down_kbps: down };
    if (!apply) return { applied: false, ...summary, commands: lines(plan) };

    const target = { port: live.port, ontId, serial, contractId };
    await run(driver, orgId, oltId, 'authorise', target, plan, userId);
    await recordTables(orgId, oltId, [upTable, downTable]);
    // Which service-port the OLT gave it, for later speed changes and removal.
    let servicePortIndex = null;
    try {
      const out = await driver.session.run(`display service-port port ${live.port} ont ${ontId}`);
      if (!failureOf(out)) servicePortIndex = write.parseServicePorts(out)[0]?.index ?? null;
    } catch (err) {
      logger.warn({ err: err.message, oltId }, 'Could not read the new service-port index');
    }
    const [ins] = await db.query(
      `INSERT INTO olt_onus (organization_id, olt_device_id, port, ont_id, serial_number, contract_id, description, service_port_index, up_kbps, down_kbps, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE serial_number = VALUES(serial_number), contract_id = VALUES(contract_id), description = VALUES(description),
         service_port_index = VALUES(service_port_index), up_kbps = VALUES(up_kbps), down_kbps = VALUES(down_kbps), active = 1`,
      [orgId, oltId, live.port, ontId, serial, contractId, description, servicePortIndex, up, down, userId || null],
    );
    return { applied: true, id: ins.insertId || null, ...summary, service_port_index: servicePortIndex, commands: lines(plan) };
  });
}

async function managed(orgId, oltId, onuId) {
  const [rows] = await db.query(
    'SELECT * FROM olt_onus WHERE id = ? AND organization_id = ? AND olt_device_id = ?', [onuId, orgId, oltId],
  );
  if (!rows[0]) throw new NotFoundError('ONU');
  return rows[0];
}

async function list(orgId, oltId) {
  await connections.assertOlt(oltId, orgId);
  const [rows] = await db.query(
    `SELECT id, port, ont_id, serial_number, contract_id, description, service_port_index, up_kbps, down_kbps, active, created_at
       FROM olt_onus WHERE organization_id = ? AND olt_device_id = ? ORDER BY port, ont_id`,
    [orgId, oltId],
  );
  return rows.map((r) => ({ ...r, active: Boolean(Number(r.active)) }));
}

/** Change an ONU's speeds by replacing its service-port. */
async function setSpeed(orgId, oltId, onuId, input, { apply = false, userId = null } = {}) {
  const onu = await managed(orgId, oltId, onuId);
  const conn = settings(await connections.connectionRow(oltId, orgId));
  const { up, down } = await speedsFor(orgId, { contractId: onu.contract_id, upKbps: input.upKbps, downKbps: input.downKbps });
  if (onu.service_port_index === null || onu.service_port_index === undefined) {
    throw new ValidationError('The service-port of this ONU is not known, so its speed cannot be changed from here');
  }
  const taken = new Map();
  const upTable = await tableFor(orgId, oltId, conn, up, taken);
  const downTable = await tableFor(orgId, oltId, conn, down, taken);
  const plan = [
    ...upTable.steps, ...downTable.steps,
    ...write.planSetSpeed({
      port: onu.port, ontId: onu.ont_id, servicePortIndex: onu.service_port_index,
      vlan: conn.service_vlan, userVlan: conn.user_vlan ?? conn.service_vlan, gemPort: conn.gem_port,
      upTableIndex: upTable.index, downTableIndex: downTable.index,
    }),
  ];
  const summary = { id: onu.id, port: onu.port, ont_id: onu.ont_id, up_kbps: up, down_kbps: down };
  if (!apply) return { applied: false, ...summary, commands: lines(plan) };
  return connections.withDriver(oltId, orgId, async (driver) => {
    await run(driver, orgId, oltId, 'set_speed', { port: onu.port, ontId: onu.ont_id, serial: onu.serial_number, contractId: onu.contract_id }, plan, userId);
    await recordTables(orgId, oltId, [upTable, downTable]);
    await db.query('UPDATE olt_onus SET up_kbps = ?, down_kbps = ? WHERE id = ? AND organization_id = ?', [up, down, onu.id, orgId]);
    return { applied: true, ...summary, commands: lines(plan) };
  });
}

/** Switch an ONU off or back on. */
async function setActive(orgId, oltId, onuId, active, { apply = false, userId = null } = {}) {
  const onu = await managed(orgId, oltId, onuId);
  const plan = write.planSetActive({ port: onu.port, ontId: onu.ont_id, active: Boolean(active) });
  const summary = { id: onu.id, port: onu.port, ont_id: onu.ont_id, active: Boolean(active) };
  if (!apply) return { applied: false, ...summary, commands: lines(plan) };
  return connections.withDriver(oltId, orgId, async (driver) => {
    await run(driver, orgId, oltId, active ? 'activate' : 'deactivate', { port: onu.port, ontId: onu.ont_id, serial: onu.serial_number, contractId: onu.contract_id }, plan, userId);
    await db.query('UPDATE olt_onus SET active = ? WHERE id = ? AND organization_id = ?', [active ? 1 : 0, onu.id, orgId]);
    return { applied: true, ...summary, commands: lines(plan) };
  });
}

/** Remove an ONU from the OLT. Its service-ports are read from the OLT, not assumed. */
async function remove(orgId, oltId, onuId, { apply = false, userId = null } = {}) {
  const onu = await managed(orgId, oltId, onuId);
  return connections.withDriver(oltId, orgId, async (driver) => {
    const out = await driver.session.run(`display service-port port ${onu.port} ont ${onu.ont_id}`);
    const indexes = failureOf(out) ? [] : write.parseServicePorts(out).map((sp) => sp.index);
    const plan = write.planRemove({ port: onu.port, ontId: onu.ont_id, servicePortIndexes: indexes });
    const summary = { id: onu.id, port: onu.port, ont_id: onu.ont_id, service_ports: indexes };
    if (!apply) return { applied: false, ...summary, commands: lines(plan) };
    await run(driver, orgId, oltId, 'remove', { port: onu.port, ontId: onu.ont_id, serial: onu.serial_number, contractId: onu.contract_id }, plan, userId);
    await db.query('DELETE FROM olt_onus WHERE id = ? AND organization_id = ?', [onu.id, orgId]);
    return { applied: true, ...summary, commands: lines(plan) };
  });
}

async function operations(orgId, oltId, limit = 50) {
  await connections.assertOlt(oltId, orgId);
  const [rows] = await db.query(
    `SELECT id, kind, port, ont_id, serial_number, contract_id, transcript, status, error, created_by, created_at
       FROM olt_operations WHERE organization_id = ? AND olt_device_id = ? ORDER BY id DESC LIMIT ?`,
    [orgId, oltId, Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  return rows.map((r) => ({ ...r, transcript: typeof r.transcript === 'string' ? JSON.parse(r.transcript) : r.transcript }));
}

module.exports = { authorise, setSpeed, setActive, remove, list, operations, tableFor };
