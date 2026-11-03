// =============================================================================
// VigaBSS 5.0 — RevenueSummary Model
// =============================================================================

const BaseModel = require('./BaseModel');

class RevenueSummary extends BaseModel {
  static get tableName() { return 'revenue_summary'; }
  static get fillable() { return ['organization_id', 'period_date', 'total_collected', 'total_outstanding', 'currency']; }
  static get hasOrgScope() { return true; }
}

module.exports = RevenueSummary;
