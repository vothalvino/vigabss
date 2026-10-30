// =============================================================================
// VigaBSS 5.0 — CpeProfile Model (§8.2)
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');
const { NotFoundError } = require('../utils/errors');

class CpeProfile extends BaseModel {
  static get tableName() { return 'cpe_profiles'; }

  static get fillable() {
    return [
      'organization_id', 'name', 'description', 'parent_profile_id',
      'plan_id', 'manufacturer', 'model_name', 'wifi_ssid_template',
      'wifi_security', 'wifi_channel', 'wifi_band', 'wan_mode',
      'wan_vlan_id', 'parameters', 'status',
    ];
  }

  static get hasOrgScope() { return true; }
  static get softDelete() { return true; }

  /**
   * A profile the organization may READ: its own, or a global
   * (organization_id IS NULL) profile shared by every tenant — the same
   * visibility GET /cpe-profiles lists. Writes keep using the strict
   * BaseModel org predicate, so global profiles stay read-only to tenants.
   */
  static async findVisibleById(id, orgId) {
    requireOrgId(orgId, 'CpeProfile.findVisibleById');
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT * FROM cpe_profiles
        WHERE id = ? AND (organization_id <=> ? OR organization_id IS NULL)
          AND deleted_at IS NULL`,
      [id, orgId],
    );
    return rows[0] || null;
  }

  static async findVisibleByIdOrFail(id, orgId) {
    const record = await this.findVisibleById(id, orgId);
    if (!record) throw new NotFoundError(this.tableName);
    return record;
  }
}

module.exports = CpeProfile;
