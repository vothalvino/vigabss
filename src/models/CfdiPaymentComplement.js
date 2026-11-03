// =============================================================================
// VigaBSS 5.0 — CfdiPaymentComplement Model
// =============================================================================

const BaseModel = require('./BaseModel');

class CfdiPaymentComplement extends BaseModel {
  static get tableName() { return 'cfdi_payment_complements'; }
  static get fillable() { return ['cfdi_document_id', 'payment_date', 'forma_pago', 'moneda', 'tipo_cambio', 'amount']; }
  static get hasOrgScope() { return false; }
}

module.exports = CfdiPaymentComplement;
