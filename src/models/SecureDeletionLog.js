// =============================================================================
// VigaBSS 5.0 — SecureDeletionLog Model
// =============================================================================

const BaseModel = require('./BaseModel');

class SecureDeletionLog extends BaseModel {
  static get tableName() { return 'secure_deletion_log'; }
  static get hasOrgScope() { return true; }
  static get fillable() {
    return ['organization_id', 'table_name', 'record_count', 'reason'];
  }
}

module.exports = SecureDeletionLog;
