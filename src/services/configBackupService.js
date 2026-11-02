// =============================================================================
// VigaBSS 5.0 — Config Backup Service
// =============================================================================
// Provides functions to pull RouterOS configuration backups from remote
// MikroTik devices via the FireRelay WebSocket tunnel and persist them to
// the device_config_backups table.
//
// Environment variables used for nightly pulls:
//   ROUTEROS_API_USER       — RouterOS API username (default: 'admin')
//   ROUTEROS_API_PASSWORD   — RouterOS API password (required for nightly run)
//   ROUTEROS_API_PORT       — RouterOS API port (default: 8728)
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const { orgScopeFilter } = require('./organizationFanOut');
const { tunnelServer } = require('./firerelayTunnel');
const logger = require('../utils/logger').child({ service: 'configBackupService' });
const { NotFoundError } = require('../utils/errors');
const { requireOrgId } = require('../utils/requireOrgId');
const { compileSafeRegex, MAX_REGEX_SUBJECT_LENGTH } = require('../utils/safeRegex');

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Return the latest version number for a device's config backups (or 0 if none).
 * @param {number} deviceId
 * @returns {Promise<number>}
 */
async function getLatestVersion(deviceId) {
  // NOTE: intentionally does NOT filter deleted_at — version numbers must stay
  // monotonic across soft-deleted backups so the (device_id, version) unique key
  // (now deleted_at-aware, migration 361) never collides on a recycled version.
  const [rows] = await db.query(
    'SELECT version FROM device_config_backups WHERE device_id = ? ORDER BY version DESC LIMIT 1',
    [deviceId],
  );
  return rows.length > 0 ? rows[0].version : 0;
}

/**
 * Return the checksum of the most recent backup for a device (or null if none).
 * @param {number} deviceId
 * @returns {Promise<string|null>}
 */
async function getLatestChecksum(deviceId) {
  const [rows] = await db.query(
    'SELECT checksum FROM device_config_backups WHERE device_id = ? ORDER BY version DESC LIMIT 1',
    [deviceId],
  );
  return rows.length > 0 ? rows[0].checksum : null;
}

/**
 * Compute the SHA-256 hex digest of a string.
 * @param {string} content
 * @returns {string}
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Pull a config backup for a single device via the FireRelay tunnel and store
 * it in device_config_backups.
 *
 * Deduplication: if the new checksum matches the latest stored backup, no new
 * row is written and the function returns { skipped: true }.
 *
 * @param {object} opts
 * @param {number}  opts.deviceId         - devices.id
 * @param {string}  opts.nodeId           - FireRelay agent node_id to route to
 * @param {string}  opts.host             - MikroTik device IP address
 * @param {string}  opts.user             - RouterOS API username
 * @param {string}  opts.password         - RouterOS API password
 * @param {number}  [opts.port]           - RouterOS API port (default 8728)
 * @param {boolean} [opts.compact]        - Use compact export (default false)
 * @param {string}  [opts.captureMethod]  - 'manual' | 'scheduled' (default 'scheduled')
 * @param {number|null} [opts.capturedByUserId] - User who triggered; null = system
 * @param {string}  [opts.notes]          - Optional notes
 * @returns {Promise<{ backupId: number, version: number, skipped: boolean, checksum: string }>}
 */
