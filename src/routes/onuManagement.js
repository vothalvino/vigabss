'use strict';

// =============================================================================
// VigaBSS 5.0 — ONU Management Routes (§7.2)
// =============================================================================
// Mounted at /api/onu-management and /api/v1/onu-management.
//
// Resources:
//   /profiles           — ONU profile templates CRUD
//   /details            — ONU detail records CRUD (extends device rows)
//   /details/:id        — single ONU detail
//   /details/:id/optical-metrics  — optical diagnostic history
//   /details/:id/provision        — trigger provisioning
//   /details/:id/reboot           — schedule remote reboot
//   /whitelist          — ONU MAC/SN allow-block list CRUD
//   /omci-configs       — OMCI/TR-069 config records CRUD
//   /firmware-jobs      — firmware upgrade / reboot job scheduler CRUD
//   /firmware-jobs/:id/cancel — cancel a pending job
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { buildInsert, buildUpdate, columnsOf } = require('../utils/sqlBuild');
const { sealSecret, sealSecretFields } = require('../utils/sealSecrets');
const { redactSecretsInResponses, keepBlankSecrets } = require('../utils/secretRedaction');
const { assertOwnedReferences } = require('../utils/ownedReferences');
const { writableRow } = require('../utils/writableRow');
const {
  createOnuProfile, updateOnuProfile, patchOnuProfile,
} = require('../middleware/schemas/onuProfiles');
const {
  createOnuDetail, updateOnuDetail, patchOnuDetail,
} = require('../middleware/schemas/onuDetails');
const {
  createOnuWhitelistEntry, updateOnuWhitelistEntry,
} = require('../middleware/schemas/onuWhitelist');
const {
  createOnuOmciConfig, updateOnuOmciConfig,
} = require('../middleware/schemas/onuOmciConfigs');
const {
  createOnuFirmwareJob, updateOnuFirmwareJob,
} = require('../middleware/schemas/onuFirmwareJobs');
const ftthService = require('../services/ftthService');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// LOID and Wi-Fi passwords are write-only (NET-10): onu_management.view and
// onu_omci_configs.view, which the read-only role holds, used to return them,
// and they were stored exactly as sent. Plaintext comes in as loid_password /
// wifi_password and is encrypted here; responses carry has_* flags.
router.use(['/details', '/omci-configs'], redactSecretsInResponses(['loid_password_encrypted', 'wifi_password_encrypted']));
const sealLoidPassword = [keepBlankSecrets(['loid_password']), sealSecretFields({ loid_password: 'loid_password_encrypted' })];
const sealWifiPassword = [keepBlankSecrets(['wifi_password']), sealSecretFields({ wifi_password: 'wifi_password_encrypted' })];

// Writes take only the fields the route's schema declares (plus a sealed
// credential column). The profile edit form sends the whole row back, and
// every undeclared key — last_provision_job_id, active_flag, timestamps —
// used to reach the INSERT/UPDATE.
function declaredFields(body, schema, extra = []) {
  return Object.fromEntries(Object.entries(body || {})
    .filter(([key]) => Object.hasOwn(schema, key) || extra.includes(key)));
}

// Referenced rows must belong to the caller (or, for profiles, be shared).
const DEVICE_REFS = {
  device_id: 'devices',
  olt_device_id: 'devices',
  olt_port_id: 'olt_ports',
  onu_profile_id: { table: 'onu_profiles', allowShared: true },
};
const ownsReferences = refs => async (req, _res, next) => {
  try {
    await assertOwnedReferences(req.body, req.orgId, refs);
    next();
  } catch (err) { next(err); }
};

// ===========================================================================
// ONU Profiles
// ===========================================================================

