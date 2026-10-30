// =============================================================================
// VigaBSS 5.0 — Purchase Order Model
// =============================================================================

const BaseModel = require('./BaseModel');
const db = require('../config/database');
const { requireOrgId } = require('../utils/requireOrgId');

class PurchaseOrder extends BaseModel {
  static get tableName() { return 'purchase_orders'; }

  static get fillable() {
    return [
      'organization_id', 'vendor_id', 'po_number', 'status',
      'order_date', 'expected_date', 'received_date', 'warehouse_id',
      'subtotal', 'tax_amount', 'total', 'currency', 'reference',
      'notes', 'created_by',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  /**
   * Get line items for a purchase order.
   */
  static async getItems(poId, orgId) {
    requireOrgId(orgId, 'PurchaseOrder.getItems');
    // purchase_order_items has no organization_id: scope through the parent
    // PO, and bind the item display join to the PO's org so a legacy foreign
    // inventory_item_id never surfaces another tenant's item name/SKU.
    const [rows] = await db.query(
      `SELECT poi.*, i.name AS item_name, i.sku, i.serial_required
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id AND po.organization_id <=> ?
       LEFT JOIN inventory_items i ON i.id = poi.inventory_item_id
         AND i.organization_id <=> po.organization_id
       WHERE poi.po_id = ?
       ORDER BY poi.id`,
      [orgId, poId],
    );
    return rows;
  }
}

module.exports = PurchaseOrder;
