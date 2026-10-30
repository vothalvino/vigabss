// =============================================================================
// VigaBSS 5.0 — Config Template Routes — §6.6
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createTemplate, updateTemplate } = require('../middleware/schemas/configTemplates');
const { deployConfigTemplate } = require('../services/configBackupService');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// GET / — list templates
router.get('/', requirePermission('config_templates.view'), async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM config_templates WHERE organization_id = ? AND deleted_at IS NULL',
      [orgId],
    );
    const [rows] = await db.query(
      `SELECT * FROM config_templates WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [orgId],
    );
    res.json({ data: rows, meta: { total, page, limit } });
  } catch (err) { next(err); }
});

// POST / — create
router.post('/', requirePermission('config_templates.create'), validate(createTemplate), async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const { name, description, device_type, manufacturer, template_content, variables_schema, status } = req.body;
    const [result] = await db.query(
      `INSERT INTO config_templates (organization_id, name, description, device_type, manufacturer, template_content, variables_schema, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, name, description || null, device_type || null, manufacturer || null, template_content,
        variables_schema ? JSON.stringify(variables_schema) : null, status || 'active'],
    );
    const [[row]] = await db.query('SELECT * FROM config_templates WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

// POST /:id/deploy — render a template for a device (before /:id to avoid route collision)
// Template and device must both belong to the caller's organization (404
// otherwise). No automatic push to the device exists yet, so the deployment is
// recorded as status 'pending' with push_performed: false and the rendered
// config is returned for manual application. 200, not 201/202: nothing has
// been queued that will later complete on its own.
router.post('/:id/deploy', requirePermission('config_deployments.create'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { device_id, variables } = req.body;
    if (!device_id) { return res.status(400).json({ error: 'device_id is required' }); }
    let parsedVars;
    try {
      parsedVars = typeof variables === 'string' ? JSON.parse(variables) : (variables || {});
    } catch {
      throw new ValidationError('variables must be a JSON object');
    }
    const record = await deployConfigTemplate(Number(id), Number(device_id), parsedVars, req.user?.id ?? null, req.orgId);
    res.status(200).json({ data: record });
  } catch (err) { next(err); }
});

// PUT /:id — update
router.put('/:id', requirePermission('config_templates.update'), validate(updateTemplate), async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const { id } = req.params;
    const [[existing]] = await db.query(
      'SELECT id FROM config_templates WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [id, orgId],
    );
    if (!existing) throw new NotFoundError('config_templates');
    const fields = ['name', 'description', 'device_type', 'manufacturer', 'template_content', 'variables_schema', 'status'];
    const updates = [];
    const vals = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        vals.push(f === 'variables_schema' ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    }
    if (updates.length === 0) {
      const [[row]] = await db.query('SELECT * FROM config_templates WHERE id = ?', [id]);
      return res.json({ data: row });
    }
    vals.push(id);
    await db.query(`UPDATE config_templates SET ${updates.join(', ')} WHERE id = ?`, vals);
    const [[row]] = await db.query('SELECT * FROM config_templates WHERE id = ?', [id]);
    res.json({ data: row });
  } catch (err) { next(err); }
});

// DELETE /:id — soft delete
router.delete('/:id', requirePermission('config_templates.delete'), async (req, res, next) => {
  try {
    const orgId = req.orgId;
    const { id } = req.params;
    const [result] = await db.query(
      'UPDATE config_templates SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [id, orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('config_templates');
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
