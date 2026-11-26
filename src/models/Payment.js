// =============================================================================
// VigaBSS 5.0 — Payment Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');
const { ValidationError } = require('../utils/errors');

class Payment extends BaseModel {
  static get tableName() { return 'payments'; }

  static get businessDateColumns() { return ['payment_date']; }

  // The list's ?date_from=&date_to= range: the payment's date.
  static get dateFilter() { return { column: 'payment_date', kind: 'date' }; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'amount', 'currency',
      'payment_method', 'payment_date', 'reference_number', 'sat_forma_pago',
      'clabe', 'bank_name', 'bank_account_id', 'status', 'notes',
      // Set server-side only: POST /payments stamps the caller, and updates drop it.
      'recorded_by',
    ];
  }

  // reseller_id (migration 004) is set only by the reseller app's collection
  // (services/resellerCollectionService.js), so it is not fillable; staff
  // lists may filter on it.
  static get filterableColumns() { return ['reseller_id']; }

  /**
   * ?collected_by= on the list: who took the money.
   *   staff:<user id>     recorded by that staff member (not a point's login)
   *   reseller:<id>       collected by that reseller or collector
   *   system              recorded by no one: a gateway, an import, a task
   * Anything else is refused.
   */
  static applyListFilters(where, conditions, params) {
    super.applyListFilters(where, conditions, params);
    const by = where && where.collected_by;
    if (by === undefined || by === null || by === '') return;
    const match = typeof by === 'string' ? by.match(/^(staff|reseller):(\d{1,18})$/) : null;
    if (by === 'system') {
      conditions.push('`recorded_by` IS NULL AND `reseller_id` IS NULL');
    } else if (match && match[1] === 'staff') {
      conditions.push('`recorded_by` = ? AND `reseller_id` IS NULL');
      params.push(Number(match[2]));
    } else if (match) {
      conditions.push('`reseller_id` = ?');
      params.push(Number(match[2]));
    } else {
      throw new ValidationError("collected_by must be 'staff:<id>', 'reseller:<id>' or 'system'");
    }
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
