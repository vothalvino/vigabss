// =============================================================================
// VigaBSS 5.0 — Numbering Management Routes (§16.4)
// Covers: phone_number_inventory, number_portability_records, numbering_blocks
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { assertOwnedReferences } = require('../utils/ownedReferences');
const { buildUpdate } = require('../utils/sqlBuild');
const {
  createPhoneNumber, updatePhoneNumber, createPortability, updatePortability,
  createNumberingBlock, updateNumberingBlock,
} = require('../middleware/schemas/numberingManagement');

// Columns a partial update may set. An omitted field is left alone; null clears
// a nullable column but is ignored for a NOT NULL one (TNB-31).
function partialUpdate(body, columns, notNull = []) {
  const changes = {};
  for (const [field, column] of Object.entries(columns)) {
    if (body[field] === undefined) continue;
    if (body[field] === null && notNull.includes(column)) continue;
    changes[column] = body[field];
  }
  return buildUpdate(changes, Object.values(columns));
}

// A number may only be assigned to this tenant's client, contract and block
// (TNB-28). numbering_blocks has no deleted_at, so it is checked here.
async function assertPhoneNumberRefs(body, orgId) {
  await assertOwnedReferences(body, orgId, { client_id: 'clients', contract_id: 'contracts' });
  if (body.block_id) {
    const [rows] = await db.query('SELECT id FROM numbering_blocks WHERE id = ? AND organization_id <=> ?', [body.block_id, orgId]);
    if (!rows.length) throw new ValidationError('block_id does not belong to this organization');
  }
}

const router = Router();

router.use(authenticate);
router.use(orgScope);

// =============================================================================
// Phone Numbers — /phone-numbers
// =============================================================================

