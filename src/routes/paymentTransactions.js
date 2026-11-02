// =============================================================================
// VigaBSS 5.0 — Payment Transaction Routes
// =============================================================================

const { Router } = require('express');
const PaymentTransaction = require('../models/PaymentTransaction');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const db = require('../config/database');

const router = Router();
const ctrl = crudController(PaymentTransaction);

router.use(authenticate);
router.use(orgScope);

// The list carries the gateway's name and provider, which the payments drawer
// shows, and filters by client_id and payment_id (FE-19).
router.get('/', requirePermission('payment_transactions.view'), async (req, res, next) => {
  try {
    const { client_id, payment_id, page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const conditions = ['pt.organization_id = ?'];
    const params = [req.orgId];
    if (client_id !== undefined) { conditions.push('pt.client_id = ?'); params.push(client_id); }
    if (payment_id !== undefined) { conditions.push('pt.payment_id = ?'); params.push(payment_id); }
    const where = conditions.join(' AND ');

    const [rows] = await db.query(
      `SELECT pt.id, pt.payment_id, pt.payment_gateway_id, pt.client_id, pt.invoice_id,
              pt.settled_invoice_id, pt.gateway_reference_id, pt.amount, pt.currency,
              pt.gateway_status, pt.gateway_response_code, pt.gateway_response_message,
              pt.created_at, pt.updated_at,
              pg.name AS gateway_name, pg.provider AS gateway_provider
         FROM payment_transactions pt
         LEFT JOIN payment_gateways pg ON pg.id = pt.payment_gateway_id
        WHERE ${where}
        ORDER BY pt.id DESC
        LIMIT ${limitNum} OFFSET ${(pageNum - 1) * limitNum}`,
      params,
    );
    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM payment_transactions pt WHERE ${where}`, params);
    res.json({ data: rows, meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) } });
  } catch (err) { next(err); }
});
router.get('/:id', requirePermission('payment_transactions.view'), ctrl.get);

module.exports = router;