async function pullBackupForDevice({
  deviceId,
  nodeId,
  host,
  user,
  password,
  port,
  compact = false,
  captureMethod = 'scheduled',
  capturedByUserId = null,
  notes = null,
}) {
  if (!deviceId) throw new Error('deviceId is required');
  if (!nodeId) throw new Error('nodeId is required');
  if (!host) throw new Error('host is required');
  if (!user) throw new Error('user is required');
  if (password === undefined || password === null) throw new Error('password is required');

  // Send config.backup command through the tunnel
  const params = { host, user, password, compact };
  if (port) params.port = port;

  const { content, configType } = await tunnelServer.sendCommand(nodeId, 'config.backup', params);

  const checksum = sha256(content);
  const fileSize = Buffer.byteLength(content, 'utf8');

  // Deduplication: skip if content hasn't changed
  const latestChecksum = await getLatestChecksum(deviceId);
  if (latestChecksum && latestChecksum === checksum) {
    logger.debug({ deviceId, nodeId, checksum }, 'Config backup unchanged — skipping');
    return { backupId: null, version: null, skipped: true, checksum };
  }

  const nextVersion = (await getLatestVersion(deviceId)) + 1;

  const [result] = await db.query(
    // organization_id is derived from the device in the statement itself rather
    // than passed in: this is the nightly unattended pull, it has no request
    // context to take req.orgId from, and a subquery cannot drift from the
    // parent the way a caller-supplied value can. The column is deliberately
    // NULLABLE (migration 425): it mirrors devices.organization_id, which is
    // NULL on single-tenant installs, so a NULL here means "single-tenant", not
    // "unattributed". Org-bound reads therefore use the null-safe `<=>`.
    `INSERT INTO device_config_backups
       (organization_id, device_id, version, config_type, content, file_size, checksum,
        capture_method, captured_by_user_id, notes)
     VALUES ((SELECT organization_id FROM devices WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deviceId,
      deviceId,
      nextVersion,
      configType,
      content,
      fileSize,
      checksum,
      captureMethod,
      capturedByUserId,
      notes,
    ],
  );

  logger.info(
    { deviceId, nodeId, version: nextVersion, configType, fileSize, checksum },
    'Config backup stored',
  );

  return {
    backupId: result.insertId,
    version: nextVersion,
    skipped: false,
    checksum,
    configType,
    fileSize,
  };
}

/**
 * Run nightly automated config backup pull for all eligible devices.
 *
 * Eligible devices: deleted_at IS NULL, firerelay_node_id IS NOT NULL,
 * ip_address IS NOT NULL.
 *
 * RouterOS credentials come from environment variables:
 *   ROUTEROS_API_USER     (default 'admin')
 *   ROUTEROS_API_PASSWORD (required)
 *   ROUTEROS_API_PORT     (default 8728)
 *
 * Per-device errors are logged and counted but do not abort the entire run.
 *
 * @param {number|null} [organizationId] - one organization's devices, or (null) every
 *        device of the current database scope; taskRunner runs the null case
 *        once per database, so isolated tenants are backed up too (NET-15)
 * @returns {Promise<{ total: number, backed_up: number, skipped: number, failed: number }>}
 */
async function runNightlyBackups(organizationId = null) {
  const user = process.env.ROUTEROS_API_USER || 'admin';
  const password = process.env.ROUTEROS_API_PASSWORD;
  const port = process.env.ROUTEROS_API_PORT ? parseInt(process.env.ROUTEROS_API_PORT, 10) : undefined;

  if (!password) {
    logger.warn('ROUTEROS_API_PASSWORD not set — config_backup_pull task will not run');
    return { total: 0, backed_up: 0, skipped: 0, failed: 0 };
  }

  // The device's own organization decides, not a client's: POP and backbone
  // devices have no client and were dropped by the old clients join (NET-15).
  const scope = orgScopeFilter('d.organization_id', organizationId);
  const [devices] = await db.query(
    `SELECT d.id, d.name, d.ip_address, d.firerelay_node_id
       FROM devices d
      WHERE d.firerelay_node_id IS NOT NULL
        AND d.ip_address IS NOT NULL
        AND d.deleted_at IS NULL${scope.sql}`,
    scope.params,
  );

  const stats = { total: devices.length, backed_up: 0, skipped: 0, failed: 0 };

  for (const device of devices) {
    if (!tunnelServer.isConnected(device.firerelay_node_id)) {
      logger.warn(
        { deviceId: device.id, nodeId: device.firerelay_node_id },
        'Agent not connected — skipping device config backup',
      );
      stats.failed += 1;
      continue;
    }

    try {
      const result = await pullBackupForDevice({
        deviceId: device.id,
        nodeId: device.firerelay_node_id,
        host: device.ip_address,
        user,
        password,
        port,
        captureMethod: 'scheduled',
      });

      if (result.skipped) {
        stats.skipped += 1;
      } else {
        stats.backed_up += 1;
      }
    } catch (err) {
      logger.error(
        { deviceId: device.id, nodeId: device.firerelay_node_id, err: err.message },
        'Config backup failed for device',
      );
      stats.failed += 1;
    }
  }

  logger.info(stats, 'Nightly config backup pull complete');
  return stats;
}

// =============================================================================
// §6.6 Config Management Extensions
// =============================================================================

/**
 * Compute a simple line-based diff between two config strings.
 * Returns empty string if content is identical.
 * Lines removed from prev are prefixed with '-', lines added in curr with '+'.
 * @param {string} previousContent
 * @param {string} currentContent
 * @returns {string}
 */
function computeDiff(previousContent, currentContent) {
  if (previousContent === currentContent) return '';
  const prev = previousContent.split('\n');
  const curr = currentContent.split('\n');
  const lines = [];
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  for (const line of prev) {
    if (!currSet.has(line)) lines.push(`-${line}`);
  }
  for (const line of curr) {
    if (!prevSet.has(line)) lines.push(`+${line}`);
  }
  return lines.join('\n');
}

/**
 * Evaluate a single compliance rule against backup content.
 * Regex rules go through compileSafeRegex (length cap + nested-quantifier /
 * backreference rejection) and a subject-length cap; a rejected pattern or an
 * oversized subject yields result 'error' instead of running the regex.
 *
 * @param {{ rule_type: string, pattern: string }} rule
 * @param {string} content
 * @returns {{ result: 'pass'|'fail'|'error', details: string }}
 */
function evaluateRule(rule, content) {
  const { rule_type, pattern } = rule;
  if (rule_type === 'must_contain') {
    const found = content.includes(pattern);
    return found
      ? { result: 'pass', details: `Pattern found: ${pattern}` }
      : { result: 'fail', details: `Pattern not found: ${pattern}` };
  }
  if (rule_type === 'must_not_contain') {
    const found = content.includes(pattern);
    return !found
      ? { result: 'pass', details: `Forbidden pattern absent: ${pattern}` }
      : { result: 'fail', details: `Forbidden pattern found: ${pattern}` };
  }
  if (rule_type === 'regex_match' || rule_type === 'regex_not_match') {
    const compiled = compileSafeRegex(pattern);
    if (!compiled.ok) {
      return { result: 'error', details: `Rule evaluation error: unsafe or invalid regex rejected (${compiled.reason})` };
    }
    if (content.length > MAX_REGEX_SUBJECT_LENGTH) {
      return {
        result: 'error',
        details: `Rule evaluation error: config content (${content.length} chars) exceeds the ${MAX_REGEX_SUBJECT_LENGTH}-char regex evaluation limit`,
      };
    }
    const matched = compiled.regex.test(content);
    if (rule_type === 'regex_match') {
      return matched
        ? { result: 'pass', details: `Regex matched: ${pattern}` }
        : { result: 'fail', details: `Regex did not match: ${pattern}` };
    }
    return !matched
      ? { result: 'pass', details: `Regex absent (good): ${pattern}` }
      : { result: 'fail', details: `Regex matched (violation): ${pattern}` };
  }
  // Unknown rule types were previously recorded as a silent 'fail' with empty
  // details; keep the 'fail' outcome but say why.
  return { result: 'fail', details: `Unknown rule type: ${rule_type}` };
}

/**
 * Run a compliance audit on a backup, evaluating all enabled compliance rules
 * for the org against the backup content. Inserts result rows.
 *
 * Tenant boundary: the backup is loaded only if it belongs to organizationId
 * (NotFoundError otherwise, before any result row is written), and the device
 * lookup is bound to the same org. organization_id is nullable on both tables
 * (single-tenant installs, migration 425), so the predicate uses the null-safe
 * `<=>`; HTTP callers always pass a non-null req.orgId (orgScope rejects a
 * request without one), so a NULL-org row is never reachable from a tenant.
 *
 * @param {number} backupId
 * @param {number|null} organizationId
 * @returns {Promise<{ total: number, passed: number, failed: number }>}
 */
async function runComplianceAudit(backupId, organizationId) {
  // Load backup — org-bound, and soft-deleted backups are not auditable.
  const [backupRows] = await db.query(
    `SELECT id, device_id, content FROM device_config_backups WHERE id = ?
        AND organization_id <=> ? AND deleted_at IS NULL`,
    [backupId, organizationId],
  );
  if (backupRows.length === 0) throw new NotFoundError('device_config_backups');
  const backup = backupRows[0];

  // Load device type for filtering (defence in depth: same org as the backup).
  const [deviceRows] = await db.query(
    'SELECT id, type AS device_type FROM devices WHERE id = ? AND organization_id <=> ?',
    [backup.device_id, organizationId],
  );
  const deviceType = deviceRows.length > 0 ? deviceRows[0].device_type : null;

  // Load enabled compliance rules for org
  const [rules] = await db.query(
    `SELECT id, rule_type, pattern, applies_to_device_type
     FROM config_compliance_rules
     WHERE (organization_id = ? OR organization_id IS NULL)
       AND is_enabled = 1
       AND deleted_at IS NULL
       AND (applies_to_device_type IS NULL OR applies_to_device_type = ?)`,
    [organizationId, deviceType],
  );

  const stats = { total: rules.length, passed: 0, failed: 0 };
  const content = typeof backup.content === 'string' ? backup.content : String(backup.content ?? '');

  for (const rule of rules) {
    let result;
    let details;
    try {
      ({ result, details } = evaluateRule(rule, content));
    } catch (err) {
      result = 'error';
      details = `Rule evaluation error: ${err.message}`;
    }

    await db.query(
      `INSERT INTO config_compliance_results (rule_id, backup_id, device_id, result, details, evaluated_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [rule.id, backupId, backup.device_id, result, details],
    );

    if (result === 'pass') stats.passed += 1;
    else stats.failed += 1;
  }

  return stats;
}