router.get('/profiles', requirePermission('onu_profiles.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 25, technology } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 25), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = 'SELECT * FROM onu_profiles WHERE (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL';
    const params = [req.orgId];
    if (technology) { sql += ' AND technology = ?'; params.push(technology); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY name ASC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/profiles/:id', requirePermission('onu_profiles.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM onu_profiles WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/profiles', requirePermission('onu_profiles.create'), validate(createOnuProfile), ownsReferences({ plan_id: 'plans' }), async (req, res, next) => {
  try {
    const fields = declaredFields(req.body, createOnuProfile);
    const { columns, placeholders, values } = buildInsert({ organization_id: req.orgId, ...fields }, columnsOf(createOnuProfile, 'organization_id'));
    const [result] = await db.query(
      `INSERT INTO onu_profiles (${columns}) VALUES (${placeholders})`,
      values,
    );
    const [rows] = await db.query('SELECT * FROM onu_profiles WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/profiles/:id', requirePermission('onu_profiles.update'), validate(updateOnuProfile), ownsReferences({ plan_id: 'plans' }), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_profiles', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, updateOnuProfile);
    const { assignments, values } = buildUpdate(updateData, columnsOf(updateOnuProfile));
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';
    await db.query(`UPDATE onu_profiles SET ${setClause} WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_profiles WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/profiles/:id', requirePermission('onu_profiles.update'), validate(patchOnuProfile), ownsReferences({ plan_id: 'plans' }), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_profiles', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, patchOnuProfile);
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'No fields to update' });
    const { assignments, values } = buildUpdate(updateData, columnsOf(patchOnuProfile));
    await db.query(`UPDATE onu_profiles SET ${assignments}, updated_at = NOW() WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_profiles WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/profiles/:id', requirePermission('onu_profiles.delete'), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_profiles', req.params.id, req.orgId)) return;
    await db.query('UPDATE onu_profiles SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ?', [req.params.id, req.orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ===========================================================================
// ONU Details (provisioning/status records, one per ONU device)
// ===========================================================================

router.get('/details', requirePermission('onu_management.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 25, olt_device_id, olt_port_id, onu_state } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 25), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = `
      SELECT od.*, d.name AS device_name, d.mac_address, d.ip_address,
             p.port_name, np.name AS profile_name
      FROM onu_details od
      JOIN devices d ON d.id = od.device_id AND d.deleted_at IS NULL
        AND (d.organization_id <=> od.organization_id OR d.organization_id IS NULL)
      LEFT JOIN olt_ports p ON p.id = od.olt_port_id
        AND (p.organization_id <=> od.organization_id OR p.organization_id IS NULL)
      LEFT JOIN onu_profiles np ON np.id = od.onu_profile_id AND np.deleted_at IS NULL
      WHERE (od.organization_id = ? OR od.organization_id IS NULL) AND od.deleted_at IS NULL
    `;
    const params = [req.orgId];

    if (olt_device_id) { sql += ' AND od.olt_device_id = ?'; params.push(olt_device_id); }
    if (olt_port_id) { sql += ' AND od.olt_port_id = ?'; params.push(olt_port_id); }
    if (onu_state) { sql += ' AND od.onu_state = ?'; params.push(onu_state); }

    const countSql = sql.replace(/SELECT od\.\*.*?FROM/s, 'SELECT COUNT(*) AS total FROM');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY od.olt_device_id ASC, od.onu_id ASC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/details/:id', requirePermission('onu_management.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT od.*, d.name AS device_name, d.mac_address, d.ip_address,
              p.port_name, np.name AS profile_name
       FROM onu_details od
       JOIN devices d ON d.id = od.device_id AND d.deleted_at IS NULL
         AND (d.organization_id <=> od.organization_id OR d.organization_id IS NULL)
       LEFT JOIN olt_ports p ON p.id = od.olt_port_id
         AND (p.organization_id <=> od.organization_id OR p.organization_id IS NULL)
       LEFT JOIN onu_profiles np ON np.id = od.onu_profile_id AND np.deleted_at IS NULL
       WHERE od.id = ? AND (od.organization_id = ? OR od.organization_id IS NULL) AND od.deleted_at IS NULL`,
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/details', requirePermission('onu_management.create'), validate(createOnuDetail), ownsReferences(DEVICE_REFS), sealLoidPassword, async (req, res, next) => {
  try {
    const fields = declaredFields(req.body, createOnuDetail, ['loid_password_encrypted']);
    const { columns, placeholders, values } = buildInsert({ organization_id: req.orgId, ...fields }, columnsOf(createOnuDetail, 'organization_id', 'loid_password_encrypted'));
    const [result] = await db.query(
      `INSERT INTO onu_details (${columns}) VALUES (${placeholders})`,
      values,
    );
    const [rows] = await db.query('SELECT * FROM onu_details WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/details/:id', requirePermission('onu_management.update'), validate(updateOnuDetail), ownsReferences(DEVICE_REFS), sealLoidPassword, async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_details', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, updateOnuDetail, ['loid_password_encrypted']);
    const { assignments, values } = buildUpdate(updateData, columnsOf(updateOnuDetail, 'loid_password_encrypted'));
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';
    await db.query(`UPDATE onu_details SET ${setClause} WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_details WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.patch('/details/:id', requirePermission('onu_management.update'), validate(patchOnuDetail), ownsReferences(DEVICE_REFS), sealLoidPassword, async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_details', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, patchOnuDetail, ['loid_password_encrypted']);
    if (!Object.keys(updateData).length) return res.status(400).json({ error: 'No fields to update' });
    const { assignments, values } = buildUpdate(updateData, columnsOf(patchOnuDetail, 'loid_password_encrypted'));
    await db.query(`UPDATE onu_details SET ${assignments}, updated_at = NOW() WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_details WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/details/:id', requirePermission('onu_management.delete'), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_details', req.params.id, req.orgId)) return;
    await db.query('UPDATE onu_details SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ?', [req.params.id, req.orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ONU optical diagnostics history
router.get('/details/:id/optical-metrics', requirePermission('onu_management.view'), async (req, res, next) => {
  try {
    const [detail] = await db.query(
      'SELECT device_id FROM onu_details WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!detail.length) return res.status(404).json({ error: 'ONU detail not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const rows = await ftthService.getOnuOpticalHistory(detail[0].device_id, req.orgId, limit);
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ONU provision action (creates/updates onu_details + provision job)
router.post('/details/:id/provision', requirePermission('onu_management.create'), ownsReferences(DEVICE_REFS), async (req, res, next) => {
  try {
    const detail = await writableRow(res, 'onu_details', req.params.id, req.orgId, '*');
    if (!detail) return;
    const result = await ftthService.provisionOnu({
      deviceId: detail.device_id,
      oltDeviceId: req.body.olt_device_id || detail.olt_device_id,
      oltPortId: req.body.olt_port_id || detail.olt_port_id,
      onuProfileId: req.body.onu_profile_id || detail.onu_profile_id,
      serialNumber: req.body.serial_number || detail.serial_number,
      loid: req.body.loid || detail.loid,
      loidPasswordEncrypted: typeof req.body.loid_password === 'string' && req.body.loid_password
        ? sealSecret(req.body.loid_password)
        : detail.loid_password_encrypted,
      orgId: req.orgId,
      createdBy: req.user?.id,
    });
    res.status(202).json({ data: result, message: 'Provision job queued — delivery dispatched by background processor' });
  } catch (err) { next(err); }
});

// ONU reboot action
router.post('/details/:id/reboot', requirePermission('onu_management.update'), async (req, res, next) => {
  try {
    const detail = await writableRow(res, 'onu_details', req.params.id, req.orgId, 'device_id, olt_device_id');
    if (!detail) return;
    const job = await ftthService.scheduleOnuReboot(
      detail.device_id,
      detail.olt_device_id,
      req.orgId,
      req.user?.id,
    );
    res.status(202).json({ data: job, message: 'Reboot job queued — dispatched by background processor' });
  } catch (err) { next(err); }
});

// ===========================================================================
// ONU Whitelist
// ===========================================================================

router.get('/whitelist', requirePermission('onu_whitelist.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 25, olt_device_id, list_type, entry_type } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 25), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = 'SELECT * FROM onu_whitelist WHERE (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL';
    const params = [req.orgId];
    if (olt_device_id) { sql += ' AND olt_device_id = ?'; params.push(olt_device_id); }
    if (list_type) { sql += ' AND list_type = ?'; params.push(list_type); }
    if (entry_type) { sql += ' AND entry_type = ?'; params.push(entry_type); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/whitelist/:id', requirePermission('onu_whitelist.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM onu_whitelist WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/whitelist', requirePermission('onu_whitelist.create'), validate(createOnuWhitelistEntry), ownsReferences(DEVICE_REFS), async (req, res, next) => {
  try {
    const fields = declaredFields(req.body, createOnuWhitelistEntry);
    const { columns, placeholders, values } = buildInsert({ organization_id: req.orgId, ...fields }, columnsOf(createOnuWhitelistEntry, 'organization_id'));
    const [result] = await db.query(
      `INSERT INTO onu_whitelist (${columns}) VALUES (${placeholders})`,
      values,
    );
    const [rows] = await db.query('SELECT * FROM onu_whitelist WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/whitelist/:id', requirePermission('onu_whitelist.update'), validate(updateOnuWhitelistEntry), ownsReferences(DEVICE_REFS), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_whitelist', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, updateOnuWhitelistEntry);
    const { assignments, values } = buildUpdate(updateData, columnsOf(updateOnuWhitelistEntry));
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';
    await db.query(`UPDATE onu_whitelist SET ${setClause} WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_whitelist WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/whitelist/:id', requirePermission('onu_whitelist.delete'), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_whitelist', req.params.id, req.orgId)) return;
    await db.query('UPDATE onu_whitelist SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ?', [req.params.id, req.orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ===========================================================================
// OMCI / TR-069 Configs
// ===========================================================================

router.get('/omci-configs', requirePermission('onu_omci_configs.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 25, device_id, config_type, apply_status } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 25), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = 'SELECT * FROM onu_omci_configs WHERE (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL';
    const params = [req.orgId];
    if (device_id) { sql += ' AND device_id = ?'; params.push(device_id); }
    if (config_type) { sql += ' AND config_type = ?'; params.push(config_type); }
    if (apply_status) { sql += ' AND apply_status = ?'; params.push(apply_status); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/omci-configs/:id', requirePermission('onu_omci_configs.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM onu_omci_configs WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/omci-configs', requirePermission('onu_omci_configs.create'), validate(createOnuOmciConfig), ownsReferences(DEVICE_REFS), sealWifiPassword, async (req, res, next) => {
  try {
    const fields = declaredFields(req.body, createOnuOmciConfig, ['wifi_password_encrypted']);
    const { columns, placeholders, values } = buildInsert({ organization_id: req.orgId, apply_status: 'pending', ...fields }, columnsOf(createOnuOmciConfig, 'organization_id', 'apply_status', 'wifi_password_encrypted'));
    const [result] = await db.query(
      `INSERT INTO onu_omci_configs (${columns}) VALUES (${placeholders})`,
      values,
    );
    const [rows] = await db.query('SELECT * FROM onu_omci_configs WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/omci-configs/:id', requirePermission('onu_omci_configs.update'), validate(updateOnuOmciConfig), ownsReferences(DEVICE_REFS), sealWifiPassword, async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_omci_configs', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, updateOnuOmciConfig, ['wifi_password_encrypted']);
    const { assignments, values } = buildUpdate(updateData, columnsOf(updateOnuOmciConfig, 'wifi_password_encrypted'));
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';
    await db.query(`UPDATE onu_omci_configs SET ${setClause} WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_omci_configs WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/omci-configs/:id', requirePermission('onu_omci_configs.delete'), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_omci_configs', req.params.id, req.orgId)) return;
    await db.query('UPDATE onu_omci_configs SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ?', [req.params.id, req.orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ===========================================================================
// Firmware / Reboot Jobs
// ===========================================================================

router.get('/firmware-jobs', requirePermission('onu_firmware_jobs.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 25, status, job_type, olt_device_id } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 25), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = 'SELECT * FROM onu_firmware_jobs WHERE (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL';
    const params = [req.orgId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (job_type) { sql += ' AND job_type = ?'; params.push(job_type); }
    if (olt_device_id) { sql += ' AND olt_device_id = ?'; params.push(olt_device_id); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum } });
  } catch (err) { next(err); }
});

router.get('/firmware-jobs/:id', requirePermission('onu_firmware_jobs.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM onu_firmware_jobs WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/firmware-jobs', requirePermission('onu_firmware_jobs.create'), validate(createOnuFirmwareJob), ownsReferences({ ...DEVICE_REFS, onu_device_id: 'devices' }), async (req, res, next) => {
  try {
    const job = await ftthService.scheduleFirmwareUpgrade({
      scope: req.body.scope,
      onuDeviceId: req.body.onu_device_id,
      oltDeviceId: req.body.olt_device_id,
      oltPortId: req.body.olt_port_id,
      firmwareVersion: req.body.firmware_version,
      firmwareUrl: req.body.firmware_url,
      scheduledAt: req.body.scheduled_at,
      orgId: req.orgId,
      createdBy: req.user?.id,
    });
    res.status(201).json({ data: job });
  } catch (err) { next(err); }
});

router.put('/firmware-jobs/:id', requirePermission('onu_firmware_jobs.update'), validate(updateOnuFirmwareJob), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_firmware_jobs', req.params.id, req.orgId)) return;
    const updateData = declaredFields(req.body, updateOnuFirmwareJob);
    const { assignments, values } = buildUpdate(updateData, columnsOf(updateOnuFirmwareJob));
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';
    await db.query(`UPDATE onu_firmware_jobs SET ${setClause} WHERE id = ? AND organization_id <=> ?`, [...values, req.params.id, req.orgId]);
    const [rows] = await db.query('SELECT * FROM onu_firmware_jobs WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.post('/firmware-jobs/:id/cancel', requirePermission('onu_firmware_jobs.update'), async (req, res, next) => {
  try {
    const job = await writableRow(res, 'onu_firmware_jobs', req.params.id, req.orgId, 'id, status');
    if (!job) return;
    if (!['pending', 'queued'].includes(job.status)) {
      return res.status(409).json({ error: `Cannot cancel a job in status '${job.status}'` });
    }
    await db.query(
      "UPDATE onu_firmware_jobs SET status = 'cancelled', updated_at = NOW() WHERE id = ? AND organization_id <=> ?",
      [req.params.id, req.orgId],
    );
    const [rows] = await db.query('SELECT * FROM onu_firmware_jobs WHERE id = ?', [req.params.id]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/firmware-jobs/:id', requirePermission('onu_firmware_jobs.delete'), async (req, res, next) => {
  try {
    if (!await writableRow(res, 'onu_firmware_jobs', req.params.id, req.orgId)) return;
    await db.query('UPDATE onu_firmware_jobs SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ?', [req.params.id, req.orgId]);
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
