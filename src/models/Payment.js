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
      // Set server-side only: POST /payments stamps the caller, and updates drop it.
      'recorded_by',
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

  // No allocate() here: an allocation runs inside the caller's transaction,
  // after the payment and its invoices are locked (POST /payments/:id/allocate,
  // DAL-04). An autocommit INSERT relying on the triggers raced.
}

module.exports = Payment;