router.get('/phone-numbers', requirePermission('phone_number_inventory.view'), async (req, res, next) => {
  try {
    const { status, number_type, client_id, page = 1, limit = 50 } = req.query;
    const conditions = ['organization_id = ?'];
    const params = [req.orgId];

    if (status) { conditions.push('status = ?'); params.push(status); }
    if (number_type) { conditions.push('number_type = ?'); params.push(number_type); }
    if (client_id) { conditions.push('client_id = ?'); params.push(client_id); }

    const where = conditions.join(' AND ');
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const safeOffset = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit);

    const [rows] = await db.query(
      `SELECT * FROM phone_number_inventory WHERE ${where} ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params,
    );
    const [countResult] = await db.query(
      `SELECT COUNT(*) AS total FROM phone_number_inventory WHERE ${where}`,
      params,
    );

    res.json({ data: rows, meta: { total: countResult[0].total, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    next(err);
  }
});

router.post('/phone-numbers', requirePermission('phone_number_inventory.manage'), validate(createPhoneNumber, { strip: true }), async (req, res, next) => {
  try {
    const { phone_number, number_type, lada, status, client_id, contract_id, block_id, notes } = req.body;
    await assertPhoneNumberRefs(req.body, req.orgId);

    const [result] = await db.query(
      `INSERT INTO phone_number_inventory (organization_id, phone_number, number_type, lada, status, client_id, contract_id, block_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, phone_number, number_type || null, lada || null, status || 'available', client_id || null, contract_id || null, block_id || null, notes || null],
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.get('/phone-numbers/:id', requirePermission('phone_number_inventory.view'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const [[row]] = await db.query(
      'SELECT * FROM phone_number_inventory WHERE id = ? AND organization_id = ?',
      [id, req.orgId],
    );

    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

router.put('/phone-numbers/:id', requirePermission('phone_number_inventory.manage'), validate(updatePhoneNumber, { strip: true }), async (req, res, next) => {
  try {
    const { id } = req.params;
    await assertPhoneNumberRefs(req.body, req.orgId);
    const { assignments, values } = partialUpdate(req.body, {
      phone_number: 'phone_number', number_type: 'number_type', lada: 'lada', status: 'status',
      client_id: 'client_id', contract_id: 'contract_id', block_id: 'block_id', notes: 'notes',
    }, ['phone_number', 'number_type', 'status']);
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';

    const [result] = await db.query(
      `UPDATE phone_number_inventory SET ${setClause} WHERE id = ? AND organization_id = ?`,
      [...values, id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Phone number');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/phone-numbers/:id', requirePermission('phone_number_inventory.manage'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      'UPDATE phone_number_inventory SET status = \'blocked\', updated_at = NOW() WHERE id = ? AND organization_id = ?',
      [id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Phone number');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// Number Portability — /portability
// =============================================================================

router.get('/portability', requirePermission('number_portability.view'), async (req, res, next) => {
  try {
    const { port_type, status, page = 1, limit = 50 } = req.query;
    const conditions = ['organization_id = ?'];
    const params = [req.orgId];

    if (port_type) { conditions.push('port_type = ?'); params.push(port_type); }
    if (status) { conditions.push('status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const safeOffset = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit);

    const [rows] = await db.query(
      `SELECT * FROM number_portability_records WHERE ${where} ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params,
    );
    const [countResult] = await db.query(
      `SELECT COUNT(*) AS total FROM number_portability_records WHERE ${where}`,
      params,
    );

    res.json({ data: rows, meta: { total: countResult[0].total, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    next(err);
  }
});

router.post('/portability', requirePermission('number_portability.manage'), validate(createPortability, { strip: true }), async (req, res, next) => {
  try {
    const { phone_number, port_type, donor_carrier, recipient_carrier, ifetel_reference, client_id, notes } = req.body;
    await assertOwnedReferences(req.body, req.orgId, { client_id: 'clients' });

    const [result] = await db.query(
      `INSERT INTO number_portability_records (organization_id, phone_number, port_type, donor_carrier, recipient_carrier, ifetel_reference, client_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, phone_number, port_type, donor_carrier || null, recipient_carrier || null, ifetel_reference || null, client_id || null, notes || null],
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.get('/portability/:id', requirePermission('number_portability.view'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const [[row]] = await db.query(
      'SELECT * FROM number_portability_records WHERE id = ? AND organization_id = ?',
      [id, req.orgId],
    );

    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

router.put('/portability/:id', requirePermission('number_portability.manage'), validate(updatePortability, { strip: true }), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { assignments, values } = partialUpdate(req.body, { status: 'status', notes: 'notes' }, ['status']);
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';

    const [result] = await db.query(
      `UPDATE number_portability_records SET ${setClause} WHERE id = ? AND organization_id = ?`,
      [...values, id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Portability record');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/portability/:id/complete', requirePermission('number_portability.manage'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      'UPDATE number_portability_records SET status = \'completed\', ported_at = NOW(), updated_at = NOW() WHERE id = ? AND organization_id = ?',
      [id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Portability record');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// Numbering Blocks — /numbering-blocks
// =============================================================================

router.get('/numbering-blocks', requirePermission('numbering_blocks.view'), async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const safeOffset = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit);

    const [rows] = await db.query(
      `SELECT * FROM numbering_blocks WHERE organization_id = ? ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [req.orgId],
    );
    const [countResult] = await db.query(
      'SELECT COUNT(*) AS total FROM numbering_blocks WHERE organization_id = ?',
      [req.orgId],
    );

    res.json({ data: rows, meta: { total: countResult[0].total, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
  } catch (err) {
    next(err);
  }
});

router.post('/numbering-blocks', requirePermission('numbering_blocks.manage'), validate(createNumberingBlock, { strip: true }), async (req, res, next) => {
  try {
    const { block_start, block_end, lada, status, notes } = req.body;

    // Columns are block_prefix / range_start / range_end (all NOT NULL); there is
    // no `lada`, `block_start`, `block_end` or `cnmc_reference` column — CNMC is
    // the Spanish regulator, Mexico's is the IFT (database/schema.sql).
    if (!lada || !block_start || !block_end) {
      throw new ValidationError('lada, block_start and block_end are required');
    }

    const [result] = await db.query(
      `INSERT INTO numbering_blocks (organization_id, block_prefix, range_start, range_end, status, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.orgId, lada, block_start, block_end, status || 'active', notes || null],
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

router.get('/numbering-blocks/:id', requirePermission('numbering_blocks.view'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const [[row]] = await db.query(
      'SELECT * FROM numbering_blocks WHERE id = ? AND organization_id = ?',
      [id, req.orgId],
    );

    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

router.put('/numbering-blocks/:id', requirePermission('numbering_blocks.manage'), validate(updateNumberingBlock, { strip: true }), async (req, res, next) => {
  try {
    const { id } = req.params;
    // See the POST handler: block_prefix / range_start / range_end are the real
    // columns and they are NOT NULL, so a partial update must not null them out.
    const { assignments, values } = partialUpdate(req.body, {
      lada: 'block_prefix', block_start: 'range_start', block_end: 'range_end', status: 'status', notes: 'notes',
    }, ['block_prefix', 'range_start', 'range_end', 'status']);
    const setClause = assignments ? `${assignments}, updated_at = NOW()` : 'updated_at = NOW()';

    const [result] = await db.query(
      `UPDATE numbering_blocks SET ${setClause} WHERE id = ? AND organization_id = ?`,
      [...values, id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Numbering block');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
