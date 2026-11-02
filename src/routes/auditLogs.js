// =============================================================================
// VigaBSS 5.0 — Audit Log Routes
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const db = require('../config/database');
const { isInstallOperator, OPERATOR_ONLY_MESSAGE } = require('../services/installOperator');
const { verifyAuditChain } = require('../services/auditChainService');

const router = Router();

// ASY-38: install-wide events (organization_id NULL, such as install-operator
// backup downloads) matched no organization's filter, so nobody could read
// them. ?scope=install shows them to the install operator.
async function auditScope(req, res) {
  const scope = req.query.scope ?? 'organization';
  if (scope === 'organization') {
    return { clause: 'organization_id = ?', params: [req.orgId], organizationId: req.orgId };
  }
  if (scope !== 'install') {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: "scope must be 'organization' or 'install'" } });
    return null;
  }
  if (!(await isInstallOperator(req))) {
    res.status(403).json({ error: { code: 'INSTALL_OPERATOR_ONLY', message: OPERATOR_ONLY_MESSAGE } });
    return null;
  }
  return { clause: 'organization_id IS NULL', params: [], organizationId: null };
}

router.use(authenticate);
router.use(orgScope);
// Audit and report-access ledgers are control-plane records. Keep reads and
// writes in primary so an isolated tenant sees the same trail that sensitive
// connection/flow export routes append.
router.use((_req, _res, next) => db.withPrimaryContext(() => next()));

// List audit logs with filters
router.get('/', requirePermission('audit_logs.view'), async (req, res, next) => {
  try {
    const {
      user_id, action, table_name, entity_type, date_from, date_to,
      page = 1, limit = 50,
    } = req.query;

    // audit_logs is scoped by organization_id and records the affected record as
    // entity_type/entity_id (there is no table_name column — see migration 374).
    // Accept the legacy `table_name` query alias so existing callers keep working.
    const entityFilter = entity_type || table_name;
    const scope = await auditScope(req, res);
    if (!scope) return;
    const conditions = [scope.clause];
    const params = [...scope.params];

    if (user_id) { conditions.push('user_id = ?'); params.push(user_id); }
    if (action) { conditions.push('action = ?'); params.push(action); }
    if (entityFilter) { conditions.push('entity_type = ?'); params.push(entityFilter); }
    if (date_from) { conditions.push('created_at >= ?'); params.push(date_from); }
    if (date_to) { conditions.push('created_at <= ?'); params.push(date_to); }

    const where = conditions.join(' AND ');
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const safeOffset = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit);

    const [rows] = await db.query(
      `SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params,
    );
    const [countResult] = await db.query(
      `SELECT COUNT(*) AS total FROM audit_logs WHERE ${where}`,
      params,
    );

    res.json({ data: rows, meta: { total: countResult[0].total, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    next(err);
  }
});

// Recompute the scope's audit hash chain (migration 505) and report any row
// that was changed, removed or reordered since it was written.
router.get('/verify', requirePermission('audit_logs.view'), async (req, res, next) => {
  try {
    const scope = await auditScope(req, res);
    if (!scope) return;
    res.json({ data: await verifyAuditChain(scope.organizationId) });
  } catch (err) {
    next(err);
  }
});

// Export audit logs for regulatory inspection (no pagination — up to 10000 rows)
router.get('/export', requirePermission('audit_export.view'), async (req, res, next) => {
  try {
    const { date_from, date_to, action, entity_type } = req.query;

    const conditions = ['organization_id = ?'];
    const params = [req.orgId];

    if (action) { conditions.push('action = ?'); params.push(action); }
    if (entity_type) { conditions.push('entity_type = ?'); params.push(entity_type); }
    if (date_from) { conditions.push('created_at >= ?'); params.push(date_from); }
    if (date_to) { conditions.push('created_at <= ?'); params.push(date_to); }

    const where = conditions.join(' AND ');

    const [rows] = await db.query(
      `SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT 10000`,
      params,
    );

    // Log to report_access_logs
    await db.query(
      `INSERT INTO report_access_logs (organization_id, user_id, api_token_id, report_type, entity_type, parameters, ip_address, user_agent, accessed_at)
       VALUES (?, ?, ?, 'audit_export', 'audit_logs', ?, ?, ?, NOW())`,
      [req.orgId, req.user.id, req.user.apiTokenId || null,
        JSON.stringify(req.query), req.ip || null, req.get('user-agent') || null],
    );

    res.json({
      data: rows,
      meta: {
        total: rows.length,
        exported_at: new Date().toISOString(),
        exported_by: req.user.email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// List report access logs
router.get('/report-access-logs', requirePermission('report_access_logs.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const safeOffset = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit);

    const [rows] = await db.query(
      `SELECT * FROM report_access_logs WHERE organization_id = ? ORDER BY accessed_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [req.orgId],
    );
    const [countResult] = await db.query(
      'SELECT COUNT(*) AS total FROM report_access_logs WHERE organization_id = ?',
      [req.orgId],
    );

    res.json({ data: rows, meta: { total: countResult[0].total, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
