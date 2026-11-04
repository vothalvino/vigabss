// =============================================================================
// VigaBSS 5.0 — Router Driver Service (§18.3)
// =============================================================================
// Vendor-agnostic router command dispatch. The vendor's driver comes from the
// registry in ./drivers (NET-30); today only MikroTik RouterOS has one. A
// vendor without a driver records a device_command_executions row with
// status='not_dispatched': nothing was sent to the device, and the row says so.
//
// Credentials are stored AES-256-GCM encrypted via src/utils/encryption.js.
// =============================================================================

const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const { redactSecretParams } = require('../utils/secretRedaction');
const { getDriver } = require('./drivers');
const logger = require('../utils/logger').child({ service: 'routerDriverService' });

/** The driver connection for a router_driver_configs row. */
function configConnection(driver, config) {
  return driver.toConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.encrypted_password ? decrypt(config.encrypted_password) : null,
    secure: Boolean(config.ssl_enabled),
    timeoutMs: config.timeout_ms,
  });
}

/**
 * Create a router driver config, encrypting sensitive credentials.
 */
async function createDriverConfig(organizationId, data, userId) {
  const encPassword = data.password ? encrypt(data.password) : null;
  const encToken    = data.api_token ? encrypt(data.api_token) : null;

  const [result] = await db.query(
    `INSERT INTO router_driver_configs
       (organization_id, device_id, vendor, protocol, host, port, username,
        encrypted_password, api_token, ssl_enabled, ssl_verify, timeout_ms,
        extra_params, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [organizationId, data.device_id || null, data.vendor || 'mikrotik',
      data.protocol || 'routeros_api', data.host || null,
      data.port || 8728, data.username || null,
      encPassword, encToken,
      data.ssl_enabled ? 1 : 0, data.ssl_verify !== false ? 1 : 0,
      data.timeout_ms || 10000,
      data.extra_params ? JSON.stringify(data.extra_params) : null,
      userId || null],
  );
  const [rows] = await db.query(
    'SELECT * FROM router_driver_configs WHERE id = ?', [result.insertId],
  );
  return sanitizeConfig(rows[0]);
}

/**
 * Update a router driver config.
 */
async function updateDriverConfig(configId, organizationId, data) {
  const fields = [];
  const params = [];
  const allowed = ['vendor', 'protocol', 'host', 'port', 'username', 'ssl_enabled', 'ssl_verify', 'timeout_ms', 'extra_params', 'is_active'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`\`${key}\` = ?`);
      params.push(key === 'extra_params' && typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (data.password) {
    fields.push('encrypted_password = ?');
    params.push(encrypt(data.password));
  }
  if (data.api_token) {
    fields.push('api_token = ?');
    params.push(encrypt(data.api_token));
  }
  if (!fields.length) {
    const [rows] = await db.query('SELECT * FROM router_driver_configs WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [configId, organizationId]);
    return rows.length ? sanitizeConfig(rows[0]) : null;
  }
  params.push(configId, organizationId);
  await db.query(
    `UPDATE router_driver_configs SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    params,
  );
  // Scoped like the UPDATE: an id-only read returned another tenant's config (RTE-02).
  const [rows] = await db.query('SELECT * FROM router_driver_configs WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [configId, organizationId]);
  return rows.length ? sanitizeConfig(rows[0]) : null;
}

/**
 * Test connectivity to a router through its vendor driver; a vendor with no
 * driver reports not_implemented.
 */
async function testDriverConnection(configId, organizationId) {
  const [configs] = await db.query(
    'SELECT * FROM router_driver_configs WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [configId, organizationId],
  );
  if (!configs.length) return null;

  const config = configs[0];
  const driver = getDriver(config.vendor);

  let testStatus = 'failed';
  let testMessage;

  if (driver) {
    try {
      ({ status: testStatus, message: testMessage } = await driver.test(configConnection(driver, config)));
    } catch (err) {
      testMessage = err.message;
      logger.warn({ configId, vendor: config.vendor, err }, 'Driver connection test failed');
    }
  } else {
    // No driver for this vendor: report honestly rather than test nothing.
    testStatus = 'not_implemented';
    testMessage = `Vendor '${config.vendor}' driver is not implemented — no live connection test available`;
    logger.info({ configId, vendor: config.vendor }, 'Driver test: not_implemented');
  }

  await db.query(
    'UPDATE router_driver_configs SET last_tested_at = NOW(), last_test_status = ? WHERE id = ?',
    [testStatus, configId],
  );

  return { status: testStatus, message: testMessage };
}

/**
 * Dispatch a command to a router through its vendor driver. A vendor with no
 * driver records device_command_executions with status='not_dispatched'.
 */
async function dispatchCommand(configId, organizationId, command, params = {}, executedBy = null) {
  const [configs] = await db.query(
    'SELECT * FROM router_driver_configs WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [configId, organizationId],
  );
  if (!configs.length) return null;

  const config = configs[0];
  const start = Date.now();
  let status;
  let response = null;
  let errorMessage = null;

  const driver = getDriver(config.vendor);
  if (driver) {
    try {
      const handler = Object.prototype.hasOwnProperty.call(driver.commands, command) ? driver.commands[command] : null;
      // Unmapped commands must NOT report success — an unknown command was
      // never sent to the device, so recording 'success' would be a silent
      // no-op that reads as a real action (e.g. a reboot that never fired).
      if (!handler) throw new Error(`Command '${command}' is not mapped to a ${config.vendor} handler`);
      response = await handler(configConnection(driver, config), params);
      status = 'success';
    } catch (err) {
      status = 'failure';
      errorMessage = err.message;
      logger.error({ configId, vendor: config.vendor, command, err }, 'Driver command dispatch failed');
    }
  } else {
    // No driver for this vendor — record as not_dispatched and surface clearly
    status = 'not_dispatched';
    errorMessage = `Vendor '${config.vendor}' driver is not implemented — command '${command}' was NOT sent to the device`;
    response = { dispatched: false, reason: `${config.vendor} driver not implemented` };
    logger.warn({ configId, vendor: config.vendor, command }, 'Command not dispatched: driver not implemented');
  }

  const duration = Date.now() - start;
  const [execResult] = await db.query(
    `INSERT INTO device_command_executions
       (organization_id, driver_config_id, device_id, vendor, command, params,
        status, response, error_message, duration_ms, executed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [organizationId, configId, config.device_id, config.vendor, command,
      JSON.stringify(redactSecretParams(params)), status, response ? JSON.stringify(response) : null,
      errorMessage, duration, executedBy || null],
  );

  return {
    execution_id: execResult.insertId,
    vendor: config.vendor,
    command,
    status,
    response,
    error_message: errorMessage,
    duration_ms: duration,
  };
}

/**
 * Strip encrypted fields from config before returning to API.
 */
function sanitizeConfig(config) {
  if (!config) return null;
  const { encrypted_password, api_token, ...rest } = config;
  // extra_params is free-form vendor config and can carry a secret (an enable
  // password, a token); redact secret-named keys on the way out.
  if (rest.extra_params !== undefined && rest.extra_params !== null) {
    rest.extra_params = redactSecretParams(rest.extra_params);
  }
  return { ...rest, has_password: Boolean(encrypted_password), has_api_token: Boolean(api_token) };
}

module.exports = {
  createDriverConfig,
  updateDriverConfig,
  testDriverConnection,
  dispatchCommand,
  sanitizeConfig,
};
