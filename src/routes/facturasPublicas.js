// =============================================================================
// VigaBSS 5.0 — Factura Pública Routes
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requireMxLocale } = require('../middleware/orgLocale');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createFacturaPublica, updateFacturaPublica, addFacturaPublicaItem } = require('../middleware/schemas/facturasPublicas');
const db = require('../config/database');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { globalPeriodProblem } = require('../utils/satCatalogs');
const facturaPublicaService = require('../services/facturaPublicaService');

const router = Router();

// The caller states the period only. The CFDI link, the totals and the
// status are written by POST /:id/stamp from the linked invoices (BIL-24);
// accepting them from the body let a record claim a CFDI it never had.
const ALLOWED_COLUMNS = ['periodicidad', 'meses', 'anio'];

// A period SAT cannot file is refused when it is entered, not at stamp time.
function assertPeriod(body, current = {}) {
  const merged = { ...current, ...body };
  const problem = globalPeriodProblem(merged.periodicidad, merged.meses, merged.anio);
  if (problem) throw new ValidationError(`InformacionGlobal: ${problem}`, [{ field: 'meses', message: problem }]);
}

router.use(authenticate);
router.use(orgScope);
router.use(requireMxLocale);

// List facturas públicas
router.get('/', requirePermission('facturas_publicas.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10)), 100);
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await db.query(
      `SELECT * FROM factura_publica_invoices WHERE organization_id = ? ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`,
      [req.orgId],
    );
    const [countResult] = await db.query(
      'SELECT COUNT(*) AS total FROM factura_publica_invoices WHERE organization_id = ?',
      [req.orgId],
    );
    const total = countResult[0].total;

    res.json({
      data: rows,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// Get a single factura pública
router.get('/:id', requirePermission('facturas_publicas.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM factura_publica_invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.orgId],
    );
    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Factura pública not found' } });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Create a factura pública
router.post('/', requirePermission('facturas_publicas.create'), validate(createFacturaPublica), async (req, res, next) => {
  try {
    const safe = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_COLUMNS.includes(k)),
    );
    assertPeriod(safe);
    safe.organization_id = req.orgId;
    const columns = Object.keys(safe);
    const placeholders = columns.map(() => '?').join(', ');
    const [result] = await db.query(
      `INSERT INTO factura_publica_invoices (${columns.join(', ')}) VALUES (${placeholders})`,
      Object.values(safe),
    );
    const [rows] = await db.query('SELECT * FROM factura_publica_invoices WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update a factura pública
router.put('/:id', requirePermission('facturas_publicas.update'), validate(updateFacturaPublica), async (req, res, next) => {
  try {
    const safe = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => ALLOWED_COLUMNS.includes(k)),
    );
    const current = await findFacturaOrFail(db.query.bind(db), req.params.id, req.orgId);
    if (current.status !== 'draft' || current.cfdi_document_id) {
      throw new AppError('A stamped factura pública is a filed SAT document and cannot be edited.', 422, 'FACTURA_PUBLICA_NOT_DRAFT');
    }
    if (Object.keys(safe).length === 0) throw new ValidationError('Send periodicidad, meses or anio');
    const [[period]] = await db.query(
      'SELECT periodicidad, meses, anio FROM factura_publica_invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.orgId],
    );
    assertPeriod(safe, period);
    const columns = Object.keys(safe).map((col) => `${col} = ?`).join(', ');
    await db.query(
      `UPDATE factura_publica_invoices SET ${columns} WHERE id = ? AND organization_id = ?`,
      [...Object.values(safe), req.params.id, req.orgId],
    );
    const [rows] = await db.query(
      'SELECT * FROM factura_publica_invoices WHERE id = ? AND organization_id = ?',
      [req.params.id, req.orgId],
    );
    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Factura pública not found' } });
    }
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// factura_publica_invoice_items has no organization_id; both item routes prove
// the parent factura belongs to the caller's org first (404 otherwise). They
// used to read and link by factura id alone, and POST accepted any tenant's
// invoice id — which, through UNIQUE(invoice_id), also let one tenant block
// another's invoice from ever joining its own factura pública.
async function findFacturaOrFail(exec, id, orgId, { forUpdate = false } = {}) {
  const [rows] = await exec(
    `SELECT id, status, cfdi_document_id FROM factura_publica_invoices
      WHERE id = ? AND organization_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, orgId],
  );
  if (!rows[0]) throw new NotFoundError('Factura pública');
  return rows[0];
}

// List linked invoices for a factura pública
router.get('/:id/items', requirePermission('facturas_publicas.view'), async (req, res, next) => {
  try {
    await findFacturaOrFail(db.query, req.params.id, req.orgId);
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10)), 100);
    const offset = (pageNum - 1) * limitNum;

    const [rows] = await db.query(
      `SELECT fi.* FROM factura_publica_invoice_items fi
         JOIN factura_publica_invoices f ON f.id = fi.factura_publica_invoice_id
        WHERE fi.factura_publica_invoice_id = ? AND f.organization_id = ?
        ORDER BY fi.id LIMIT ${limitNum} OFFSET ${offset}`,
      [req.params.id, req.orgId],
    );
    const [countResult] = await db.query(
      `SELECT COUNT(*) AS total FROM factura_publica_invoice_items fi
         JOIN factura_publica_invoices f ON f.id = fi.factura_publica_invoice_id
        WHERE fi.factura_publica_invoice_id = ? AND f.organization_id = ?`,
      [req.params.id, req.orgId],
    );
    const total = countResult[0].total;

    res.json({
      data: rows,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// Link an invoice to a factura pública
router.post('/:id/items', requirePermission('facturas_publicas.update'), validate(addFacturaPublicaItem), async (req, res, next) => {
  try {
    const conn = await db.getConnection();
    let row;
    try {
      await conn.beginTransaction();
      const exec = conn.execute.bind(conn);
      // Lock the parent so a concurrent stamp cannot land between the status
      // check and the insert.
      const factura = await findFacturaOrFail(exec, req.params.id, req.orgId, { forUpdate: true });
      // A stamped (or cancelled) factura pública is a filed SAT document; its
      // invoice set is frozen.
      if (factura.status !== 'draft' || factura.cfdi_document_id) {
        throw new AppError(
          `Invoices can only be linked to a draft factura pública (this one is ${factura.status}).`,
          422, 'FACTURA_PUBLICA_NOT_DRAFT',
        );
      }
      const [[invoice]] = await exec(
        'SELECT id FROM invoices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [req.body.invoice_id, req.orgId],
      );
      if (!invoice) {
        throw new ValidationError(
          'invoice_id does not reference an invoice in this organization',
          [{ field: 'invoice_id', message: 'Invalid or cross-organization invoice' }],
        );
      }
      const [result] = await exec(
        'INSERT INTO factura_publica_invoice_items (factura_publica_invoice_id, invoice_id) VALUES (?, ?)',
        [factura.id, invoice.id],
      );
      [[row]] = await exec('SELECT * FROM factura_publica_invoice_items WHERE id = ?', [result.insertId]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

// Build and stamp the factura global from the linked paid invoices (BIL-24).
router.post('/:id/stamp', requirePermission('cfdi_documents.create'), async (req, res, next) => {
  try {
    const result = await facturaPublicaService.stampGlobal(req.params.id, req.orgId, { userId: req.user?.id ?? null });
    res.status(result.stamped ? 201 : 202).json({ data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
