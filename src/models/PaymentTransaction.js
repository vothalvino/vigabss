// =============================================================================
// VigaBSS 5.0 — PaymentTransaction Model
// =============================================================================

const BaseModel = require('./BaseModel');

class PaymentTransaction extends BaseModel {
  static get tableName() { return 'payment_transactions'; }

  static get fillable() {
    // The payment_transactions columns (FE-19: provider_reference and the
    // request/response payload names never existed, and client_id was missing,
    // so a client_id filter was dropped and the list ignored it).
    return [
      'organization_id', 'payment_id', 'payment_gateway_id', 'client_id',
      'invoice_id', 'gateway_reference_id', 'gateway_status', 'amount',
      'currency', 'idempotency_key',
    ];
  }

  static get hasOrgScope() { return true; }
}

module.exports = PaymentTransaction;