/**
 * Pull a backup and then compute + store the diff vs the previous version.
 * Wraps pullBackupForDevice with diff calculation.
 *
 * @param {object} opts - same options as pullBackupForDevice
 * @returns {Promise<object>} - same result as pullBackupForDevice
 */
async function pullBackupWithDiff(opts) {
  // Get previous content before the new backup is inserted
  const [prevRows] = await db.query(
    'SELECT content FROM device_config_backups WHERE device_id = ? ORDER BY version DESC LIMIT 1',
    [opts.deviceId],
  );
  const prevContent = prevRows.length > 0 ? prevRows[0].content : null;

  const result = await pullBackupForDevice(opts);
  if (result.skipped || !result.backupId) return result;

  if (prevContent !== null) {
    // Get new content
    const [newRows] = await db.query(
      'SELECT content FROM device_config_backups WHERE id = ?',
      [result.backupId],
    );
    if (newRows.length > 0) {
      const diffText = computeDiff(prevContent, newRows[0].content);
      await db.query(
        'UPDATE device_config_backups SET diff_from_previous = ? WHERE id = ?',
        [diffText, result.backupId],
      );
    }
  }

  return result;
}

/**
 * Message stored on, and returned with, every deployment record. No
 * config-push mechanism is wired today: routerosService has no import/apply
 * handler, the FireRelay agent exposes no such command, and
 * routerDriverService maps no "apply config" command. A deployment therefore
 * renders the template and is recorded as 'pending'. It is NEVER 'success',
 * because nothing reached the device.
 */
