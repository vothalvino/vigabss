// =============================================================================
// VigaBSS 5.0 — DdosProtectionRule Model
// =============================================================================

const BaseModel = require('./BaseModel');

class DdosProtectionRule extends BaseModel {
  static get tableName() { return 'ddos_protection_rules'; }
  static get hasOrgScope() { return true; }
  static get fillable() {
    return ['organization_id', 'name', 'rule_type', 'target_prefix', 'action', 'pps_threshold', 'bandwidth_threshold_mbps', 'status', 'triggered_at', 'expires_at', 'notes'];
  }
}

module.exports = DdosProtectionRule;
