// =============================================================================
// VigaBSS 5.0 — CWMP Session State Machine (§8.1)
// =============================================================================
'use strict';

const db = require('../config/database');
const _CpeDevice = require('../models/CpeDevice');
const _CpeParameter = require('../models/CpeParameter');
const CpeTask = require('../models/CpeTask');
const cpeProfileService = require('./cpeProfileService');
const { buildCwmpResponse } = require('./cwmpXml');
const logger = require('../utils/logger').child({ service: 'cwmpSessionService' });

// ---------------------------------------------------------------------------
// handleInform
// ---------------------------------------------------------------------------

/**
 * Process an Inform message: upsert CPE device, sync parameters, trigger ZTP.
 * @param {object} cpeDevice - existing or newly-created cpe_devices row
 * @param {object} informPayload - parsed payload from parseCwmpEnvelope for Inform
 * @param {number|null} orgId
 */
async function handleInform(cpeDevice, informPayload, orgId) {
  const { deviceId: cwmpDeviceId, parameters } = informPayload;
  const wasNew = cpeDevice.status === 'new';

  // Update device fields from Inform
  const updates = {
    status: 'active',
    last_inform_at: new Date(),
    software_version: cwmpDeviceId.swVersion || cpeDevice.software_version,
    hardware_version: cwmpDeviceId.hwVersion || cpeDevice.hardware_version,
  };
  await db.query(
    `UPDATE cpe_devices SET status = ?, last_inform_at = NOW(),
      software_version = COALESCE(?, software_version),
      hardware_version = COALESCE(?, hardware_version)
     WHERE id = ?`,
    [updates.status, updates.software_version, updates.hardware_version, cpeDevice.id],
  );

  // Upsert reported parameters
  if (parameters && parameters.length > 0) {
    for (const param of parameters) {
      if (!param.name) continue;
      await db.query(
        `INSERT INTO cpe_parameters (cpe_device_id, organization_id, parameter_path, parameter_value, last_fetched_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE parameter_value = VALUES(parameter_value), last_fetched_at = NOW()`,
        [cpeDevice.id, orgId, param.name, param.value || null],
      );
    }
  }

  // Zero-touch provisioning on first boot
  if (wasNew) {
    applyZeroTouchProvisioning(cpeDevice, orgId).catch(err =>
      logger.warn({ err: err.message, cpeDeviceId: cpeDevice.id }, 'ZTP failed'),
    );
  }
}

// ---------------------------------------------------------------------------
// getNextTask
// ---------------------------------------------------------------------------

/**
 * Get the next queued task for a CPE device (lowest priority number = highest urgency).
 * @param {number} cpeDeviceId
 * @returns {object|null}
 */