const DEPLOY_NOT_PUSHED_MESSAGE =
  'Automatic push is not available yet; apply the rendered config manually';

/**
 * Render a config template for a device in the caller's organization and
 * record the deployment request. No live push is performed (see
 * DEPLOY_NOT_PUSHED_MESSAGE): the record is written with status 'pending' and
 * deployed_at/completed_at NULL, and the rendered config is returned so an
 * operator can apply it by hand.
 *
 * Both lookups bind the caller's organization with the null-safe `<=>` (both
 * columns are nullable; NULL means a single-tenant install). That matches the
 * GET /config-templates list, which only shows the caller's own templates.
 *
 * @param {number} templateId
 * @param {number} deviceId
 * @param {object|null} variables - key/value pairs for {{variable}} substitution
 * @param {number|null} deployedBy - user id who triggered the deployment
 * @param {number|null} orgId - the caller's organization (req.orgId)
 * @returns {Promise<object>} deployment record plus rendered_config
 * @throws {NotFoundError} template or device not in the caller's organization
 */
async function deployConfigTemplate(templateId, deviceId, variables, deployedBy, orgId) {
  requireOrgId(orgId, 'deployConfigTemplate');

  const [templateRows] = await db.query(
    'SELECT id, organization_id, template_content, status FROM config_templates WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
    [templateId, orgId],
  );
  if (templateRows.length === 0) throw new NotFoundError('config_templates');
  const template = templateRows[0];

  const [deviceRows] = await db.query(
    'SELECT id FROM devices WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
    [deviceId, orgId],
  );
  if (deviceRows.length === 0) throw new NotFoundError('devices');

  // Render template
  let rendered = template.template_content;
  if (variables && typeof variables === 'object') {
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.split(`{{${key}}}`).join(String(value));
    }
  }

  const status = 'pending';
  const resultOutput = DEPLOY_NOT_PUSHED_MESSAGE;

  // deployed_at / completed_at stay NULL: nothing was deployed or completed.
  const [ins] = await db.query(
    `INSERT INTO config_deployment_records
       (organization_id, template_id, device_id, deployed_by, status, variables_used, result_output)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      template.organization_id,
      templateId,
      deviceId,
      deployedBy ?? null,
      status,
      variables ? JSON.stringify(variables) : null,
      resultOutput,
    ],
  );

  logger.info(
    { templateId, deviceId, deployedBy, deploymentId: ins.insertId },
    'Config template rendered; automatic push not available, recorded as pending',
  );

  return {
    id: ins.insertId,
    template_id: templateId,
    device_id: deviceId,
    deployed_by: deployedBy,
    status,
    push_performed: false,
    result_output: resultOutput,
    variables_used: variables,
    rendered_config: rendered,
  };
}

module.exports = {
  pullBackupForDevice,
  runNightlyBackups,
  computeDiff,
  runComplianceAudit,
  evaluateRule,
  pullBackupWithDiff,
  deployConfigTemplate,
  DEPLOY_NOT_PUSHED_MESSAGE,
  // exported for testing
  sha256,
  getLatestVersion,
  getLatestChecksum,
};
