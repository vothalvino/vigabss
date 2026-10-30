// =============================================================================
// VigaBSS 5.0 — Asset Model
// =============================================================================

const BaseModel = require('./BaseModel');
const db = require('../config/database');
const { requireOrgId } = require('../utils/requireOrgId');

class Asset extends BaseModel {
  static get tableName() { return 'assets'; }

  static get fillable() {
    return [
      'organization_id', 'asset_tag', 'barcode', 'name', 'category',
      'manufacturer', 'model', 'serial_number', 'inventory_item_id',
      'warehouse_id', 'vendor_id', 'purchase_order_id', 'lifecycle_status',
      'purchase_date', 'purchase_cost', 'warranty_expires_at', 'warranty_notes',
      'depreciation_method', 'useful_life_months', 'salvage_value',
      'disposed_at', 'disposal_reason', 'disposal_notes', 'notes',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  /**
   * Get assignment history for an asset.
   */
  static async getAssignments(assetId, orgId) {
    requireOrgId(orgId, 'Asset.getAssignments');
    // Display joins are bound to the assignment's org so a stray foreign
    // client/device id (written before ownership checks existed) can never
    // surface another tenant's name or email.
    const [rows] = await db.query(
      `SELECT aa.*,
              c.name AS client_name, c.email AS client_email,
              d.name AS device_name
       FROM asset_assignments aa
       LEFT JOIN clients c ON c.id = aa.client_id AND c.organization_id <=> aa.organization_id
       LEFT JOIN devices d ON d.id = aa.device_id AND d.organization_id <=> aa.organization_id
       WHERE aa.asset_id = ? AND aa.organization_id <=> ?
       ORDER BY aa.assigned_at DESC`,
      [assetId, orgId],
    );
    return rows;
  }

  /**
   * Get RMA requests for an asset.
   */
  static async getRmaRequests(assetId, orgId) {
    const [rows] = await db.query(
      `SELECT r.* FROM rma_requests r
       WHERE r.asset_id = ? AND r.organization_id = ? AND r.deleted_at IS NULL
       ORDER BY r.created_at DESC`,
      [assetId, orgId],
    );
    return rows;
  }
}

module.exports = Asset;