async function getNextTask(cpeDeviceId) {
  const [rows] = await db.query(
    `SELECT * FROM cpe_tasks
     WHERE cpe_device_id = ? AND status = 'queued'
     ORDER BY priority ASC, queued_at ASC
     LIMIT 1`,
    [cpeDeviceId],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// buildResponseForTask
// ---------------------------------------------------------------------------

/**
 * Convert a cpe_tasks row into a CWMP XML response string.
 * @param {object} task
 * @returns {string} XML
 */
/**
 * The ParameterValueStruct list of a set_parameter_values task, whatever shape
 * it was stored in: a list of {name, value, type}, the {parameters: [...]}
 * wrapper the portal and WhatsApp Wi-Fi reset wrote, or a {path: value} map
 * (the shape POST /cpe-management/devices/:id/tasks accepted). Anything else
 * yielded an empty list, so the CPE got a SetParameterValues with nothing in
 * it and the task still completed (NET-12).
 */
function setParameterList(params) {
  const list = Array.isArray(params) ? params
    : (params && Array.isArray(params.parameters) ? params.parameters : null);
  if (list) {
    return list
      .map((p) => ({ name: p.name || p.path, value: p.value, type: p.type || 'xsd:string' }))
      .filter((p) => p.name && p.value !== undefined && p.value !== null);
  }
  if (params && typeof params === 'object') {
    return Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
      .map(([name, value]) => ({ name, value: String(value), type: 'xsd:string' }));
  }
  return [];
}

function buildResponseForTask(task) {
  const msgId = `TASK-${task.id}`;
  const params = task.parameters ? (typeof task.parameters === 'string' ? JSON.parse(task.parameters) : task.parameters) : {};

  switch (task.task_type) {
    case 'get_parameter_values':
      return buildCwmpResponse(msgId, 'GetParameterValues', {
        parameterNames: Array.isArray(params) ? params : (params.paths || []),
      });
    case 'set_parameter_values':
      return buildCwmpResponse(msgId, 'SetParameterValues', {
        parameterValueList: setParameterList(params),
      });
    case 'get_parameter_names':
      return buildCwmpResponse(msgId, 'GetParameterNames', {
        parameterPath: params.path || '',
        nextLevel: params.nextLevel !== false,
      });
    case 'download':
      return buildCwmpResponse(msgId, 'Download', {
        commandKey: `DL-${task.id}`,
        fileType: params.fileType || '1 Firmware Upgrade Image',
        url: params.url || '',
        fileSize: params.fileSize || 0,
      });
    case 'reboot':
      return buildCwmpResponse(msgId, 'Reboot');
    case 'factory_reset':
      return buildCwmpResponse(msgId, 'FactoryReset');
    // §8.3 diagnostic task types
    case 'ping_diagnostic':
      return buildCwmpResponse(msgId, 'StartPingDiagnostic', params);
    case 'traceroute_diagnostic':
      return buildCwmpResponse(msgId, 'StartTracerouteDiagnostic', params);
    case 'wifi_diagnostics':
    case 'wan_diagnostics': {
      const paths = Array.isArray(params) ? params : (params.paths || []);
      return buildCwmpResponse(msgId, 'GetParameterValues', { parameterNames: paths });
    }
    default:
      return buildCwmpResponse(msgId, 'Empty');
  }
}

// ---------------------------------------------------------------------------
// processTaskResponse
// ---------------------------------------------------------------------------

/**
 * Update task record after receiving CPE response, store parameter values.
 * @param {object} task
 * @param {object} responsePayload
 */
async function processTaskResponse(task, responsePayload) {
  const now = new Date();

  if (task.task_type === 'get_parameter_values' && responsePayload.parameterList) {
    // Store returned parameter values
    for (const param of responsePayload.parameterList) {
      if (!param.name) continue;
      await db.query(
        `INSERT INTO cpe_parameters (cpe_device_id, organization_id, parameter_path, parameter_value, last_fetched_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE parameter_value = VALUES(parameter_value), last_fetched_at = NOW()`,
        [task.cpe_device_id, task.organization_id, param.name, param.value || null],
      );
    }
  }

  await db.query(
    'UPDATE cpe_tasks SET status = \'done\', completed_at = ?, result = ? WHERE id = ?',
    [now, JSON.stringify(responsePayload), task.id],
  );

  // Status 0 = applied, 1 = applied and committed after a reboot (TR-069).
  if (task.task_type === 'set_parameter_values') {
    const applied = responsePayload.status === 0 || responsePayload.status === 1;
    await require('./portalServiceRequestService').settleWifiRequestForTask(task.id, applied,
      applied ? null : `SetParameterValuesResponse status ${responsePayload.status}`);
  }
}

// ---------------------------------------------------------------------------
// applyZeroTouchProvisioning
// ---------------------------------------------------------------------------

/**
 * Match CPE device to a profile by OUI/manufacturer and queue provisioning tasks.
 * @param {object} cpeDevice
 * @param {number|null} orgId
 */
async function applyZeroTouchProvisioning(cpeDevice, orgId) {
  // Find a matching profile: org-scoped first, then global, matched on manufacturer
  const [profiles] = await db.query(
    `SELECT * FROM cpe_profiles
     WHERE deleted_at IS NULL
       AND status = 'active'
       AND (organization_id = ? OR organization_id IS NULL)
       AND (manufacturer = ? OR manufacturer IS NULL)
     ORDER BY organization_id IS NULL ASC, manufacturer IS NULL ASC
     LIMIT 1`,
    [orgId, cpeDevice.manufacturer || ''],
  );

  if (!profiles.length) {
    logger.info({ cpeDeviceId: cpeDevice.id }, 'No matching profile for ZTP');
    return;
  }

  const profile = profiles[0];
  const resolvedProfile = await cpeProfileService.resolveProfile(profile.id, orgId ?? null);
  const tasks = await cpeProfileService.buildProvisioningTasks(cpeDevice, resolvedProfile);

  // Insert tasks
  for (const task of tasks) {
    await CpeTask.create({
      ...task,
      organization_id: orgId,
      cpe_device_id: cpeDevice.id,
    });
  }

  // Link profile to device
  await db.query(
    'UPDATE cpe_devices SET cpe_profile_id = ?, status = ? WHERE id = ?',
    [profile.id, 'provisioning', cpeDevice.id],
  );

  logger.info({ cpeDeviceId: cpeDevice.id, profileId: profile.id }, 'ZTP profile applied');
}

module.exports = {
  setParameterList,
  handleInform,
  getNextTask,
  buildResponseForTask,
  processTaskResponse,
  applyZeroTouchProvisioning,
};
