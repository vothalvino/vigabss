// =============================================================================
// VigaBSS 5.0 — an OLT's saved login, and a live session opened from it
// =============================================================================
// olt_connections (migration 019) holds how to reach one OLT. Two rules:
//   - the password never leaves this module: reads return has_password only;
//   - the SSH host key seen on the first connection is saved and every later
//     connection must match it (cliSession.openSsh enforces it).
//
// One command-line session per OLT at a time: an OLT accepts few concurrent
// logins and its CLI is stateful, so calls for the same device queue here.
// =============================================================================

const db = require('../../config/database');
const { encrypt, decrypt } = require('../../utils/encryption');
const { assertManagementTarget } = require('../../utils/managementTarget');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const cli = require('./cliSession');
const { HuaweiMa5800 } = require('./huaweiMa5800');
const logger = require('../../utils/logger').child({ service: 'oltConnection' });

const DRIVERS = Object.freeze({ huawei_ma5800: HuaweiMa5800 });
const queues = new Map();

/** The OLT device, or 404. An OLT belongs to the caller's organization. */
async function oltDevice(deviceId, orgId) {
  const [rows] = await db.query(
    `SELECT id, name, model, manufacturer FROM devices
      WHERE id = ? AND organization_id = ? AND type = 'olt' AND deleted_at IS NULL LIMIT 1`,
    [deviceId, orgId],
  );
  if (!rows[0]) throw new NotFoundError('OLT device');
  return rows[0];
}

async function row(deviceId, orgId) {
  const [rows] = await db.query(
    'SELECT * FROM olt_connections WHERE device_id = ? AND organization_id = ? LIMIT 1',
    [deviceId, orgId],
  );
  return rows[0] || null;
}

/** What may be shown: everything but the password. */
function view(conn) {
  if (!conn) return { configured: false };
  return {
    configured: true,
    driver: conn.driver,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    has_password: Boolean(conn.password_encrypted),
    legacy_algorithms: Boolean(Number(conn.legacy_algorithms)),
    host_key_fingerprint: conn.host_key_fingerprint || null,
    last_checked_at: conn.last_checked_at || null,
    last_check_ok: conn.last_check_ok === null || conn.last_check_ok === undefined ? null : Boolean(Number(conn.last_check_ok)),
    last_check_message: conn.last_check_message || null,
  };
}

async function get(deviceId, orgId) {
  await oltDevice(deviceId, orgId);
  return view(await row(deviceId, orgId));
}

/**
 * Create or change the saved login. A blank password keeps the saved one.
 * Changing the address forgets the pinned host key: it is another machine.
 */
