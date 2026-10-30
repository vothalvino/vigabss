// =============================================================================
// VigaBSS 5.0 — Payment Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');

class Payment extends BaseModel {
  static get tableName() { return 'payments'; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'amount', 'currency',
      'payment_method', 'payment_date', 'reference_number', 'sat_forma_pago',
      'clabe', 'bank_name', 'status', 'notes',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  /**
   * Get payment allocations for this payment, scoped through the parent
   * payment's organization_id (payment_allocations has no org column).
   */
  static async getAllocations(paymentId, orgId) {
    requireOrgId(orgId, 'Payment.getAllocations');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT pa.* FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id
        WHERE pa.payment_id = ? AND p.organization_id <=> ? AND p.deleted_at IS NULL
          AND pa.deleted_at IS NULL`,
      [paymentId, orgId],
    );
    return rows;
  }

  /**
   * Allocate a payment amount to an invoice.
   * The DB trigger prevents over-allocation.
   */
  static async allocate(paymentId, invoiceId, amount) {
    const db = require('../config/database');
    const [result] = await db.query(
      'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)',
      [paymentId, invoiceId, amount],
    );
    const [rows] = await db.query('SELECT * FROM payment_allocations WHERE id = ?', [result.insertId]);
    return rows[0];
  }
}

module.exports = Payment;
