// =============================================================================
// VigaBSS 5.0 — NetworkHealthSnapshot Model
// =============================================================================

const BaseModel = require('./BaseModel');

class NetworkHealthSnapshot extends BaseModel {
  static get tableName() { return 'network_health_snapshots'; }
  static get fillable() { return ['organization_id', 'snapshot_date', 'avg_latency_ms']; }
  static get hasOrgScope() { return true; }
}

module.exports = NetworkHealthSnapshot;
