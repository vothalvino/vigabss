// =============================================================================
// VigaBSS 5.0 — FacturaPublicaInvoice Model
// =============================================================================

const BaseModel = require('./BaseModel');

class FacturaPublicaInvoice extends BaseModel {
  static get tableName() { return 'factura_publica_invoices'; }
  static get fillable() { return ['organization_id', 'cfdi_document_id', 'periodicidad', 'meses', 'anio', 'status']; }
  static get hasOrgScope() { return true; }
}

module.exports = FacturaPublicaInvoice;
