// =============================================================================
// VigaBSS 5.0 — CfdiDocument Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');

class CfdiDocument extends BaseModel {
  static get tableName() { return 'cfdi_documents'; }

  // Caller-settable columns ONLY, aligned to the real cfdi_documents schema
  // (the old list carried ~10 phantom columns — emisor_*, fecha_emision,
  // lugar_expedicion, descuento, status… — and omitted the NOT NULL client_id,
  // so every generic POST /cfdi-documents INSERT failed). Emisor identity is
  // NOT stored per-document: it is joined from organization_mx_profiles at
  // XML-generation time. Lifecycle fields (uuid, sat_status, stamp_date,
  // certificate_number, sat_seal, signed_xml, cancellation_*) are deliberately
  // NOT fillable — they are set exclusively by cfdiService's stamp/cancel
  // flows, so SAT state can never be forged through the generic CRUD routes
  // (the #469 void↔cancel gating depends on that).
  static get fillable() {
    return [
      'organization_id', 'client_id', 'invoice_id', 'credit_note_id', 'payment_id',
      'tipo_comprobante', 'serie', 'folio', 'uso_cfdi',
      'metodo_pago', 'forma_pago', 'moneda', 'tipo_cambio', 'exportacion',
      'receptor_rfc', 'receptor_nombre', 'receptor_regimen', 'receptor_cp',
      'subtotal', 'total_impuestos', 'total',
      'xml_file_id', 'pdf_file_id',
    ];
  }

  static get hasOrgScope() { return true; }

  // sat_status is service-managed (never fillable) but IS a valid list filter —
  // the CFDI list page filters by it (draft/vigente/cancelado/cancel_pending).
  static get filterableColumns() { return ['sat_status']; }

  // Both children are scoped through the parent CFDI's organization_id
  // (neither child table has an org column of its own).
  static async getConceptos(cfdiId, orgId) {
    requireOrgId(orgId, 'CfdiDocument.getConceptos');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT cc.* FROM cfdi_conceptos cc
         JOIN cfdi_documents d ON d.id = cc.cfdi_document_id
        WHERE cc.cfdi_document_id = ? AND d.organization_id <=> ?
        ORDER BY cc.id`,
      [cfdiId, orgId],
    );
    return rows;
  }

  static async getRelatedDocuments(cfdiId, orgId) {
    requireOrgId(orgId, 'CfdiDocument.getRelatedDocuments');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT crd.* FROM cfdi_related_documents crd
         JOIN cfdi_documents d ON d.id = crd.cfdi_document_id
        WHERE crd.cfdi_document_id = ? AND d.organization_id <=> ?
        ORDER BY crd.id`,
      [cfdiId, orgId],
    );
    return rows;
  }
}

module.exports = CfdiDocument;
