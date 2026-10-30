// =============================================================================
// VigaBSS 5.0 — Quote Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');

class Quote extends BaseModel {
  static get tableName() { return 'quotes'; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'contract_id', 'quote_number',
      'subtotal', 'tax_amount', 'total', 'currency', 'tax_rate',
      'tax_rate_id', 'valid_until', 'status', 'notes',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  // Scoped through the parent quote's organization_id (quote_items has no
  // org column of its own).
  static async getItems(quoteId, orgId) {
    requireOrgId(orgId, 'Quote.getItems');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT qi.* FROM quote_items qi
         JOIN quotes q ON q.id = qi.quote_id
        WHERE qi.quote_id = ? AND q.organization_id <=> ? AND q.deleted_at IS NULL
          AND qi.deleted_at IS NULL
        ORDER BY qi.id`,
      [quoteId, orgId],
    );
    return rows;
  }

  static async addItem(data, exec = null) {
    const db = require('../config/database');
    // Optional exec so the caller can run this on a transaction connection —
    // the header-totals delta must commit or roll back WITH the line.
    const run = exec || db.query.bind(db);
    // quote_items has NO writable `amount` column, and `total` is
    // `GENERATED ALWAYS AS (quantity * unit_price) STORED` (database/schema.sql)
    // — MySQL rejects any explicit value for a generated column
    // (ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN), so writing either one here
    // threw on every call. The API keeps accepting `amount` in the request body
    // for backward compatibility, but it is never persisted; `total` is always
    // computed by MySQL from quantity * unit_price and comes back on the SELECT
    // below.
    const [result] = await run(
      `INSERT INTO quote_items (quote_id, description, quantity, unit_price, tax_rate_id, inventory_item_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.quote_id, data.description, data.quantity, data.unit_price, data.tax_rate_id || null, data.inventory_item_id || null],
    );
    const [rows] = await run('SELECT * FROM quote_items WHERE id = ?', [result.insertId]);
    return rows[0];
  }
}

module.exports = Quote;
