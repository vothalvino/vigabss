// =============================================================================
// VigaBSS 5.0 — Contract Model
// =============================================================================

const BaseModel = require('./BaseModel');

class Contract extends BaseModel {
  static get tableName() { return 'contracts'; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'plan_id', 'contract_template_mx_id',
      'mx_contract_environment',
      'connection_type', 'start_date', 'end_date', 'billing_day',
      'price_override', 'ip_address', 'status', 'facturar', 'notes',
      'escalation_enabled', 'escalate_on_disconnect',
      'optical_min_dbm', 'wireless_signal_min_dbm', 'wireless_link_capacity_min_mbps',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  /**
   * Get add-ons for this contract, scoped to the caller's organization.
   * contract_addons has no organization_id column, so the tenant boundary is
   * the parent contract: the JOIN returns nothing for a contract outside
   * `organizationId` (null-safe `<=>` so single-tenant NULL-org rows still
   * resolve when the caller's org is NULL).
   *
   * @param {number|string} contractId
   * @param {number|null} organizationId
   */
  static async getAddons(contractId, organizationId) {
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT ca.*, pa.name AS addon_name, pa.addon_type
       FROM contract_addons ca
       JOIN contracts c ON c.id = ca.contract_id AND c.organization_id <=> ? AND c.deleted_at IS NULL
       JOIN plan_addons pa ON pa.id = ca.plan_addon_id
       WHERE ca.contract_id = ? AND ca.deleted_at IS NULL AND pa.deleted_at IS NULL
       ORDER BY ca.id`,
      [organizationId ?? null, contractId],
    );
    return rows;
  }
}

module.exports = Contract;
