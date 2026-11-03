// =============================================================================
// VigaBSS 5.0 — SnmpMetric Model
// =============================================================================

const BaseModel = require('./BaseModel');

class SnmpMetric extends BaseModel {
  static get tableName() { return 'snmp_metrics'; }
  static get fillable() { return ['device_id', 'polled_at']; }
  static get hasOrgScope() { return false; }
}

module.exports = SnmpMetric;