async function save(deviceId, orgId, body) {
  await oltDevice(deviceId, orgId);
  const existing = await row(deviceId, orgId);
  const host = String(body.host ?? existing?.host ?? '').trim();
  assertManagementTarget(host, 'host');
  const port = body.port === undefined || body.port === null || body.port === '' ? (existing?.port || 22) : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('port must be between 1 and 65535');
  const username = String(body.username ?? existing?.username ?? '').trim();
  if (!username || username.length > 64 || /[\x00-\x20\x7f]/.test(username)) { // eslint-disable-line no-control-regex
    throw new ValidationError('username is required, without spaces');
  }
  const driver = body.driver ?? existing?.driver ?? 'huawei_ma5800';
  if (!Object.hasOwn(DRIVERS, driver)) throw new ValidationError('driver is not supported');
  const newPassword = typeof body.password === 'string' && body.password !== '' ? body.password : null;
  if (!existing && !newPassword) throw new ValidationError('password is required');
  const legacy = body.legacy_algorithms === undefined ? Number(existing?.legacy_algorithms || 0) : (body.legacy_algorithms ? 1 : 0);

  if (!existing) {
    await db.query(
      `INSERT INTO olt_connections (organization_id, device_id, driver, host, port, username, password_encrypted, legacy_algorithms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, deviceId, driver, host, port, username, encrypt(newPassword), legacy],
    );
  } else {
    const moved = host !== existing.host || port !== Number(existing.port);
    await db.query(
      `UPDATE olt_connections
          SET driver = ?, host = ?, port = ?, username = ?, password_encrypted = ?, legacy_algorithms = ?,
              host_key_fingerprint = ?
        WHERE device_id = ? AND organization_id = ?`,
      [driver, host, port, username, newPassword ? encrypt(newPassword) : existing.password_encrypted, legacy,
        moved ? null : existing.host_key_fingerprint, deviceId, orgId],
    );
  }
  return view(await row(deviceId, orgId));
}

/** Forget the pinned host key (the OLT was replaced or reset). The next connection pins the new one. */
async function forgetHostKey(deviceId, orgId) {
  await oltDevice(deviceId, orgId);
  await db.query(
    'UPDATE olt_connections SET host_key_fingerprint = NULL WHERE device_id = ? AND organization_id = ?',
    [deviceId, orgId],
  );
  return view(await row(deviceId, orgId));
}

async function remove(deviceId, orgId) {
  await oltDevice(deviceId, orgId);
  await db.query('DELETE FROM olt_connections WHERE device_id = ? AND organization_id = ?', [deviceId, orgId]);
}

async function recordCheck(deviceId, orgId, ok, message) {
  await db.query(
    `UPDATE olt_connections SET last_checked_at = NOW(), last_check_ok = ?, last_check_message = ?
      WHERE device_id = ? AND organization_id = ?`,
    [ok ? 1 : 0, String(message || '').slice(0, 255), deviceId, orgId],
  ).catch(() => {});
}

/**
 * Run `work(driver)` on a live session to this OLT, then close it.
 * Calls for the same OLT run one after another.
 *
 * @template T
 * @param {number|string} deviceId
 * @param {number} orgId
 * @param {(driver: object) => Promise<T>} work
 * @param {{ open?: Function }} [deps]  for tests
 * @returns {Promise<T>}
 */
function withDriver(deviceId, orgId, work, { open = cli.openSsh } = {}) {
  const key = `${orgId}:${deviceId}`;
  const run = async () => {
    await oltDevice(deviceId, orgId);
    const conn = await row(deviceId, orgId);
    if (!conn) throw new ValidationError('This OLT has no login saved yet. Add its address, user and password first.');
    let opened;
    try {
      opened = await open({
        host: conn.host,
        port: conn.port,
        username: conn.username,
        password: decrypt(conn.password_encrypted),
        hostKeyFingerprint: conn.host_key_fingerprint || null,
        legacyAlgorithms: Boolean(Number(conn.legacy_algorithms)),
      });
    } catch (err) {
      await recordCheck(deviceId, orgId, false, err.message);
      throw err;
    }
    try {
      // First successful connection: pin the key that was presented.
      if (!conn.host_key_fingerprint && opened.hostKeyFingerprint) {
        await db.query(
          'UPDATE olt_connections SET host_key_fingerprint = ? WHERE device_id = ? AND organization_id = ? AND host_key_fingerprint IS NULL',
          [opened.hostKeyFingerprint, deviceId, orgId],
        );
      }
      const driver = new DRIVERS[conn.driver](opened.session);
      await driver.prepare();
      const result = await work(driver);
      await recordCheck(deviceId, orgId, true, 'Connected');
      return result;
    } catch (err) {
      await recordCheck(deviceId, orgId, false, err.message);
      logger.warn({ deviceId, code: err.code, err: err.message }, 'OLT session failed');
      throw err;
    } finally {
      opened.session.close();
    }
  };
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  const tracked = next.finally(() => { if (queues.get(key) === tracked) queues.delete(key); });
  tracked.catch(() => {});
  queues.set(key, tracked);
  return next;
}

module.exports = { get, save, remove, forgetHostKey, withDriver, view, DRIVERS };
