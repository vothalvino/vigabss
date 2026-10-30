// =============================================================================
// VigaBSS 5.0 — Credit Note Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');
const { NotFoundError } = require('../utils/errors');

class CreditNote extends BaseModel {
  static get tableName() { return 'credit_notes'; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'invoice_id', 'payment_id',
      'credit_note_number', 'reason', 'subtotal', 'tax_amount',
      'total', 'currency', 'tax_rate', 'tax_rate_id', 'status', 'notes',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  // Scoped through the parent credit note's organization_id
  // (credit_note_items has no org column of its own).
  static async getItems(creditNoteId, orgId) {
    requireOrgId(orgId, 'CreditNote.getItems');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT cni.* FROM credit_note_items cni
         JOIN credit_notes cn ON cn.id = cni.credit_note_id
        WHERE cni.credit_note_id = ? AND cn.organization_id <=> ? AND cn.deleted_at IS NULL
          AND cni.deleted_at IS NULL
        ORDER BY cni.id`,
      [creditNoteId, orgId],
    );
    return rows;
  }

  /**
   * Insert a line on a credit note owned by `orgId`. The INSERT ... SELECT
   * only produces a row when the parent credit note belongs to the org, so a
   * foreign or missing parent inserts nothing and throws NotFoundError — the
   * write is scoped by construction, not only by the route's pre-check.
   * `exec` runs it on the caller's transaction connection.
   */
  static async addItem(data, orgId, exec = null) {
    requireOrgId(orgId, 'CreditNote.addItem');
    const db = require('../config/database');
    const run = exec || db.query.bind(db);
    // credit_note_items has NO writable `amount` column, and `total` is
    // `GENERATED ALWAYS AS (quantity * unit_price) STORED` (database/schema.sql)
    // — MySQL rejects any explicit value for a generated column
    // (ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN), so writing either one here
    // threw on every call. The API keeps accepting `amount` in the request body
    // for backward compatibility, but it is never persisted; `total` is always
    // computed by MySQL from quantity * unit_price and comes back on the SELECT
    // below.
    const [result] = await run(
      `INSERT INTO credit_note_items (credit_note_id, description, quantity, unit_price, tax_rate_id)
       SELECT cn.id, ?, ?, ?, ?
         FROM credit_notes cn
        WHERE cn.id = ? AND cn.organization_id <=> ? AND cn.deleted_at IS NULL`,
      [data.description, data.quantity, data.unit_price, data.tax_rate_id || null,
        data.credit_note_id, orgId],
    );
    if (!result || !result.affectedRows) throw new NotFoundError('Credit note');
    const [rows] = await run('SELECT * FROM credit_note_items WHERE id = ?', [result.insertId]);
    return rows[0];
  }
}

module.exports = CreditNote;
